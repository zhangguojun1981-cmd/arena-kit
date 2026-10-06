"""Private on-demand systemd jobs. No listening socket, no automatic replay."""
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time

ROOT = Path('/var/lib/vpsdeck-private/jobs')
ACTIONS = {'pull': ['pull'], 'up': ['up', '-d', '--no-build'], 'stop': ['stop']}


def require(value, message):
    if not value:
        raise ValueError(message)


def run(args, cwd=None, timeout=120):
    # Private temporary output avoids unbounded RAM and never returns resolved env to the app.
    with tempfile.TemporaryFile() as output:
        p = subprocess.run(args, cwd=cwd, stdout=output, stderr=subprocess.STDOUT, timeout=timeout, env=dict(os.environ, LC_ALL='C', LANG='C'))
        size = output.tell()
        require(size <= 4 * 1024 * 1024, '工具输出超过4MiB，请在高级诊断中核查')
        output.seek(0)
        text = output.read().decode('utf-8', 'replace')
    require(p.returncode == 0, '工具执行失败，退出码 %s；请在服务器核查（不回传可能含凭据的输出）' % p.returncode)
    return text


def name(value):
    require(isinstance(value, str) and re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,62}', value), '项目名无效')
    return value


def job_id(value):
    require(isinstance(value, str) and re.fullmatch(r'[0-9a-f]{32}', value), '任务ID无效')
    return value


def private_dir(path):
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    st = path.lstat()
    require(not path.is_symlink() and st.st_uid == os.geteuid() and st.st_mode & 0o077 == 0,
            '任务目录必须属于当前执行身份且仅所有者可访问')


def atomic(path, value):
    fd, tmp = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(value, f, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
        d = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(d)
        finally:
            os.close(d)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


class Engine:
    def __init__(self, root=ROOT, runner=run):
        self.root, self.run = Path(root), runner

    def projects(self):
        rows = json.loads(self.run(['docker', 'compose', 'ls', '--all', '--format', 'json']))
        result = []
        for row in rows:
            project = name(row['Name'])
            ids = self.run(['docker', 'ps', '-aq', '--filter', 'label=com.docker.compose.project=' + project]).split()
            require(ids, '项目容器已变化，请重新刷新')
            require(re.fullmatch(r'[a-f0-9]{12,64}', ids[0]), '容器ID格式不符')
            labels = json.loads(self.run(['docker', 'inspect', '--format', '{{json .Config.Labels}}', ids[0]]))
            directory = labels.get('com.docker.compose.project.working_dir', '')
            files = labels.get('com.docker.compose.project.config_files', '').split(',')
            result.append(dict(name=project, status=row.get('Status', ''), directory=directory, files=files))
        return result

    def command(self, spec):
        project = name(spec['name'])
        directory = spec['directory']
        require(isinstance(directory, str) and directory.startswith('/') and '\x00' not in directory, '项目必须有绝对工作目录')
        require(Path(directory).is_dir(), '原始项目目录不存在；请在服务器恢复目录后再管理')
        files = spec['files']
        require(isinstance(files, list) and 1 <= len(files) <= 8, '需要1至8个原始Compose配置文件')
        command = ['docker', 'compose', '--project-directory', directory, '-p', project]
        for file in files:
            require(isinstance(file, str) and file.startswith('/') and '\x00' not in file and Path(file).is_file(), 'Compose配置文件不存在')
            command += ['-f', file]
        return command

    def plan(self, spec):
        if spec.get('kind') == 'database':
            return Databases().plan(spec)
        if spec.get('kind') == 'environment':
            return Environment(self.run).plan(spec)
        require(spec.get('kind', 'compose') == 'compose', '不支持的资源类型')
        command = self.command(spec)
        config = json.loads(self.run(command + ['config', '--format', 'json']))
        services = config.get('services', {})
        require(services, '项目没有服务')
        # A pull/up plan must use existing images only, never run a Dockerfile build implicitly.
        summary = []
        for key, item in services.items():
            summary.append(dict(name=key, image=item.get('image', ''), build=bool(item.get('build')),
                                privileged=bool(item.get('privileged')), mounts=len(item.get('volumes', [])),
                                ports=len(item.get('ports', []))))
        revision = hashlib.sha256(json.dumps(config, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        return dict(revision=revision, services=summary,
                    warning='应用可能重建容器并中断业务；绑定挂载、特权模式与端口影响宿主机。不会删除卷，不会自动构建镜像。拉取与应用分开确认。')

    def states(self):
        if not self.root.exists():
            return []
        private_dir(self.root.parent)
        private_dir(self.root)
        rows = []
        for directory in sorted(self.root.iterdir(), key=lambda p: p.name):
            if not re.fullmatch(r'[0-9a-f]{32}', directory.name):
                continue
            try:
                private_dir(directory)
                row = json.loads((directory / 'state.json').read_text())
                if row['state'] in ('queued', 'running'):
                    try:
                        active = self.run(['systemctl', 'is-active', 'vpsdeck-' + directory.name + '.service']).strip()
                    except Exception:
                        active = 'unknown'
                    if active not in ('active', 'activating'):
                        row = dict(row, state='unknown', message='执行器不再活动或无法查询；结果未知。禁止自动重试，请核对资源。' + row.get('checkpoint',''))
                rows.append(row)
            except (OSError, ValueError, KeyError):
                rows.append(dict(id=directory.name, state='unknown', message='任务记录不可读，请人工核查'))
        return sorted(rows, key=lambda r: r.get('created', 0), reverse=True)[:100]

    @staticmethod
    def authorize():
        require(os.geteuid() == 0, '持久任务需要root或明确选择已有sudo -n授权')

    def submit(self, request, source):
        self.authorize()
        ident = job_id(request['id'])
        action = request['action']
        is_environment = request['project'].get('kind') == 'environment'
        is_database = request['project'].get('kind') == 'database'
        allowed = (action == 'install') if is_environment else ((action in DB_ACTIONS and action == request['project'].get('operation')) if is_database else action in ACTIONS)
        require(allowed, '不支持的动作')
        plan = self.plan(request['project'])
        require(plan['revision'] == request['revision'], '配置/环境已变化，请重新预览')
        if not is_environment and action in ('pull', 'up'):
            require(all(s['image'] for s in plan['services']), '存在仅build的服务；当前不支持隐式构建')
        private_dir(self.root.parent)
        private_dir(self.root)
        directory = self.root / ident
        # mkdir is the at-most-once claim; even a failed launch may not reuse an ID.
        directory.mkdir(mode=0o700)
        state = dict(id=ident, state='queued', created=int(time.time()), project=request['project']['name'], action=action,
                     message='已记录，正在提交独立systemd任务；断线后请刷新查询，不要重复提交')
        atomic(directory / 'request.json', request)
        atomic(directory / 'state.json', state)
        with open(directory / 'worker.py', 'x', opener=lambda p, f: os.open(p, f, 0o600)) as f:
            f.write(source)
            f.flush()
            os.fsync(f.fileno())
        try:
            self.run(['systemd-run', '--quiet', '--unit=vpsdeck-' + ident, '--service-type=exec',
                      '--property=RuntimeMaxSec=7200', '--property=UMask=0077',
                      sys.executable, str(directory / 'worker.py'), '--worker', ident], timeout=30)
        except Exception:
            # Launch response loss is NOT proof that the worker didn't start.
            raise ValueError('任务提交未确认。ID ' + ident + '；先刷新任务和资源，禁止自动重试')
        return state

    def work(self, ident):
        directory = self.root / job_id(ident)
        private_dir(self.root.parent)
        private_dir(self.root)
        private_dir(directory)
        with open(directory / 'claim', 'a') as claim:
            fcntl.flock(claim, fcntl.LOCK_EX | fcntl.LOCK_NB)
            state = json.loads((directory / 'state.json').read_text())
            require(state['state'] == 'queued', '任务已经执行过，禁止重放')
            state.update(state='running', message='等待同主机变更锁')
            atomic(directory / 'state.json', state)
            try:
                with open(self.root / '.mutation-lock', 'a') as lock:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    request = json.loads((directory / 'request.json').read_text())
                    plan = self.plan(request['project'])
                    require(plan['revision'] == request['revision'], '启动前配置已变化；未执行动作')
                    state.update(message='正在执行；手机断线不影响该进程')
                    atomic(directory / 'state.json', state)
                    if request['project'].get('kind') == 'database':
                        def progress(message):
                            state.update(message=message, checkpoint=message)
                            atomic(directory / 'state.json', state)
                        rows, message = Databases().execute(request['project'], progress)
                        state.update(state='succeeded', resources=rows, message=message)
                    elif request['project'].get('kind') == 'environment':
                        rows, message = Environment(self.run).execute(request['project'])
                        state.update(state='succeeded', resources=rows, message=message)
                    else:
                        command = self.command(request['project'])
                        action = request['action']
                        self.run(command + ACTIONS[action], timeout=6600)
                        text = self.run(command + ['ps', '--all', '--format', 'json']).strip()
                        status = json.loads(text) if text.startswith('[') else [json.loads(line) for line in text.splitlines() if line.strip()]
                        rows = [dict(service=r.get('Service', ''), state=r.get('State', ''), health=r.get('Health', '')) for r in status]
                        if action == 'up':
                            running = {r['service'] for r in rows if r['state'] == 'running' and r['health'] != 'unhealthy'}
                            require({s['name'] for s in plan['services']} <= running,
                                    '命令已返回，但并非全部服务处于running且无unhealthy状态；请核查（一次性任务需人工确认）')
                        if action == 'stop':
                            require(all(r['state'] not in ('running', 'restarting') for r in rows), '仍有容器运行；请核查')
                        state.update(state='succeeded', resources=rows,
                                     message='已核验容器状态；不等于业务健康检查通过' if action != 'pull' else '镜像拉取命令成功；未应用或重启容器')
            except Exception as e:
                state.update(state='needs_review', message=str(e)[:1200] + '。可能已有部分效果，不自动回滚或重试。' + state.get('checkpoint',''))
            finally:
                state['finished'] = int(time.time())
                atomic(directory / 'state.json', state)
                (directory / 'request.json').unlink(missing_ok=True)


def api(request, source):
    engine = Engine()
    op = request['op']
    if op == 'database':
        return dict(database=Databases().inventory(request['auth']), jobs=engine.states())
    if op == 'database-containers':
        try:
            text = engine.run(['docker','ps','--no-trunc','--format','{{json .}}'])
            containers = [dict(id=r['ID'], name=r['Names'], image=r['Image']) for r in (json.loads(line) for line in text.splitlines() if line.strip())]
            return dict(containers=containers)
        except Exception:
            return dict(containers=[], notice='Docker不可用或无权限；可使用原生数据库身份连接')
    if op == 'environments':
        return dict(environments=Environment(engine.run).list(), jobs=engine.states())
    if op == 'list':
        return dict(projects=engine.projects(), jobs=engine.states())
    if op == 'jobs':
        return dict(jobs=engine.states())
    if op == 'plan':
        return engine.plan(request['project'])
    if op == 'submit':
        return dict(job=engine.submit(request, source))
    raise ValueError('未知操作')


if __name__ == '__main__':
    os.umask(0o077)
    if len(sys.argv) == 3 and sys.argv[1] == '--worker':
        Engine().work(sys.argv[2])
    else:
        try:
            result = api(envelope, SOURCE)
            print(json.dumps(dict(ok=True, **result), ensure_ascii=False))
        except Exception as error:
            print(json.dumps(dict(ok=False, message=str(error)[:1500]), ensure_ascii=False))
            sys.exit(1)
