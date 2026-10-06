import json
from pathlib import Path
import tempfile
import unittest

assets=Path(__file__).parents[1]/'app/src/main/assets'
module={'__name__':'deployments_fixture'}
exec(compile('\n'.join((assets/f).read_text() for f in ('vpsdeck_environment.py','vpsdeck_databases.py','vpsdeck_deployments.py','vpsdeck_jobs.py')),'bundle','exec'),module)


class DeploymentsTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)/'projects'
        self.spec=dict(kind='deployment',operation='create-container',name='demo',id='a'*32,image='busybox:old',memory='256',cpus='1',publish=False,volume=True,volumePath='/data',environment='PASSWORD=private$VALUE',command='sleep\n3600',restart='unless-stopped')
        self.images={'busybox:old':'sha256:'+'1'*64,'busybox:new':'sha256:'+'2'*64}
        self.live=None
        self.calls=[]
        self.count=0
        self.fail_start=False
        self.engine=module['Deployments'](self.root,self.runner)

    def runner(self,args,**kwargs):
        self.calls.append(args)
        if args[:3]==['docker','compose','version']:return '2.39'
        if args[:3]==['docker','image','inspect']:
            return self.images.get(args[-1],args[-1] if args[-1].startswith('sha256:') else '')
        if args[:3]==['docker','image','tag']:
            self.images[args[-1]]=args[-2];return ''
        if args[:3]==['docker','image','pull']:return ''
        if args[:3]==['docker','ps','-a']:return 'demo' if self.live else ''
        if args[:3]==['docker','ps','-aq']:return self.live['id'] if self.live else ''
        if args[:3]==['docker','volume','ls']:return ''
        if args[:2]==['docker','compose']:
            if 'up' in args:
                if self.fail_start:raise ValueError('fixture apply interrupted')
                self.count+=1
                config=json.loads(Path(args[args.index('-f')+1]).read_text())
                service=config['services']['app']
                self.live=dict(id=str(self.count)*64,image=self.images.get(service['image'],service['image']),running=True,state='running',health='',labels=dict(service['labels'],**{'com.docker.compose.project':'vpsdeck-demo'}))
            return ''
        if args[:2]==['docker','inspect']:
            if self.live is None:raise ValueError('not found')
            return json.dumps(self.live)
        raise AssertionError(args)

    def create(self):
        self.engine.plan(self.spec)
        self.engine.execute(self.spec,lambda _:None)
        return self.engine.listing()[0]

    def test_runtime_template_handles_images_without_healthcheck(self):
        self.create()
        template=next(args[3] for args in self.calls if args[:2]==['docker','inspect'])
        self.assertIn('index .State "Health"',template)
        self.assertNotIn('.State.Health',template)

    def test_generated_config_is_nonprivileged_pinned_and_dollar_literal(self):
        spec=self.engine.validate(self.spec)
        config=self.engine.config(spec,self.images['busybox:old'])
        service=config['services']['app']
        self.assertEqual('vpsdeck-pinned/demo:'+'1'*64,service['image'])
        self.assertEqual('private$$VALUE',service['environment']['PASSWORD'])
        self.assertNotIn('privileged',service)
        self.assertEqual('volume',service['volumes'][0]['type'])
        self.assertEqual(['sleep','3600'],service['command'])

    def test_create_verifies_runtime_and_inventory_redacts_secrets(self):
        row=self.create()
        self.assertEqual('ready',row['phase'])
        self.assertEqual('running',row['runtime']['state'])
        self.assertNotIn('private',json.dumps(row))
        self.assertEqual(0,(self.root/'demo'/'compose.json').stat().st_mode & 0o077)
        with self.assertRaises(ValueError):self.engine.plan(self.spec)

    def test_rebuild_backs_up_config_and_retains_old_image(self):
        row=self.create()
        request=dict(kind='deployment',operation='rebuild-container',name='demo',image='busybox:new',expected=row['revision'])
        self.engine.plan(request)
        self.engine.execute(request,lambda _:None)
        row=self.engine.listing()[0]
        self.assertEqual(self.images['busybox:new'],row['runtime']['image'])
        self.assertEqual(1,len(row['backups']))
        self.assertTrue(any(tag.startswith('vpsdeck-backup/') and pin==self.images['busybox:old'] for tag,pin in self.images.items()))
        self.assertFalse(any('down' in command or '--volumes' in command for command in self.calls))

    def test_restore_configuration_is_explicit_and_keeps_named_volume(self):
        row=self.create()
        self.engine.execute(dict(operation='rebuild-container',name='demo',image='busybox:new',expected=row['revision']),lambda _:None)
        row=self.engine.listing()[0]
        request=dict(operation='restore-container',name='demo',backup=row['backups'][0]['id'],expected=row['revision'])
        self.engine.plan(request)
        self.engine.execute(request,lambda _:None)
        row=self.engine.listing()[0]
        self.assertEqual(self.images['busybox:old'],row['runtime']['image'])
        config=json.loads((self.root/'demo'/'compose.json').read_text())
        self.assertEqual('vpsdeck-'+'a'*32,config['volumes']['data']['name'])

    def test_failed_apply_stays_pending_and_has_recovery_snapshot(self):
        row=self.create()
        self.fail_start=True
        with self.assertRaises(ValueError):self.engine.execute(dict(operation='rebuild-container',name='demo',image='busybox:new',expected=row['revision']),lambda _:None)
        row=self.engine.listing()[0]
        self.assertEqual('pending',row['phase'])
        self.assertEqual(1,len(row['backups']))
        self.fail_start=False
        self.engine.execute(dict(operation='restore-container',name='demo',backup=row['backups'][0]['id'],expected=row['revision']),lambda _:None)
        self.assertEqual('ready',self.engine.listing()[0]['phase'])

    def test_external_config_edit_is_never_overwritten(self):
        row=self.create()
        config=self.root/'demo'/'compose.json'
        config.write_text('{}')
        with self.assertRaises(ValueError):self.engine.plan(dict(operation='rebuild-container',name='demo',image='busybox:new',expected=row['revision']))
        self.assertEqual('{}',config.read_text())
        self.assertEqual('blocked',self.engine.listing()[0]['phase'])

    def test_external_container_replacement_is_not_adopted(self):
        row=self.create()
        self.live['id']='f'*64
        with self.assertRaises(ValueError):self.engine.plan(dict(operation='rebuild-container',name='demo',image='busybox:new',expected=row['revision']))

    def test_stale_revision_and_modified_backup_refused(self):
        row=self.create()
        with self.assertRaises(ValueError):self.engine.plan(dict(operation='rebuild-container',name='demo',image='busybox:new',expected='stale'))
        self.engine.execute(dict(operation='rebuild-container',name='demo',image='busybox:new',expected=row['revision']),lambda _:None)
        row=self.engine.listing()[0]
        backup=self.root/'demo'/'backups'/(row['backups'][0]['id']+'.json')
        value=json.loads(backup.read_text());value['config']['services']['app']['privileged']=True;backup.write_text(json.dumps(value))
        with self.assertRaises(ValueError):self.engine.plan(dict(operation='restore-container',name='demo',backup=backup.stem,expected=row['revision']))

    def test_injection_and_invalid_resource_limits_refused(self):
        for changes in [dict(image='nginx;id'),dict(name='../demo'),dict(cpus='nan'),dict(memory='1'),dict(volumePath='/../root'),dict(environment='A=one\nA=two'),dict(environment='not-a-pair'),dict(publish=True,hostPort='0',containerPort='80')]:
            with self.assertRaises(ValueError):self.engine.validate(dict(self.spec,**changes))

    def test_pull_never_creates_container_or_project_files(self):
        self.engine.execute(dict(operation='pull-image',image='busybox:old'),lambda _:None)
        self.assertIsNone(self.live)
        self.assertFalse(self.root.exists())

    def test_interrupted_config_commit_recognizes_only_journal_versions(self):
        row=self.create()
        directory=self.root/'demo'
        old=self.engine.owned('demo')
        desired=self.engine.validate(dict(old['spec'],image='busybox:new'))
        after=dict(old,spec=desired,pin=self.images['busybox:new'],phase='pending',configHash=module['deploy_digest'](self.engine.config(desired,self.images['busybox:new'])))
        module['atomic'](directory/'transaction.json',dict(before=old,after=after))
        module['atomic'](directory/'metadata.json',after)
        recovered=self.engine.owned('demo')
        self.assertEqual('pending',recovered['phase'])
        self.assertEqual(old['pin'],recovered['pin'])
        (directory/'compose.json').write_text('{}')
        with self.assertRaises(ValueError):self.engine.owned('demo')
