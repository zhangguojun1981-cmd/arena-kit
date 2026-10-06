"""Form-created, single-service Compose deployments. Never reverse-engineers foreign containers."""
import hashlib
import json
import math
import os
from pathlib import Path
import re
import time
import uuid

DEPLOY_ROOT = Path('/var/lib/vpsdeck-private/projects')
DEPLOY_ACTIONS = {'create-container', 'rebuild-container', 'restore-container', 'pull-image'}


def deploy_digest(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()


def image_reference(value):
    if not isinstance(value,str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}',value):
        raise ValueError('镜像引用无效，不能含空白、变量或命令语法')
    if '://' in value or '//' in value or ('@' in value and not re.fullmatch(r'.+@sha256:[a-f0-9]{64}',value)):
        raise ValueError('镜像不接受URL/账号密码，摘要引用需要sha256格式')
    return value


class Deployments:
    def __init__(self, root=DEPLOY_ROOT, runner=None):
        self.root=Path(root)
        self.run=runner or run

    def validate(self, value):
        spec=dict(value)
        if not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,47}',spec.get('name','')):
            raise ValueError('名称需要1至48个小写字母、数字、下划线或连字符')
        job_id(spec['id'])
        spec['image']=image_reference(spec['image'])
        try:
            spec['memory']=int(spec.get('memory',512))
            spec['cpus']=float(spec.get('cpus',1))
        except (TypeError,ValueError):
            raise ValueError('内存/CPU必须是合法数值')
        if not 128 <= spec['memory'] <= 32768 or not math.isfinite(spec['cpus']) or not .1 <= spec['cpus'] <= 16:
            raise ValueError('内存范围128–32768MiB，CPU范围0.1–16')
        if spec.get('bind','127.0.0.1') not in ('127.0.0.1','0.0.0.0'):
            raise ValueError('发布地址只允许127.0.0.1或0.0.0.0')
        if spec.get('publish'):
            for key in ('hostPort','containerPort'):
                spec[key]=int(spec[key])
                if not 1 <= spec[key] <= 65535:
                    raise ValueError('端口范围1–65535')
        if spec.get('restart','unless-stopped') not in ('no','unless-stopped','always','on-failure'):
            raise ValueError('不支持的重启策略')
        target=spec.get('volumePath','/data')
        if not re.fullmatch(r'/[A-Za-z0-9_./-]{1,180}',target) or '..' in Path(target).parts or target=='/':
            raise ValueError('命名卷挂载点必须是安全的容器内绝对路径')
        environment=spec.get('environment','')
        if not isinstance(environment,str) or len(environment.encode()) > 65536:
            raise ValueError('环境变量输入不能超过64KiB')
        rows=[line for line in environment.split('\n') if line.strip()]
        if len(rows)>100 or any(not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*=[^\x00\r\n]*',line) for line in rows):
            raise ValueError('环境变量每行KEY=VALUE，不支持换行值，最多100项')
        keys=[line.split('=',1)[0] for line in rows]
        if len(keys)!=len(set(keys)):
            raise ValueError('环境变量名称不能重复')
        command=spec.get('command','')
        if not isinstance(command,str) or len(command)>8192 or '\x00' in command or len(command.splitlines())>64:
            raise ValueError('启动参数每行一个，最多64项/8192字符，不经shell解释')
        return spec

    def pin(self, image):
        image_reference(image)
        try:
            ident=self.run(['docker','image','inspect','--format','{{.Id}}',image]).strip()
        except Exception:
            raise ValueError('镜像不在本机或Docker无权限；先确认Docker，再显式拉取镜像')
        if not re.fullmatch(r'sha256:[a-f0-9]{64}',ident):
            raise ValueError('镜像不在本机或ID不可确认；先单独拉取镜像')
        return ident

    def command(self, meta, filename='compose.json'):
        directory=self.root/meta['spec']['name']
        return ['docker','compose','--project-directory',str(directory),'-p','vpsdeck-'+meta['spec']['name'],'-f',str(directory/filename)]

    def config(self, spec, pin):
        reference=('vpsdeck-pinned/'+spec['name']+':'+pin.split(':',1)[1]) if pin.startswith('sha256:') else pin
        service=dict(image=reference,container_name=spec['name'],restart=spec.get('restart','unless-stopped'),
                     mem_limit=str(spec['memory'])+'m',cpus=spec['cpus'],pids_limit=256,pull_policy='never',
                     labels={'dev.vpsdeck.id':spec['id']})
        service['environment']={line.split('=',1)[0]:line.split('=',1)[1].replace('$','$$') for line in spec.get('environment','').split('\n') if line.strip()}
        if spec.get('command'):
            service['command']=spec['command'].splitlines()
        if spec.get('publish'):
            service['ports']=[dict(target=spec['containerPort'],published=str(spec['hostPort']),host_ip=spec.get('bind','127.0.0.1'),protocol='tcp')]
        result=dict(services={'app':service})
        if spec.get('volume'):
            service['volumes']=[dict(type='volume',source='data',target=spec.get('volumePath','/data'))]
            result['volumes']={'data':{'name':'vpsdeck-'+spec['id']}}
        return result

    def owned(self, value):
        name(value)
        private_dir(self.root.parent)
        private_dir(self.root)
        directory=self.root/value
        if not directory.is_dir() or directory.is_symlink():
            raise ValueError('没有该App托管项目；既有容器不会自动接管或反推Compose')
        private_dir(directory)
        for filename in ('metadata.json','compose.json','transaction.json','backups'):
            if (directory/filename).is_symlink():
                raise ValueError('拒绝符号链接配置')
        meta=json.loads((directory/'metadata.json').read_text())
        if meta['spec']['name']!=value:
            raise ValueError('托管项目身份不符')
        present=(directory/'compose.json').exists()
        current=deploy_digest(json.loads((directory/'compose.json').read_text())) if present else None
        if current!=meta['configHash']:
            journal=directory/'transaction.json'
            if journal.exists():
                transaction=json.loads(journal.read_text())
                candidates=[transaction.get('before'),transaction['after']]
                match=next((candidate for candidate in candidates if candidate and candidate['configHash']==current),None)
                if match is None and not present and transaction.get('before') is None:
                    match=transaction['after']
                if match is None:
                    raise ValueError('配置不是事务中的已知版本，禁止覆盖外部变化')
                meta=dict(match,phase='pending',journal=deploy_digest(transaction))
            elif meta['phase']=='draft' and not present:
                meta=dict(meta,phase='pending')
            else:
                raise ValueError('Compose文件被外部修改，拒绝覆盖。请在通用Compose/文件页核查')
        return meta

    def runtime(self, meta):
        template='{"id":{{json .Id}},"image":{{json .Image}},"running":{{json .State.Running}},"state":{{json .State.Status}},"health":{{with index .State "Health"}}{{json .Status}}{{else}}""{{end}},"labels":{{json .Config.Labels}}}'
        row=json.loads(self.run(['docker','inspect','--format',template,meta['spec']['name']]))
        if row['labels'].get('dev.vpsdeck.id')!=meta['spec']['id'] or row['labels'].get('com.docker.compose.project')!='vpsdeck-'+meta['spec']['name']:
            raise ValueError('同名容器不属于该托管项目；拒绝接管')
        row.pop('labels')
        return row

    def listing(self):
        if not self.root.exists():
            return []
        private_dir(self.root.parent)
        private_dir(self.root)
        rows=[]
        for directory in sorted(self.root.iterdir()):
            if not directory.is_dir() or not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,47}',directory.name):
                continue
            try:
                meta=self.owned(directory.name)
                item=dict(name=directory.name,image=meta['spec']['image'],phase=meta['phase'],revision=deploy_digest(meta),backups=[])
                try:
                    item['runtime']=self.runtime(meta)
                except Exception:
                    item['notice']='容器状态无法读取，请核查；不视为成功'
                for backup in (directory/'backups').glob('*.json'):
                    if not backup.is_symlink():
                        b=json.loads(backup.read_text())
                        item['backups'].append(dict(id=backup.stem,created=b['created'],image=b['meta']['spec']['image'],phase=b['meta']['phase']))
                rows.append(item)
            except Exception:
                rows.append(dict(name=directory.name,phase='blocked',notice='托管记录/配置发生外部变化或不可读，禁止覆盖'))
        return rows

    def prepare(self, spec):
        operation=spec['operation']
        if operation not in DEPLOY_ACTIONS:
            raise ValueError('未知部署操作')
        self.run(['docker','compose','version','--short'])
        if operation=='pull-image':
            image=image_reference(spec['image'])
            return None,dict(image=image),dict(revision=deploy_digest({'image':image}),services=[],warning='将从镜像仓库下载镜像（可能占用较多磁盘）；镜像代表将运行的代码，请确认来源。不会创建、重建或重启容器。')
        old=None
        if operation=='create-container':
            desired=self.validate(spec)
            existing=self.root/desired['name']
            if existing.exists():
                private_dir(existing)
                if any(existing.iterdir()):
                    raise ValueError('托管项目名已存在，不覆盖；失败项目请进入详情核查')
            if desired['name'] in self.run(['docker','ps','-a','--format','{{.Names}}']).splitlines():
                raise ValueError('容器名已存在，不覆盖或接管')
            if self.run(['docker','ps','-aq','--filter','label=com.docker.compose.project=vpsdeck-'+desired['name']]).strip():
                raise ValueError('同名Compose项目已存在，不接管')
            if desired.get('volume') and self.run(['docker','volume','ls','-q','--filter','name=^vpsdeck-'+desired['id']+'$']).strip():
                raise ValueError('目标命名卷已存在，拒绝隐式复用数据')
            pin=self.pin(desired['image'])
            config=self.config(desired,pin)
        else:
            old=self.owned(spec['name'])
            if spec.get('expected')!=deploy_digest(old):
                raise ValueError('托管项目已变化，请重新读取后预览')
            if old['phase']=='ready':
                runtime=self.runtime(old)
                if runtime['id']!=old.get('containerId') or runtime['image']!=old['pin']:
                    raise ValueError('容器被外部重建或镜像不符，禁止覆盖；请核查')
            if operation=='restore-container':
                ident=job_id(spec['backup'])
                backup=self.root/spec['name']/'backups'/(ident+'.json')
                if backup.is_symlink():
                    raise ValueError('拒绝符号链接备份')
                record=json.loads(backup.read_text())
                desired=self.validate(record['meta']['spec'])
                if desired['name']!=spec['name'] or desired['id']!=old['spec']['id']:
                    raise ValueError('配置备份不属于该项目')
                config=record['config']
                if config!=self.config(desired,config['services']['app']['image']):
                    raise ValueError('配置备份含非表单生成内容，拒绝恢复')
                pin=self.pin(config['services']['app']['image'])
            else:
                desired=self.validate(dict(old['spec'],image=spec['image']))
                pin=self.pin(desired['image'])
                config=self.config(desired,pin)
        fingerprint=dict(old=old and deploy_digest(old),desired=desired,config=config,pin=pin)
        plan=dict(revision=deploy_digest(fingerprint),services=[dict(name=desired['name'],image=desired['image'],privileged=False,mounts=int(bool(desired.get('volume'))),ports=int(bool(desired.get('publish'))))],
                  warning='将创建/重建App托管容器及Compose配置。默认仅回环发布端口；0.0.0.0对外监听，Docker端口发布可能绕过部分防火墙规则。重建会中断业务；保留命名卷并备份配置/保留旧镜像标签，但不备份或回滚卷中数据。恢复旧配置同样会重建，需先核对数据兼容性。不会接管既有非托管容器，不开放特权模式，不绑定宿主机目录。')
        plan['previousImageID']=old and old['pin']
        plan['newImageID']=pin
        plan['binding']=('%s:%s -> %s/TCP' % (desired.get('bind','127.0.0.1'),desired.get('hostPort'),desired.get('containerPort'))) if desired.get('publish') else '不发布宿主机端口'
        plan['volumePath']=desired.get('volumePath') if desired.get('volume') else '未创建命名卷'
        return old,dict(spec=desired,config=config,pin=pin),plan

    def plan(self,spec):
        return self.prepare(spec)[2]

    def execute(self,spec,progress):
        old,desired,_=self.prepare(spec)
        if spec['operation']=='pull-image':
            self.run(['docker','image','pull',desired['image']],timeout=6600)
            pin=self.pin(desired['image'])
            return [dict(service=desired['image'],state='pulled',health=pin)],'镜像已在本机核验；未应用或重启容器'
        value=desired['spec']
        private_dir(self.root.parent)
        private_dir(self.root)
        directory=self.root/value['name']
        if old is None:
            directory.mkdir(mode=0o700,exist_ok=True)
            private_dir(directory)
            if any(directory.iterdir()):
                raise ValueError('创建目录发生冲突，未覆盖')
        else:
            private_dir(directory)
        new=dict(spec=value,pin=desired['pin'],phase='pending',configHash=deploy_digest(desired['config']),containerId=old and old.get('containerId'))
        if old is None:
            atomic(directory/'metadata.json',dict(new,phase='draft'))
        reference=desired['config']['services']['app']['image']
        try:
            existing_pin=self.pin(reference)
        except ValueError:
            existing_pin=None
        if existing_pin is not None and existing_pin!=desired['pin']:
            raise ValueError('固定镜像别名指向其他镜像，拒绝覆盖')
        if existing_pin is None:
            self.run(['docker','image','tag',desired['pin'],reference])
        atomic(directory/'candidate.json',desired['config'])
        self.run(self.command(new,'candidate.json')+['config','--quiet'])
        if old is not None and (directory/'compose.json').exists():
            backups=directory/'backups'
            private_dir(backups)
            ident=uuid.uuid4().hex
            config=json.loads((directory/'compose.json').read_text())
            tag='vpsdeck-backup/'+value['name']+':'+ident
            self.run(['docker','image','tag',old['pin'],tag])
            config['services']['app']['image']=tag
            atomic(backups/(ident+'.json'),dict(meta=old,config=config,created=int(time.time())))
            progress('旧配置及本地镜像标签已保留：'+ident+'；不包含卷数据备份')
        # A failed apply remains pending; never claim it was rolled back.
        atomic(directory/'transaction.json',dict(before=old,after=new))
        atomic(directory/'metadata.json',new)
        atomic(directory/'compose.json',desired['config'])
        (directory/'candidate.json').unlink(missing_ok=True)
        progress('配置已记录，正在创建/重建容器；不删除命名卷')
        self.run(self.command(new)+['up','-d','--no-build','--pull','never'],timeout=6600)
        row=self.runtime(new)
        deadline=time.monotonic()+60
        while row['running'] and row['health']=='starting' and time.monotonic()<deadline:
            time.sleep(2)
            row=self.runtime(new)
        if not row['running'] or row['health'] not in ('','healthy') or row['image']!=new['pin']:
            raise ValueError('创建/重建命令返回，但运行/健康/镜像状态未通过核验；保留pending记录和配置备份，请先核查')
        new.update(phase='ready',containerId=row['id'])
        atomic(directory/'metadata.json',new)
        (directory/'transaction.json').unlink(missing_ok=True)
        return [dict(service=value['name'],state=row['state'],health=row['health'] or '镜像无健康检查')],'已核验容器运行、镜像ID及已有健康检查；不等于业务数据/公网访问验收通过'
