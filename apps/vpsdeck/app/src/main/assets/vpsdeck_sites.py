#!/usr/bin/env python3
"""Versioned, SSH-invoked website adapter. No daemon or public API. Never adopts arbitrary configs."""
import base64
import fcntl
import hashlib
import http.client
import json
import os
import pathlib
import re
import stat
import subprocess
import sys
import time
import uuid


def encoded(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(',', ':')).encode()


def revision(value):
    return hashlib.sha256(encoded(value)).hexdigest()


def safe_path(value):
    if not isinstance(value, str) or not re.fullmatch(r'/[A-Za-z0-9_./ -]{1,240}', value):
        raise ValueError('路径只支持绝对路径、字母数字及 / _ . 空格和连字符')
    p = pathlib.Path(value)
    if '..' in p.parts or str(p) != value or value == '/':
        raise ValueError('路径不能包含上级跳转或重复分隔符')
    return value


def no_links(path):
    for p in [path, *path.parents]:
        if p.is_symlink():
            raise ValueError('拒绝写入符号链接路径：' + str(p))


def validate(value):
    s = dict(value)
    if not re.fullmatch(r'[a-f0-9]{32}', s.get('id', '')):
        raise ValueError('站点身份无效')
    domain = s.get('domain', '').lower().strip()
    if len(domain) > 253 or not all(re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', x) for x in domain.split('.')):
        raise ValueError('域名无效，请使用ASCII域名，不支持通配符')
    s['domain'] = domain
    if s.get('kind') not in ('static', 'proxy', 'php'):
        raise ValueError('不支持的站点类型')
    s['port'] = int(s.get('port', 80))
    if not 1 <= s['port'] <= 65535:
        raise ValueError('监听端口必须在1–65535之间')
    s['enabled'] = bool(s.get('enabled', True))
    s['tls'] = bool(s.get('tls', False))
    s['root'] = safe_path(s.get('root', ''))
    if s['root'] == '/var/www' or not s['root'].startswith('/var/www/'):
        raise ValueError('表单管理的站点目录限定在 /var/www/ 下；其他路径请使用高级配置')
    if s['kind'] == 'proxy':
        # Origin only: no credentials, variables, fragments or arbitrary Nginx directives.
        from urllib.parse import urlsplit
        if not re.fullmatch(r'https?://(?:\[[a-fA-F0-9:]+\]|[A-Za-z0-9.-]+)(?::[0-9]{1,5})?/?', s.get('upstream', '')):
            raise ValueError('反代地址不能包含控制字符或配置语法')
        u = urlsplit(s.get('upstream', ''))
        if u.scheme not in ('http', 'https') or not u.hostname or u.username or u.password or u.path not in ('', '/') or u.query or u.fragment:
            raise ValueError('反代目标需为 http(s)://主机:端口，不含凭据或路径')
        if not re.fullmatch(r'[A-Za-z0-9.:-]+', u.hostname) or (u.port is not None and not 1 <= u.port <= 65535):
            raise ValueError('反代地址无效')
        s['upstream'] = s['upstream'].rstrip('/')
    if s['kind'] == 'php':
        if not re.fullmatch(r'/run/php/[A-Za-z0-9_.-]+\.sock', s.get('phpSocket', '')):
            raise ValueError('请选择 /run/php/ 下的PHP-FPM套接字')
    if s['tls']:
        s['cert'] = safe_path(s.get('cert', ''))
        s['key'] = safe_path(s.get('key', ''))
        if s['port'] == 80:
            raise ValueError('HTTPS请明确使用443或其他TLS端口，不能沿用HTTP的80端口')
    return {k: s.get(k, '') for k in ('id', 'domain', 'kind', 'port', 'root', 'upstream', 'phpSocket', 'enabled', 'tls', 'cert', 'key')}


def render(value):
    s = validate(value)
    lines = ['# VPS Deck managed; edit through the app to retain revision protection', 'server {',
             '    listen %d%s;' % (s['port'], ' ssl' if s['tls'] else ''),
             '    server_name %s;' % s['domain'], '    root "%s";' % s['root'],
             '    index index.php index.html;',
             '    location ^~ /.well-known/acme-challenge/ { root /var/lib/vpsdeck/acme; }']
    if s['tls']:
        lines += ['    ssl_certificate "%s";' % s['cert'], '    ssl_certificate_key "%s";' % s['key'],
                  '    ssl_protocols TLSv1.2 TLSv1.3;']
    if s['kind'] == 'proxy':
        lines += ['    location / {', '        proxy_pass %s;' % s['upstream'],
                  '        proxy_set_header Host $host;', '        proxy_set_header X-Real-IP $remote_addr;',
                  '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
                  '        proxy_set_header X-Forwarded-Proto $scheme;', '    }']
    else:
        lines += ['    location / { try_files $uri $uri/ =404; }']
        if s['kind'] == 'php':
            lines += ['    location ~ \\.php$ {', '        try_files $uri =404;', '        include /etc/nginx/fastcgi_params;',
                      '        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;',
                      '        fastcgi_pass unix:%s;' % s['phpSocket'], '    }']
        else:
            # Never accidentally serve PHP source from a static website.
            lines += ['    location ~ \\.php$ { return 404; }']
    lines += ['    location ~ /\\.(?!well-known) { deny all; }', '}', '']
    if s['tls']:
        suffix = '' if s['port'] == 443 else ':' + str(s['port'])
        lines += ['server {', '    listen 80;', '    server_name %s;' % s['domain'],
                  '    location ^~ /.well-known/acme-challenge/ { root /var/lib/vpsdeck/acme; }',
                  '    location / { return 301 https://$host%s$request_uri; }' % suffix, '}', '']
    return '\n'.join(lines).encode()


class Engine:
    def __init__(self, base='/etc/vpsdeck/sites', conf='/etc/nginx/conf.d', runner=None):
        self.base, self.conf = pathlib.Path(base), pathlib.Path(conf)
        self.runner = runner or self.run

    @staticmethod
    def run(args):
        p = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=120)
        return p.returncode, p.stdout.decode(errors='replace')[-6000:]

    def check(self, args):
        code, text = self.runner(args)
        if code != 0 or 'conflicting server name' in text.lower():
            raise RuntimeError('命令检查失败：' + ' '.join(args[:3]) + '\n' + text)
        return text

    def metadata(self, id):
        if not re.fullmatch(r'[a-f0-9]{32}', id):
            raise ValueError('站点ID无效')
        return self.base / (id + '.json')

    def target(self, id):
        self.metadata(id)
        return self.conf / ('vpsdeck-' + id + '.conf')

    def read(self, id):
        p = self.metadata(id)
        no_links(p)
        if not p.exists():
            return None
        value = validate(json.loads(p.read_text()))
        if value['id'] != id:
            raise ValueError('网站元数据身份不匹配，拒绝继续')
        return value

    @staticmethod
    def atomic(path, data, mode=0o600):
        no_links(path)
        temp = path.parent / ('.vpsdeck-' + uuid.uuid4().hex + '.tmp')
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
        try:
            with os.fdopen(fd, 'wb') as f:
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
            os.replace(temp, path)
            d = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(d)
            finally:
                os.close(d)
        finally:
            if temp.exists():
                temp.unlink()

    def matches(self, spec, id):
        path = self.target(id)
        no_links(path)
        if spec is None or not spec['enabled']:
            return not path.exists()
        return path.exists() and path.read_bytes() == render(spec)

    def install(self, id, spec):
        path = self.target(id)
        no_links(path)
        if spec and spec['enabled']:
            self.atomic(path, render(spec), 0o644)
        elif path.exists():
            path.unlink()

    def store(self, id, spec):
        p = self.metadata(id)
        if spec is None:
            if p.exists():
                p.unlink()
        else:
            self.atomic(p, encoded(spec))

    def list(self):
        rows = []
        no_links(self.base)
        if self.base.exists():
            for p in sorted(self.base.glob('*.json')):
                if not re.fullmatch(r'[a-f0-9]{32}\.json', p.name):
                    continue
                s = self.read(p.stem)
                rows.append(dict(spec=s, revision=revision(s), drift=not self.matches(s, p.stem), pending=(self.base / ('pending-' + p.stem)).exists()))
            # An interrupted first creation might not yet have metadata.
            known = {r['spec']['id'] for r in rows}
            for p in self.base.glob('pending-*'):
                no_links(p)
                entry = json.loads(p.read_text())
                if entry['id'] not in known:
                    s = entry['new'] or entry['old']
                    rows.append(dict(spec=s, revision='', drift=True, pending=True))
        unmanaged = []
        for folder in (self.conf, pathlib.Path('/etc/nginx/sites-enabled')):
            if folder.exists():
                for p in sorted(folder.iterdir()):
                    if p.name.startswith('.'):
                        continue
                    if folder == self.conf and p.suffix != '.conf':
                        continue
                    if any(self.target(r['spec']['id']) == p for r in rows):
                        continue
                    unmanaged.append(str(p))
        sockets = [str(p) for p in pathlib.Path('/run/php').glob('*.sock') if p.is_socket()]
        return dict(sites=rows, unmanaged=unmanaged, phpSockets=sockets)

    def lock(self):
        no_links(self.base)
        self.base.mkdir(parents=True, exist_ok=True, mode=0o700)
        if self.base.stat().st_uid != os.geteuid() or self.base.stat().st_mode & 0o077:
            raise ValueError('管理目录权限必须为当前用户所有的0700，拒绝沿用不安全目录')
        p = self.base / '.lock'
        no_links(p)
        f = open(p, 'a')
        os.chmod(p, 0o600)
        try:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except Exception:
            f.close()
            raise ValueError('有其他网站变更正在执行，请稍后刷新')
        return f

    def prepare_root(self, spec, create):
        if spec['kind'] != 'proxy':
            p = pathlib.Path(spec['root'])
            no_links(p)
            if not p.exists():
                if not create:
                    raise ValueError('站点目录不存在，请确认允许创建目录')
                p.mkdir(parents=True, mode=0o755)
                # No welcome-file overwrites and no changes to pre-existing directory permissions.
                with open(p / 'index.html', 'x') as f:
                    f.write('<!doctype html><meta charset="utf-8"><title>VPS Deck</title><h1>Website ready</h1>')
            if not p.is_dir():
                raise ValueError('站点根目录不是目录')
        if spec['kind'] == 'php' and not pathlib.Path(spec['phpSocket']).is_socket():
            raise ValueError('PHP-FPM套接字不可用；不会自动安装或启动PHP')
        if spec['tls']:
            # Read only existence; never return or transmit certificate private-key contents.
            if not pathlib.Path(spec['cert']).is_file() or not pathlib.Path(spec['key']).is_file():
                raise ValueError('服务器证书或私钥文件不存在')
            self.check(['openssl', 'x509', '-in', spec['cert'], '-noout', '-checkend', '0'])
            match = self.check(['openssl', 'x509', '-in', spec['cert'], '-noout', '-checkhost', spec['domain']])
            if 'does match certificate' not in match or 'does NOT match' in match:
                raise ValueError('证书与网站域名不匹配')

    def apply(self, request):
        s = validate(request['spec'])
        id = s['id']
        old = self.read(id)
        if (revision(old) if old else '') != request.get('expected', ''):
            raise ValueError('网站资料已变化，未提交变更，请重新读取')
        marker = self.base / ('pending-' + id)
        if marker.exists():
            raise ValueError('该网站有未完成事务，请先执行恢复')
        if not self.matches(old, id):
            raise ValueError('配置被外部修改，拒绝覆盖；请通过文件管理检查')
        if not self.conf.is_dir():
            raise ValueError('Nginx conf.d不存在，请先配置原生Nginx环境')
        no_links(self.conf)
        self.check(['nginx', '-t'])
        self.prepare_root(s, bool(request.get('createRoot', False)))
        for row in self.list()['sites']:
            other = row['spec']
            if other['id'] != id and other['enabled'] and s['enabled'] and other['domain'] == s['domain'] and ({other['port'], 80} if other['tls'] else {other['port']}) & ({s['port'], 80} if s['tls'] else {s['port']}):
                raise ValueError('同域名与端口已有启用的管理站点')
        journal = dict(id=id, old=old, new=s, time=int(time.time()))
        backup = self.base / (id + '-' + uuid.uuid4().hex + '.backup')
        self.atomic(backup, encoded(journal))
        self.atomic(marker, encoded(journal))
        try:
            if not self.matches(old, id):
                raise ValueError('配置在提交前发生变化，拒绝覆盖')
            self.install(id, s)
            self.check(['nginx', '-t'])
            self.check(['systemctl', 'reload', 'nginx'])
            self.store(id, s)
            marker.unlink()
        except Exception as error:
            # Do not overwrite external edits made while our operation was running.
            try:
                if not self.matches(s, id) and not self.matches(old, id):
                    raise RuntimeError('出现外部修改，停止自动恢复')
                self.install(id, old)
                self.check(['nginx', '-t'])
                self.check(['systemctl', 'reload', 'nginx'])
                self.store(id, old)
                marker.unlink()
            except Exception as rollback:
                raise RuntimeError(str(error) + '\n恢复未完成，事务记录保留，请核查：' + str(rollback))
            raise RuntimeError(str(error) + '\n已恢复原配置；新建目录可能保留，未删除任何站点数据。')
        return dict(message='已校验、重载并保存网站配置', revision=revision(s), backup=backup.name)

    def recover(self, id):
        self.metadata(id)
        marker = self.base / ('pending-' + id)
        no_links(marker)
        j = json.loads(marker.read_text())
        if not self.matches(j['new'], id) and not self.matches(j['old'], id):
            raise ValueError('检测到外部配置修改，拒绝自动恢复')
        self.install(id, j['old'])
        self.check(['nginx', '-t'])
        self.check(['systemctl', 'reload', 'nginx'])
        self.store(id, j['old'])
        marker.unlink()
        return dict(message='已恢复上次操作前配置，未删除站点目录')

    def issue(self, request):
        import shutil
        import socket
        id = request['id']
        s = self.read(id)
        if not s or not s['enabled'] or (not s['tls'] and s['port'] != 80):
            raise ValueError('签发需先启用HTTP80网站；已启用的托管HTTPS站点保留HTTP80验证入口')
        if request.get('agreeTerms') is not True:
            raise ValueError("必须明确同意Let's Encrypt服务条款")
        if not re.fullmatch(r'[A-Za-z0-9_.+%-]+@[A-Za-z0-9.-]+', request.get('email', '')):
            raise ValueError('请输入有效的证书联系邮箱')
        if not shutil.which('certbot'):
            raise ValueError('服务器未安装certbot；此操作不会自动安装软件')
        if '.' not in s['domain'] or re.fullmatch(r'[0-9.]+', s['domain']):
            raise ValueError('自动签发需要已归属你的公网域名，不能使用IP或单标签主机名')
        socket.getaddrinfo(s['domain'], 80)
        challenge = pathlib.Path('/var/lib/vpsdeck/acme/.well-known/acme-challenge')
        no_links(challenge)
        challenge.mkdir(parents=True, exist_ok=True, mode=0o755)
        self.check(['certbot', 'certonly', '--webroot', '-w', '/var/lib/vpsdeck/acme',
                    '--cert-name', 'vpsdeck-' + id, '-d', s['domain'], '--email', request['email'],
                    '--agree-tos', '--non-interactive', '--keep-until-expiring',
                    '--server', 'https://acme-v02.api.letsencrypt.org/directory'])
        info = self.certificate(id)
        return dict(message='证书处理完成，仍需预览并发布HTTPS配置', **info)

    def certificate(self, id):
        self.metadata(id)
        base = '/etc/letsencrypt/live/vpsdeck-' + id
        cert, key = base + '/fullchain.pem', base + '/privkey.pem'
        if not pathlib.Path(cert).is_file() or not pathlib.Path(key).is_file():
            raise ValueError('未发现该站点的App专用证书；若签发中断请先核查，不要反复申请')
        text = self.check(['openssl', 'x509', '-in', cert, '-noout', '-subject', '-issuer', '-dates'])
        return dict(cert=cert, key=key, info=text)

    def renewal(self, id):
        s = self.read(id)
        if not s or not s['enabled']:
            raise ValueError('网站必须保持启用以接受HTTP80续期验证')
        self.certificate(id)
        loaded = self.check(['systemctl', 'show', 'certbot.timer', '-p', 'LoadState', '--value']).strip()
        if loaded != 'loaded':
            raise ValueError('没有可用的系统certbot.timer；不自动创建或修改其他定时任务')
        self.check(['systemctl', 'enable', '--now', 'certbot.timer'])
        active = self.check(['systemctl', 'is-active', 'certbot.timer']).strip()
        enabled = self.check(['systemctl', 'is-enabled', 'certbot.timer']).strip()
        if active != 'active' or enabled != 'enabled':
            raise ValueError('续期timer状态未通过核验')
        return dict(message='系统已有certbot.timer已启用并验证；公网DNS及80端口须持续可用')

    def health(self, id):
        s = self.read(id)
        if not s or not s['enabled']:
            raise ValueError('站点未启用，无法进行访问检查')
        if s['tls']:
            import ssl
            import socket
            c = http.client.HTTPSConnection(s['domain'], s['port'], timeout=8, context=ssl.create_default_context())
            c._create_connection = lambda *args, **kwargs: socket.create_connection(('127.0.0.1', s['port']), timeout=8)
        else:
            c = http.client.HTTPConnection('127.0.0.1', s['port'], timeout=8)
        try:
            c.request('GET', '/', headers={'Host': s['domain']})
            response = c.getresponse()
            return dict(status=response.status, message='实际HTTP检查：%d（服务器本机访问，未跟随跳转；不代表公网可达）' % response.status)
        finally:
            c.close()

    def backups(self, id):
        self.metadata(id)
        return dict(backups=[p.name for p in sorted(self.base.glob(id + '-*.backup'), key=lambda p: p.stat().st_mtime, reverse=True)][:30])

    def restore(self, request):
        name = request['backup']
        id = request['id']
        self.metadata(id)
        if not re.fullmatch(id + r'-[a-f0-9]{32}\.backup', name):
            raise ValueError('备份身份无效')
        p = self.base / name
        no_links(p)
        j = json.loads(p.read_text())
        if not j['old']:
            raise ValueError('此备份是首次创建前的空状态；请改用停用站点，不自动删除目录')
        return self.apply(dict(spec=j['old'], expected=request['expected'], createRoot=False))


def main():
    request = json.loads(base64.b64decode(sys.argv[1], validate=True))
    e = Engine()
    op = request.get('op')
    if op == 'list':
        result = e.list()
    elif op == 'certificate':
        result = e.certificate(request['id'])
    elif op in ('issue', 'renewal'):
        with e.lock():
            result = e.issue(request) if op == 'issue' else e.renewal(request['id'])
    elif op == 'health':
        result = e.health(request['id'])
    elif op == 'preview':
        import difflib
        new = validate(request['spec'])
        old = e.read(new['id'])
        if (revision(old) if old else '') != request.get('expected', ''):
            raise ValueError('配置版本已变化，请重新读取')
        before = render(old).decode().splitlines(True) if old and old['enabled'] else []
        after = render(new).decode().splitlines(True) if new['enabled'] else []
        result = dict(diff=''.join(difflib.unified_diff(before, after, fromfile='当前配置', tofile='计划配置')))
    elif op == 'backups':
        result = e.backups(request['id'])
    elif op in ('apply', 'recover', 'restore'):
        with e.lock():
            result = e.apply(request) if op == 'apply' else e.recover(request['id']) if op == 'recover' else e.restore(request)
    else:
        raise ValueError('未知操作')
    print(json.dumps(dict(ok=True, **result), ensure_ascii=True))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps(dict(ok=False, message=str(error)), ensure_ascii=True))
        sys.exit(1)
