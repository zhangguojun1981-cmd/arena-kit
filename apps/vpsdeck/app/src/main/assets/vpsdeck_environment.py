"""Debian 12 native package planning. Imported from the stdin asset bundle."""
import hashlib
import json
from pathlib import Path
import re

COMPONENTS = {
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
        return rows

    def plan(self, spec):
        self.supported()
        key = spec['name']
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
        return rows, '已核验dpkg已配置状态和版本；不代表服务健康或公网可达。请到服务面板检查状态与日志。'
