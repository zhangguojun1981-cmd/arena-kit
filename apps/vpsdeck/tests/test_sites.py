import importlib.util
import pathlib
import tempfile
import unittest

path = pathlib.Path(__file__).parents[1] / 'app/src/main/assets/vpsdeck_sites.py'
spec = importlib.util.spec_from_file_location('sites', path)
sites = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sites)

class SitesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        self.conf = self.root / 'conf.d'; self.conf.mkdir()
        self.calls = []
        self.fail_test = False
        self.engine = sites.Engine(str(self.root/'state'), str(self.conf), self.run_command)
        self.site = dict(id='a'*32, domain='example.test', kind='proxy', port=8080, root='/var/www/vpsdeck/demo', upstream='http://127.0.0.1:9000', enabled=True, tls=False)
    def tearDown(self):
        self.tmp.cleanup()
    def run_command(self, args):
        self.calls.append(args)
        if self.fail_test and args == ['nginx','-t'] and self.engine.target(self.site['id']).exists():
            self.fail_test = False
            return 1, 'fixture configuration rejected'
        return 0, 'ok'
    def apply(self, value=None, expected=''):
        with self.engine.lock():
            return self.engine.apply(dict(spec=value or self.site, expected=expected))
    def test_create_real_files_and_list(self):
        self.apply(); row = self.engine.list()['sites'][0]
        self.assertFalse(row['drift']); self.assertTrue(row['spec']['enabled'])
        self.assertIn(b'proxy_pass http://127.0.0.1:9000;', self.engine.target(self.site['id']).read_bytes())
    def test_disable_preserves_metadata_and_backups(self):
        self.apply(); old = self.engine.read(self.site['id'])
        self.apply(dict(old, enabled=False), sites.revision(old))
        self.assertFalse(self.engine.target(old['id']).exists())
        self.assertEqual(2,len(self.engine.backups(old['id'])['backups']))
    def test_stale_revision_rejected_without_reload(self):
        self.apply(); count = len(self.calls)
        with self.assertRaises(ValueError): self.apply()
        self.assertEqual(count,len(self.calls))
    def test_external_config_edit_not_overwritten(self):
        self.apply(); self.engine.target(self.site['id']).write_text('external admin change')
        old = self.engine.read(self.site['id'])
        with self.assertRaises(ValueError): self.apply(old,sites.revision(old))
        self.assertEqual('external admin change',self.engine.target(old['id']).read_text())
    def test_failed_nginx_test_rolls_back_first_create(self):
        self.fail_test = True
        with self.assertRaises(RuntimeError): self.apply()
        self.assertIsNone(self.engine.read(self.site['id']))
        self.assertFalse(self.engine.target(self.site['id']).exists())
    def test_configuration_symlink_rejected(self):
        other = self.root/'other'; other.write_text('keep')
        self.engine.target(self.site['id']).symlink_to(other)
        with self.assertRaises(ValueError): self.apply()
        self.assertEqual('keep',other.read_text())
    def test_pending_transaction_can_be_recovered(self):
        self.apply(); old = self.engine.read(self.site['id'])
        new = sites.validate(dict(old,upstream='http://127.0.0.1:9001'))
        marker = self.engine.base/('pending-'+old['id'])
        marker.write_bytes(sites.encoded(dict(id=old['id'],old=old,new=new)))
        self.engine.install(old['id'],new)
        with self.engine.lock(): self.engine.recover(old['id'])
        self.assertTrue(self.engine.matches(old,old['id'])); self.assertFalse(marker.exists())
    def test_backup_restore_uses_new_revision_check(self):
        self.apply(); old = self.engine.read(self.site['id'])
        self.apply(dict(old,upstream='http://127.0.0.1:9001'),sites.revision(old))
        latest = self.engine.backups(old['id'])['backups'][0]
        now = self.engine.read(old['id'])
        with self.engine.lock(): self.engine.restore(dict(id=old['id'],backup=latest,expected=sites.revision(now)))
        self.assertEqual(old,self.engine.read(old['id']))
    def test_reject_nginx_and_shell_injection(self):
        for field,value in [('domain','x; include /etc/passwd'),('root','/var/www/$secret'),('upstream','http://localhost;reboot'),('upstream','http://local\nhost'),('upstream','http://user:pass@localhost'),('root','/var/www/../private')]:
            with self.subTest(field=field,value=value):
                with self.assertRaises(ValueError): sites.validate(dict(self.site,**{field:value}))
    def test_static_blocks_php_source(self):
        rendered=sites.render(dict(self.site,kind='static')).decode()
        self.assertIn('location ~ \\.php$ { return 404; }',rendered)
    def test_port_and_identity_validation(self):
        for change in [dict(port=0),dict(port=65536),dict(id='../bad'),dict(tls=True,port=80,cert='/etc/cert.pem',key='/etc/key.pem')]:
            with self.assertRaises(ValueError): sites.validate(dict(self.site,**change))
    def test_foreign_files_are_read_only(self):
        (self.conf/'existing.conf').write_text('server {}')
        self.apply()
        self.assertIn(str(self.conf/'existing.conf'), self.engine.list()['unmanaged'])
        self.assertEqual('server {}',(self.conf/'existing.conf').read_text())

if __name__ == '__main__': unittest.main()
