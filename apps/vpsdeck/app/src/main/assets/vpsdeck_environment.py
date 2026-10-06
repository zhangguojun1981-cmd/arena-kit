"""Debian 12 native package planning. Imported from the stdin asset bundle."""
import hashlib
import json
from pathlib import Path
import re

COMPONENTS = {
    'docker-prerequisites': ('Docker向导 1 · HTTPS与签名校验工具', ['ca-certificates','gnupg']),
    'docker': ('Docker向导 4 · Engine / Compose插件', ['docker-ce','docker-ce-cli','containerd.io','docker-buildx-plugin','docker-compose-plugin']),
    'nginx': ('Nginx 网站服务', ['nginx']),
    'php': ('PHP-FPM 运行时', ['php-fpm', 'php-cli']),
    'postgresql': ('PostgreSQL 数据库服务', ['postgresql', 'postgresql-client']),
    'mariadb': ('MariaDB 数据库服务', ['mariadb-server', 'mariadb-client']),
    'certbot': ('Certbot 证书工具', ['certbot']),
    'python': ('Python 3 适配器运行时', ['python3']),
}


class Environment:
    def __init__(self, runner, release='/etc/os-release'):
        self.run, self.release = runner, Path(release)

    def platform(self):
        data = {}
        for line in self.release.read_text().splitlines():
            if '=' in line and not line.startswith('#'):
                k, v = line.split('=', 1)
                data[k] = v.strip('"')
        return data

    def supported(self):
        data = self.platform()
        if data.get('ID') != 'debian' or data.get('VERSION_ID') != '12':
            raise ValueError('当前安装适配器仅验收Debian 12；其他发行版仅检测，不执行安装')

    def installed(self, package):
        try:
            text = self.run(['dpkg-query', '-W', '-f=${Status}\t${Version}', package]).strip()
            status, version = text.split('\t', 1)
            return version if status == 'install ok installed' else ''
        except Exception:
            return ''

    def candidate(self, package):
        try:
            text = self.run(['apt-cache', 'policy', package])
            found = re.search(r'^\s*Candidate:\s*(\S+)', text, re.M)
            return found.group(1) if found and found.group(1) != '(none)' else ''
        except Exception:
            return ''

    def list(self):
        platform = self.platform()
        supported = platform.get('ID') == 'debian' and platform.get('VERSION_ID') == '12'
        rows = []
        for key, (title, packages) in COMPONENTS.items():
            rows.append(dict(name=key, kind='environment', title=title, supported=supported,
                             platform=platform.get('PRETTY_NAME', 'unknown'),
                             packages=[dict(name=p, installed=self.installed(p), candidate=self.candidate(p)) for p in packages]))
        rows.append(dict(name='docker-repository',kind='environment',title='Docker向导 2 · 配置官方APT源',supported=supported,platform=platform.get('PRETTY_NAME','unknown'),packages=[]))
        return rows

    def plan(self, spec):
        self.supported()
        key = spec['name']
        if key == 'docker-repository':
            return docker_repository(self)
        if key == 'docker' and any(self.installed(p) for p in DOCKER_CONFLICTS):
            raise ValueError('已有冲突Docker运行时；拒绝自动卸载迁移或混装')
        if key not in COMPONENTS and key != 'apt-index':
            raise ValueError('组件不在允许列表中')
        if key == 'apt-index':
            return dict(revision=hashlib.sha256(b'debian12-apt-index-v1').hexdigest(), services=[],
                        warning='只刷新现有APT仓库索引，访问服务器已配置的仓库；不新增源、不安装软件、不升级软件包。仓库错误会返回需核查。')
        packages = COMPONENTS[key][1]
        missing = [p for p in packages if not self.candidate(p)]
        if missing:
            raise ValueError('现有APT索引无候选版本：' + ', '.join(missing) + '；可先明确刷新仓库索引，不会自动添加第三方源')
        text = self.run(['apt-get', '-s', '--no-remove', '--no-install-recommends', 'install'] + packages)
        if re.search(r'^Remv ', text, re.M):
            raise ValueError('计划包含卸载，已拒绝；请人工处理依赖冲突')
        changes = []
        for line in text.splitlines():
            if line.startswith('Inst '):
                match = re.match(r'Inst (\S+)(?: \[[^\]]+\])? \((\S+)', line)
                if not match:
                    raise ValueError('APT模拟输出格式未知，拒绝安装')
                changes.append(dict(name=match.group(1), image=match.group(2)))
        # Capture installed and candidate versions as well as simulated dependency changes.
        fingerprint = dict(packages=[dict(name=p, installed=self.installed(p), candidate=self.candidate(p)) for p in packages], changes=changes)
        return dict(revision=hashlib.sha256(json.dumps(fingerprint, sort_keys=True).encode()).hexdigest(), services=changes,
                    warning='将安装/升级这些组件及模拟列出的依赖。发行版安装脚本可能自动启动服务、设置开机自启、监听端口；请先确认防火墙和维护窗口。保留已有配置（confold），不新增仓库、不自动修改防火墙、不卸载软件，不承诺自动回滚。')

    def execute(self, spec):
        self.supported()
        key = spec['name']
        if key == 'docker-repository':
            return docker_repository(self,execute=True)
        if key == 'docker' and any(self.installed(p) for p in DOCKER_CONFLICTS):
            raise ValueError('已有冲突Docker运行时；拒绝自动卸载迁移或混装')
        if key == 'apt-index':
            # APT can otherwise return zero for a partially failed repository update.
            self.run(['apt-get', '-o', 'APT::Update::Error-Mode=any', 'update'], timeout=600)
            return [], '现有APT仓库索引刷新成功；未安装软件'
        if key not in COMPONENTS:
            raise ValueError('组件不在允许列表中')
        packages = COMPONENTS[key][1]
        self.run(['env', 'DEBIAN_FRONTEND=noninteractive', 'NEEDRESTART_MODE=l',
                  'apt-get', '-y', '--no-remove', '--no-install-recommends',
                  '-o', 'Dpkg::Options::=--force-confold', 'install'] + packages, timeout=6600)
        rows = []
        for package in packages:
            version = self.installed(package)
            if not version:
                raise ValueError('安装后未核验到已配置的软件包：' + package)
            rows.append(dict(service=package, state='installed', health=version))
        if key == 'docker':
            rows.append(dict(service='Docker CLI',state='available',health=self.run(['docker','--version']).strip()))
            rows.append(dict(service='Compose plugin',state='available',health=self.run(['docker','compose','version','--short']).strip()))
        return rows, '已核验dpkg已配置状态和版本；不代表服务健康或公网可达。请到服务面板检查状态与日志。'

# Repository preparation is deliberately separate from index refresh and install.
DOCKER_KEY = '9DC858229FC7DD38854AE2D88D81803C0EBFCD88'
DOCKER_CONFLICTS = ('docker.io','docker-compose','docker-doc','docker-buildx','podman-docker','containerd','runc')


def docker_repository(environment, execute=False, apt_root='/etc/apt', fetch=None):
    import os
    import tempfile
    import urllib.request
    environment.supported()
    if any(environment.installed(p) for p in DOCKER_CONFLICTS):
        raise ValueError('检测到发行版Docker/冲突运行时；不自动卸载或混装。请先人工备份并处理迁移')
    if not all(environment.installed(p) for p in ('ca-certificates','gnupg')):
        raise ValueError('请先单独确认安装Docker安装前置组件')
    arch=environment.run(['dpkg','--print-architecture']).strip()
    if arch not in ('amd64','arm64'):
        raise ValueError('安装向导仅支持Debian12 amd64/arm64')
    root=Path(apt_root)
    key=root/'keyrings/vpsdeck-docker.asc'
    source=root/'sources.list.d/vpsdeck-docker.sources'
    content=('Types: deb\nURIs: https://download.docker.com/linux/debian\nSuites: bookworm\nComponents: stable\nArchitectures: '+arch+'\nSigned-By: '+str(key)+'\n').encode()
    files=list((root/'sources.list.d').glob('*.list'))+list((root/'sources.list.d').glob('*.sources'))+[root/'sources.list']
    for file in files:
        if file!=source and file.exists() and 'download.docker.com' in file.read_text():
            raise ValueError('已有其他Docker源配置；拒绝重复添加，请管理员核查。已有正确源可直接刷新索引和预览安装')
    if source.is_symlink() or key.is_symlink():
        raise ValueError('源或密钥路径为符号链接，拒绝改写')
    if source.exists() and source.read_bytes()!=content:
        raise ValueError('同名源文件已被修改；拒绝覆盖')
    fingerprint=hashlib.sha256(content+(key.read_bytes() if key.exists() else b'')).hexdigest()
    if not execute:
        return dict(revision=fingerprint,services=[],warning='仅配置Docker官方Debian12 stable APT源；下载并核对签名密钥指纹 '+DOCKER_KEY+'。不安装Docker、不刷新索引、不卸载原运行时。新增独立源文件，不覆盖其他源。后续需要分别确认索引刷新和安装。')
    if fetch is None:
        def fetch():
            with urllib.request.urlopen('https://download.docker.com/linux/debian/gpg',timeout=45) as response:
                return response.read(1024*1024+1)
    data=fetch()
    if len(data)>1024*1024 or not data.startswith(b'-----BEGIN PGP PUBLIC KEY BLOCK-----'):
        raise ValueError('Docker公钥格式或大小异常')
    with tempfile.TemporaryDirectory() as directory:
        temp=Path(directory)/'key.asc';temp.write_bytes(data)
        output=environment.run(['gpg','--batch','--homedir',directory,'--with-colons','--show-keys',str(temp)])
        lines=[line.split(':') for line in output.splitlines()]
        primary=[r for r in lines if r[0]=='pub']
        fingerprints=[r[9] for r in lines if r[0]=='fpr' and len(r)>9]
        if len(primary)!=1 or not fingerprints or fingerprints[0]!=DOCKER_KEY or primary[0][1] in ('r','e','d'):
            raise ValueError('Docker签名公钥指纹不匹配/失效；未写入APT源')
    for path,value in ((key,data),(source,content)):
        if path.parent.is_symlink(): raise ValueError('APT目录为符号链接，拒绝写入')
        try:
            path.parent.mkdir(parents=True,mode=0o755)
            path.parent.chmod(0o755)  # Only newly created directories, despite worker umask 077.
        except FileExistsError:
            pass
        if path.parent.stat().st_mode & 0o005 != 0o005:
            raise ValueError('已有APT目录不允许仓库沙箱读取；不自动修改已有权限')
        if path.exists():
            if path.read_bytes()!=value: raise ValueError('已有文件不匹配；拒绝覆盖')
            if path.stat().st_mode & 0o444 != 0o444: raise ValueError('已有APT文件不可公开读取；不自动修改权限')
        else:
            fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o644)
            with os.fdopen(fd,'wb') as file:
                file.write(value);file.flush();os.fchmod(file.fileno(),0o644);os.fsync(file.fileno())
        if path.read_bytes()!=value: raise ValueError('源文件读回验证失败')
    return [dict(service='Docker official repository',state='configured',health='fingerprint verified')], '官方源已写入并读回核验；请分别预览刷新APT索引，再预览Docker/Compose安装。尚未安装Docker。'
