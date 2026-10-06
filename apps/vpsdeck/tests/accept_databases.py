"""Real PostgreSQL and MariaDB fixtures. No published ports, never production."""
import os
from pathlib import Path
import subprocess
import tempfile
import time
import uuid

assert os.environ.get('VPSDECK_DATABASE_ACCEPTANCE') == '1', 'Disposable database opt-in required'
assets=Path(__file__).parents[1]/'app/src/main/assets'
scope={'__name__':'database_acceptance'}
exec(compile('\n'.join((assets/name).read_text() for name in ('vpsdeck_environment.py','vpsdeck_databases.py','vpsdeck_jobs.py')),'bundle','exec'),scope)

for engine,image,password_key in [('postgresql','postgres:16-alpine','POSTGRES_PASSWORD'),('mysql','mariadb:11.4','MARIADB_ROOT_PASSWORD')]:
    name='vpsdeck-db-accept-'+uuid.uuid4().hex[:10]
    password='Fixture-only-password-42'
    try:
        container=subprocess.check_output(['docker','run','-d','--name',name,'--env',password_key,image],env=dict(os.environ,**{password_key:password})).decode().strip()
        auth=dict(engine=engine,user='postgres' if engine=='postgresql' else 'root',password=password,container=container,asPostgres=engine=='postgresql')
        with tempfile.TemporaryDirectory(prefix='vpsdeck-db-backups-') as temp:
            db=scope['Databases'](Path(temp)/'backups')
            deadline=time.monotonic()+120
            while True:
                try:
                    assert db.query(auth,'SELECT 1;') == '1'
                    break
                except Exception:
                    if time.monotonic() > deadline:
                        raise
                    time.sleep(2)
            base=dict(kind='database',name='demo',auth=auth,database='demo',role='app_fixture',owner=auth['user'],newPassword="Fixture-user-'\\-password42")
            def act(operation,**extra):
                spec=dict(base,operation=operation,**extra)
                db.plan(spec)
                return db.execute(spec,lambda text:print('CHECKPOINT',text,flush=True))
            act('create-user')
            act('create-database')
            assert any(r['name']=='demo' for r in db.inventory(auth)['databases'])
            assert any(r['name']=='app_fixture' and r['managed'] for r in db.inventory(auth)['roles'])
            act('grant')
            user_auth=dict(auth,user='app_fixture',password=base['newPassword'])
            if engine=='postgresql':
                assert db.execute_tool(user_auth,'psql',['-X','-w','-A','-t','-h','127.0.0.1','-U','app_fixture','-d','demo'],text='SELECT 1;').strip()=='1'
            else:
                assert db.query(user_auth,'SELECT 1;','demo')=='1'
            db.query(auth,"CREATE TABLE fixture (id INTEGER PRIMARY KEY, value VARCHAR(40)); INSERT INTO fixture VALUES (1,'before-backup');",'demo')
            act('backup')
            before=db.backups(auth)
            assert len(before)==1
            original=before[0]
            db.query(auth,"UPDATE fixture SET value='after-backup' WHERE id=1;",'demo')
            act('restore',backup=original['id'],confirmRestoreTarget=True)
            assert db.query(auth,'SELECT value FROM fixture WHERE id=1;','demo') == 'before-backup'
            records=db.backups(auth)
            safety=next(r for r in records if r.get('recoveryOf')==original['id'])
            assert safety['id'] != original['id']
            # Actually restore the safety backup too: proves it is usable, not just a filename.
            act('restore',backup=safety['id'],confirmRestoreTarget=True)
            assert db.query(auth,'SELECT value FROM fixture WHERE id=1;','demo') == 'after-backup'
            act('password')
            act('revoke')
            act('drop-database')
            assert not any(r['name']=='demo' for r in db.databases(auth))
            before_delete=next(r for r in db.backups(auth) if r.get('recoveryOf')=='before-delete')
            act('create-database')
            act('restore',backup=before_delete['id'],confirmRestoreTarget=True)
            assert db.query(auth,'SELECT value FROM fixture WHERE id=1;','demo')=='after-backup'
            act('drop-user')
            assert not any(r['name']=='app_fixture' for r in db.roles(auth))
            print('PASS',engine,'real catalog, ordinary user, grant/revoke, password, backup/restore and independent safety-backup restore',flush=True)
    finally:
        subprocess.run(['docker','rm','-f',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
