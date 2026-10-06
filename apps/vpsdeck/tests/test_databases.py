from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

assets = Path(__file__).parents[1]/'app/src/main/assets'
bundle = '\n'.join((assets/name).read_text() for name in ('vpsdeck_environment.py','vpsdeck_databases.py','vpsdeck_jobs.py'))
module = {'__name__':'fixture_bundle'}
exec(compile(bundle,'fixture_bundle','exec'),module)
Databases = module['Databases']


class DatabasesTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.engine = Databases(Path(self.temp.name)/'backups')
        self.auth = dict(engine='postgresql',user='postgres',password='admin-secret-value',asPostgres=False,container='')
        self.spec = dict(kind='database',name='demo',operation='backup',auth=self.auth,database='demo',role='app_reader')
        self.dbs = patch.object(self.engine,'databases',return_value=[dict(name='demo',owner='postgres',bytes=123)])
        self.roles = patch.object(self.engine,'roles',return_value=[dict(name='postgres',admin=True,managed=False),dict(name='app_reader',managed=True)])
        self.dbs.start();self.roles.start()
        self.addCleanup(self.dbs.stop);self.addCleanup(self.roles.stop)

    def test_database_identity_is_separate_and_never_in_password_argv(self):
        command, env = self.engine.command(self.auth,'psql',['-U','postgres'])
        self.assertEqual(['psql','-U','postgres'],command)
        self.assertNotIn('admin-secret-value',' '.join(command))
        self.assertEqual('admin-secret-value',env['PGPASSWORD'])
        self.assertNotIn('runuser',command)
        command,_ = self.engine.command(dict(self.auth,asPostgres=True),'psql',[])
        self.assertEqual(['runuser','-u','postgres','--','psql'],command)

    def test_docker_identity_and_env_are_explicit(self):
        command,env = self.engine.command(dict(self.auth,container='a'*64,asPostgres=True),'psql',[])
        self.assertEqual(['docker','exec','-i','--env','PGPASSWORD','--user','postgres','a'*64,'psql'],command)
        self.assertNotIn(env['PGPASSWORD'],command)

    def test_mariadb_images_without_mysql_alias_are_discovered_before_writes(self):
        from types import SimpleNamespace
        import subprocess
        auth=dict(self.auth,engine='mysql',container='a'*64)
        with patch.object(subprocess,'run',return_value=SimpleNamespace(returncode=0,stdout=b'mariadb')) as discover:
            command,env=self.engine.command(auth,'mysql',['--user=root'])
        self.assertEqual('mariadb',command[-2])
        self.assertEqual(self.auth['password'],env['MYSQL_PWD'])
        self.assertNotIn(self.auth['password'],' '.join(discover.call_args.args[0]))

    def test_invalid_identifiers_and_container_cannot_inject(self):
        for value in ['db;DROP DATABASE postgres','../db','db"','--dbname=foo']:
            with self.assertRaises(ValueError): module['db_name'](value)
        with self.assertRaises(ValueError): self.engine.auth(dict(self.auth,container='--privileged'))
        self.assertEqual('demo-name',module['db_name']('demo-name'))

    def test_admin_and_system_objects_protected(self):
        with self.assertRaises(ValueError): self.engine.plan(dict(self.spec,database='postgres'))
        with self.assertRaises(ValueError): self.engine.plan(dict(self.spec,operation='password',role='postgres',newPassword='New-password12'))
        with patch.object(self.engine,'roles',return_value=[dict(name='app_admin',admin=True,managed=False)]):
            with self.assertRaises(ValueError): self.engine.plan(dict(self.spec,operation='password',role='app_admin',newPassword='New-password12'))

    def test_preview_never_returns_passwords(self):
        plan=self.engine.plan(self.spec)
        self.assertNotIn(self.auth['password'],str(plan))
        self.assertNotIn('password',str(plan))

    def test_existing_database_or_account_not_overwritten(self):
        with self.assertRaises(ValueError): self.engine.plan(dict(self.spec,operation='create-database'))
        with self.assertRaises(ValueError): self.engine.plan(dict(self.spec,operation='create-user',newPassword='New-password12'))

    def test_role_password_goes_to_sql_stdin_with_literal_escaping(self):
        secret="twelve-chars'\\; DROP ROLE postgres;--"
        with patch.object(self.engine,'query',return_value='') as query, patch.object(self.engine,'inventory',return_value=dict(roles=[dict(name='app_reader')])):
            self.engine.execute(dict(self.spec,operation='password',newPassword=secret),lambda _:None)
        sql=query.call_args.args[1]
        self.assertIn("twelve-chars''\\; DROP ROLE postgres;--",sql)
        self.assertTrue(sql.startswith('ALTER ROLE "app_reader" PASSWORD '))

    def test_backup_private_and_tampering_detected(self):
        def tool(auth,tool,args,**kwargs):
            if kwargs.get('output') is not None: kwargs['output'].write(b'fixture custom-format archive')
            return ''
        with patch.object(self.engine,'execute_tool',side_effect=tool):
            backup=self.engine.make_backup(self.auth,'demo')
        row,data=self.engine.backup_record(self.auth,backup['id'],'demo')
        self.assertEqual(0,data.stat().st_mode & 0o077)
        data.write_bytes(b'changed')
        with self.assertRaises(ValueError): self.engine.backup_record(self.auth,backup['id'],'demo')

    def test_restore_cannot_start_without_new_safety_backup(self):
        spec=dict(self.spec,operation='restore',backup='b'*32,confirmRestoreTarget=True)
        with patch.object(self.engine,'backup_record',return_value=({'id':'b'*32},Path('not-opened'))), patch.object(self.engine,'make_backup',side_effect=ValueError('backup failed')), patch.object(self.engine,'execute_tool') as tool:
            with self.assertRaises(ValueError): self.engine.execute(spec,lambda _:None)
            tool.assert_not_called()

    def test_restore_requires_target_confirmation(self):
        with self.assertRaises(ValueError): self.engine.plan(dict(self.spec,operation='restore',backup='b'*32))
        with self.assertRaises(ValueError): self.engine.execute(dict(self.spec,operation='restore',backup='b'*32),lambda _:None)

    def test_cross_container_backup_requires_explicit_move(self):
        def tool(auth,tool,args,**kwargs):
            if kwargs.get('output') is not None: kwargs['output'].write(b'fixture archive')
            return ''
        with patch.object(self.engine,'execute_tool',side_effect=tool):
            row=self.engine.make_backup(self.auth,'demo')
        changed=dict(self.auth,container='b'*64)
        with self.assertRaises(ValueError): self.engine.backup_record(changed,row['id'],'demo')
        self.engine.backup_record(changed,row['id'],'demo',allow_move=True)

    def test_invalid_auth_engine_and_weak_new_password(self):
        with self.assertRaises(ValueError): self.engine.auth(dict(self.auth,engine='sqlite'))
        with self.assertRaises(ValueError): self.engine.plan(dict(self.spec,operation='create-user',role='app_new',newPassword='short'))
