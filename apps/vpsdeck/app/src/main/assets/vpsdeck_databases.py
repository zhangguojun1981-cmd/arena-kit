"""Local/socket database administration; credentials are not command-line arguments."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import uuid

DB_BACKUPS = Path('/var/lib/vpsdeck-private/backups')
DB_ACTIONS = {'create-database', 'create-user', 'grant', 'revoke', 'password', 'backup', 'restore'}
DB_SYSTEM = {'postgres', 'template0', 'template1', 'mysql', 'sys', 'performance_schema', 'information_schema'}


def db_name(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_-]{0,62}', value):
        raise ValueError('数据库/账号名仅支持字母、数字、下划线和连字符，不能以数字开头，最多63字符')
    return value


def db_literal(value):
    if '\x00' in value:
        raise ValueError('不支持NUL字符')
    return "'" + value.replace("'", "''") + "'"


class Databases:
    def __init__(self, root=DB_BACKUPS):
        self.root = Path(root)

    def auth(self, value):
        result = dict(value)
        if result.get('engine') not in ('postgresql', 'mysql'):
            raise ValueError('请选择PostgreSQL或MySQL/MariaDB')
        db_name(result['user'])
        password = result.get('password', '')
        if not isinstance(password, str) or len(password) > 512 or '\x00' in password:
            raise ValueError('数据库管理员密码格式无效')
        container = result.get('container', '')
        if container and not re.fullmatch(r'[a-f0-9]{12,64}', container):
            raise ValueError('容器必须从资源发现中选择ID')
        return result

    def mysql_tool(self, auth, dump=False):
        import shutil
        candidates = ('mysqldump', 'mariadb-dump') if dump else ('mysql', 'mariadb')
        if auth.get('container'):
            script = 'if command -v '+candidates[0]+' >/dev/null 2>&1; then printf '+candidates[0]+'; elif command -v '+candidates[1]+' >/dev/null 2>&1; then printf '+candidates[1]+'; else exit 1; fi'
            result = subprocess.run(['docker','exec',auth['container'],'sh','-c',script],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30)
            selected = result.stdout.decode().strip()
            if result.returncode == 0 and selected in candidates:
                return selected
        else:
            for candidate in candidates:
                if shutil.which(candidate):
                    return candidate
        raise ValueError('未发现兼容的MySQL/MariaDB客户端；不会自动安装')

    def command(self, auth, tool, args):
        auth = self.auth(auth)
        if tool in ('mysql','mysqldump'):
            tool = self.mysql_tool(auth, tool=='mysqldump')
        variable = 'PGPASSWORD' if auth['engine'] == 'postgresql' else 'MYSQL_PWD'
        env = dict(os.environ, LC_ALL='C', LANG='C')
        # Never inherit an unrelated caller's database identity/password settings.
        for key in ('PGPASSWORD', 'PGSERVICE', 'PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'MYSQL_PWD'):
            env.pop(key, None)
        env[variable] = auth.get('password', '')
        prefix = []
        if auth.get('container'):
            prefix = ['docker', 'exec', '-i', '--env', variable]
            if auth['engine'] == 'postgresql' and auth.get('asPostgres'):
                prefix += ['--user', 'postgres']
            prefix += [auth['container']]
        elif auth['engine'] == 'postgresql' and auth.get('asPostgres'):
            prefix = ['runuser', '-u', 'postgres', '--']
        return prefix + [tool] + args, env

    def execute_tool(self, auth, tool, args, text=None, output=None, source=None, timeout=120):
        command, env = self.command(auth, tool, args)
        with tempfile.TemporaryFile() as errors, tempfile.TemporaryFile() as capture:
            result = subprocess.run(command, input=text.encode() if text is not None else None,
                                    stdin=source, stdout=output if output is not None else capture,
                                    stderr=errors, env=env, timeout=timeout)
            if result.returncode:
                raise ValueError('数据库工具失败，退出码%s。核对数据库身份、客户端工具和权限；不会把SSH身份当作数据库管理员，也不回传可能含凭据的诊断。' % result.returncode)
            if output is not None:
                return ''
            if capture.tell() > 4*1024*1024:
                raise ValueError('数据库响应过大，请缩小范围')
            capture.seek(0)
            return capture.read().decode('utf-8', 'replace').strip()

    def query(self, auth, sql, database=None):
        auth = self.auth(auth)
        if auth['engine'] == 'postgresql':
            args = ['-X', '-w', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-U', auth['user'], '-d', database or 'postgres']
            return self.execute_tool(auth, 'psql', args, 'SET standard_conforming_strings=on;\n' + sql + '\n')
        args = ['--protocol=socket', '--user='+auth['user'], '--batch', '--raw', '--skip-column-names']
        if database:
            args += ['--database='+database]
        return self.execute_tool(auth, 'mysql', args, "SET SESSION sql_mode='NO_BACKSLASH_ESCAPES';\n" + sql + '\n')

    def databases(self, auth):
        if auth['engine'] == 'postgresql':
            sql = "SELECT coalesce(json_agg(d),'[]'::json) FROM (SELECT datname AS name,pg_get_userbyid(datdba) AS owner,pg_database_size(datname) AS bytes FROM pg_database WHERE NOT datistemplate ORDER BY datname) d;"
        else:
            sql = "SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT('name',SCHEMA_NAME,'owner','','bytes',COALESCE((SELECT SUM(DATA_LENGTH+INDEX_LENGTH) FROM information_schema.TABLES t WHERE t.TABLE_SCHEMA=s.SCHEMA_NAME),0))),JSON_ARRAY()) FROM information_schema.SCHEMATA s;"
        rows = json.loads(self.query(auth, sql) or '[]')
        return [dict(row, protected=row['name'] in DB_SYSTEM) for row in rows]

    def roles(self, auth):
        if auth['engine'] == 'postgresql':
            sql = "SELECT coalesce(json_agg(r),'[]'::json) FROM (SELECT rolname AS name,rolcanlogin AS login,(rolsuper OR rolcreaterole OR rolcreatedb) AS admin FROM pg_roles ORDER BY rolname) r;"
        else:
            sql = "SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT('name',User,'host',Host,'login',true,'admin',(Super_priv='Y' OR Grant_priv='Y' OR Create_user_priv='Y'))),JSON_ARRAY()) FROM mysql.user;"
        rows = json.loads(self.query(auth, sql) or '[]')
        return [dict(row, managed=row['name'].startswith('app_') and row.get('host','localhost') == 'localhost' and not row.get('admin')) for row in rows]

    def backups(self, auth):
        if not self.root.exists():
            return []
        private_dir(self.root.parent)
        private_dir(self.root)
        rows = []
        for path in self.root.glob('*/metadata.json'):
            if not re.fullmatch(r'[a-f0-9]{32}', path.parent.name) or path.is_symlink() or path.parent.is_symlink():
                continue
            row = json.loads(path.read_text())
            if row['engine'] == auth['engine']:
                rows.append(row)
        return sorted(rows, key=lambda r: r['created'], reverse=True)

    def inventory(self, auth):
        auth = self.auth(auth)
        return dict(databases=self.databases(auth), roles=self.roles(auth), backups=self.backups(auth))

    def backup_record(self, auth, ident, database, allow_move=False):
        job_id(ident)
        private_dir(self.root.parent)
        private_dir(self.root)
        directory = self.root/ident
        if not directory.is_dir() or directory.is_symlink():
            raise ValueError('备份不存在或路径不安全')
        private_dir(directory)
        meta = directory/'metadata.json'
        data = directory/'data.dump'
        if meta.is_symlink() or data.is_symlink():
            raise ValueError('拒绝符号链接备份')
        row = json.loads(meta.read_text())
        if row['database'] != database or row['engine'] != auth['engine'] or (row.get('container','') != auth.get('container','') and not allow_move):
            raise ValueError('备份与目标数据库/引擎/容器不匹配，只支持相同引擎/数据库名；跨容器需要额外确认')
        digest = self.digest(data)
        if digest != row['sha256'] or data.stat().st_size != row['bytes']:
            raise ValueError('备份校验失败，禁止恢复')
        return row, data

    @staticmethod
    def digest(path):
        h = hashlib.sha256()
        with open(path,'rb') as file:
            while True:
                block = file.read(1024*1024)
                if not block:
                    break
                h.update(block)
        return h.hexdigest()

    def plan(self, spec):
        auth = self.auth(spec['auth'])
        operation = spec['operation']
        if operation not in DB_ACTIONS:
            raise ValueError('未知数据库操作')
        database = db_name(spec.get('database') or 'unused')
        role = db_name(spec.get('role') or 'unused')
        if operation in ('create-user', 'password', 'grant', 'revoke') and not role.startswith('app_'):
            raise ValueError('账号写操作限定显式app_账号；系统和已有其他账号只读，避免误改管理员')
        if operation in ('create-user', 'password'):
            password = spec.get('newPassword','')
            if not isinstance(password,str) or not 12 <= len(password) <= 256 or '\x00' in password:
                raise ValueError('新账号密码需要12至256字符，不能含NUL')
        if operation not in ('create-user', 'password') and database.lower() in DB_SYSTEM:
            raise ValueError('系统数据库受保护，不能通过该表单修改')
        rows = self.databases(auth)
        roles = self.roles(auth)
        names = {r['name'] for r in rows}
        role_names = {r['name'] for r in roles if r.get('host','localhost') == 'localhost'}
        if operation == 'create-database':
            if database in names:
                raise ValueError('数据库已存在，不覆盖')
            owner = db_name(spec.get('owner') or auth['user'])
            if auth['engine'] == 'postgresql' and owner not in role_names:
                raise ValueError('数据库所有者角色不存在')
        elif operation not in ('create-user','password') and database not in names:
            raise ValueError('目标数据库不存在；请重新发现资源')
        if operation == 'create-user' and role in role_names:
            raise ValueError('账号已存在，不覆盖密码')
        if operation in ('grant','revoke','password') and role not in role_names:
            raise ValueError('账号不存在，请重新发现资源')
        if operation in ('grant','revoke','password') and not any(r['name']==role and r.get('managed') for r in roles):
            raise ValueError('该账号具有管理员能力或不属于可管理范围，拒绝修改')
        backup = None
        if operation == 'restore':
            if spec.get('confirmRestoreTarget') is not True:
                raise ValueError('必须明确确认当前恢复目标及跨容器风险')
            backup, _ = self.backup_record(auth, spec['backup'], database, allow_move=True)
        # Do not include changing database size or passwords in the preview fingerprint.
        fingerprint = dict(operation=operation, database=database, role=role, names=sorted(names), roles=sorted(role_names),
                           owner=spec.get('owner'), backup=backup and backup['sha256'])
        return dict(revision=hashlib.sha256(json.dumps(fingerprint,sort_keys=True).encode()).hexdigest(), services=[],
                    warning='数据库身份与SSH身份独立。账号仅管理app_前缀；MySQL仅localhost账号。授权限目标库（PostgreSQL限public现有表/序列）；撤销直接授权不等于撤销PUBLIC/继承权限。逻辑备份不含角色/ACL。恢复前必做独立安全备份，需维护窗口，可能部分恢复且不自动回滚；恢复不保证清除额外对象。')

    def make_backup(self, auth, database, recovery_of=None):
        private_dir(self.root.parent)
        private_dir(self.root)
        ident = uuid.uuid4().hex
        directory = self.root/ident
        directory.mkdir(mode=0o700)
        partial = directory/'data.partial'
        with open(partial,'xb') as output:
            os.fchmod(output.fileno(),0o600)
            if auth['engine'] == 'postgresql':
                self.execute_tool(auth,'pg_dump',['--no-password','-U',auth['user'],'-d',database,'--format=custom','--no-owner','--no-acl'],output=output,timeout=6600)
            else:
                self.execute_tool(auth,'mysqldump',['--protocol=socket','--user='+auth['user'],'--single-transaction','--routines','--events','--triggers','--hex-blob','--databases',database],output=output,timeout=6600)
            output.flush()
            os.fsync(output.fileno())
        if partial.stat().st_size == 0:
            raise ValueError('备份为空；不进入恢复阶段')
        if auth['engine'] == 'postgresql':
            with open(partial,'rb') as source:
                self.execute_tool(auth,'pg_restore',['--list'],source=source)
        else:
            with open(partial,'rb') as source:
                source.seek(max(0,partial.stat().st_size-4096))
                if b'-- Dump completed on ' not in source.read():
                    raise ValueError('未发现完整逻辑备份结束标记；不进入恢复阶段')
        data = directory/'data.dump'
        partial.rename(data)
        row = dict(id=ident, database=database, engine=auth['engine'],container=auth.get('container',''),created=int(time.time()),
                   bytes=data.stat().st_size,sha256=self.digest(data),recoveryOf=recovery_of)
        atomic(directory/'metadata.json',row)
        return row

    def execute(self, spec, progress):
        auth = self.auth(spec['auth'])
        operation = spec['operation']
        if operation not in DB_ACTIONS:
            raise ValueError('未知数据库操作')
        database = db_name(spec.get('database') or 'unused')
        role = db_name(spec.get('role') or 'unused')
        pg = auth['engine'] == 'postgresql'
        identifier = lambda value: ('"'+db_name(value)+'"') if pg else ('`'+db_name(value)+'`')
        user = identifier(role) if pg else db_literal(role)+"@'localhost'"
        if operation == 'backup':
            row = self.make_backup(auth,database)
            return [dict(service=database,state='backup-verified',health=row['id'])], '逻辑备份完成，已核验格式/完整结束标记和SHA256；不含全实例账号/ACL，也不代替实际恢复演练'
        if operation == 'restore':
            if spec.get('confirmRestoreTarget') is not True:
                raise ValueError('恢复目标未经明确确认')
            row, data = self.backup_record(auth,spec['backup'],database,allow_move=True)
            safety = self.make_backup(auth,database,recovery_of=row['id'])
            progress('安全备份已完成：'+safety['id']+'；开始恢复，失败不自动回滚')
            # Recheck source after the safety backup; refuse changed input.
            _, data = self.backup_record(auth,spec['backup'],database,allow_move=True)
            with open(data,'rb') as source:
                if pg:
                    self.execute_tool(auth,'pg_restore',['--no-password','-U',auth['user'],'-d',database,'--clean','--if-exists','--no-owner','--no-acl','--exit-on-error'],source=source,timeout=6600)
                else:
                    self.execute_tool(auth,'mysql',['--protocol=socket','--user='+auth['user'],'--database='+database],source=source,timeout=6600)
            if database not in {r['name'] for r in self.databases(auth)}:
                raise ValueError('恢复后未核验到目标数据库')
            return [dict(service=database,state='restored',health='安全备份 '+safety['id'])], '恢复工具成功且目标库可查询；需核对应用数据和权限，不等于业务健康检查通过'
        if operation == 'create-database':
            sql = 'CREATE DATABASE '+identifier(database)
            if pg:
                sql += ' OWNER '+identifier(spec.get('owner') or auth['user'])
        elif operation == 'create-user':
            sql = ('CREATE ROLE '+user+' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD ' if pg else 'CREATE USER '+user+' IDENTIFIED BY ') + db_literal(spec['newPassword'])
        elif operation == 'password':
            sql = ('ALTER ROLE '+user+' PASSWORD ' if pg else 'ALTER USER '+user+' IDENTIFIED BY ') + db_literal(spec['newPassword'])
        elif operation in ('grant','revoke'):
            verb, relation = ('GRANT','TO') if operation == 'grant' else ('REVOKE','FROM')
            if pg:
                sql = 'BEGIN; '+verb+' CONNECT ON DATABASE '+identifier(database)+' '+relation+' '+user+'; '
                sql += verb+' USAGE,CREATE ON SCHEMA public '+relation+' '+user+'; '
                sql += verb+' ALL PRIVILEGES ON ALL TABLES IN SCHEMA public '+relation+' '+user+'; '
                sql += verb+' ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public '+relation+' '+user+'; COMMIT'
            else:
                sql = verb+' ALL PRIVILEGES ON '+identifier(database)+'.* '+relation+' '+user
        self.query(auth,sql+';',database if operation in ('grant','revoke') else None)
        if operation in ('grant','revoke'):
            if pg:
                result = self.query(auth, "SELECT json_build_object('CONNECT',has_database_privilege("+db_literal(role)+","+db_literal(database)+",'CONNECT'),'public.USAGE',has_schema_privilege("+db_literal(role)+",'public','USAGE'),'public.CREATE',has_schema_privilege("+db_literal(role)+",'public','CREATE'));", database)
            else:
                grantee = "'"+role+"'@'localhost'"
                result = self.query(auth, "SELECT COALESCE(JSON_ARRAYAGG(PRIVILEGE_TYPE),JSON_ARRAY()) FROM information_schema.SCHEMA_PRIVILEGES WHERE TABLE_SCHEMA="+db_literal(database)+" AND GRANTEE="+db_literal(grantee)+";")
            privileges = json.loads(result or '[]')
            return [dict(service=role,state=operation,health=json.dumps(privileges,ensure_ascii=False))], '已重新查询当前授权；PostgreSQL显示有效CONNECT及public权限，MySQL显示该库直接授权。PUBLIC/继承权限可能仍生效。'
        inventory = self.inventory(auth)
        if operation == 'create-database' and database not in {r['name'] for r in inventory['databases']}:
            raise ValueError('创建后未核验到数据库')
        if operation in ('create-user','password') and role not in {r['name'] for r in inventory['roles']}:
            raise ValueError('操作后未核验到账号')
        return [dict(service=database if operation=='create-database' else role,state=operation,health='目录已重新读取')], '数据库命令完成并重新读取目录；账号登录仍受服务器认证/主机规则限制，未修改这些规则。授权撤销不代表清除继承权限。'
