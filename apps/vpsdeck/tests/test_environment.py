import importlib.util
import os
from pathlib import Path
import tempfile
import unittest

path = Path(__file__).parents[1] / 'app/src/main/assets/vpsdeck_environment.py'
spec = importlib.util.spec_from_file_location('environment', path)
environment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(environment)


class EnvironmentTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.release = Path(self.temp.name)/'os-release'
        self.release.write_text('ID=debian\nVERSION_ID="12"\nPRETTY_NAME="Debian GNU/Linux 12"\n')
        self.calls = []
        self.version = '1.0'
        self.installed = '1.0'
        self.simulation = 'Inst nginx [1.0] (1.1 Debian:12/stable [amd64])\n'
        self.engine = environment.Environment(self.runner, self.release)

    def runner(self, args, **kwargs):
        self.calls.append(args)
        if args[0] == 'dpkg-query':
            return 'install ok installed\t' + self.installed
        if args[0] == 'apt-cache':
            return '  Candidate: ' + self.version + '\n'
        if args[:2] == ['apt-get', '-s']:
            return self.simulation
        return ''

    def test_discovery_is_read_only_and_structured(self):
        rows = self.engine.list()
        self.assertEqual(9,len(rows))
        self.assertTrue(all(row['supported'] for row in rows))
        self.assertFalse(any(c[0] == 'apt-get' for c in self.calls))
        self.assertEqual('1.0', rows[0]['packages'][0]['installed'])

    def test_non_debian_is_detected_but_mutations_refused(self):
        self.release.write_text('ID=ubuntu\nVERSION_ID="24.04"\n')
        self.assertFalse(self.engine.list()[0]['supported'])
        with self.assertRaises(ValueError):
            self.engine.plan(dict(name='nginx'))
        with self.assertRaises(ValueError):
            self.engine.execute(dict(name='nginx'))
        self.assertFalse(any(c[0] == 'apt-get' for c in self.calls))

    def test_simulation_parses_dependency_changes_and_is_not_install(self):
        result = self.engine.plan(dict(name='nginx'))
        self.assertEqual([dict(name='nginx',image='1.1')],result['services'])
        self.assertIn('自动启动', result['warning'])
        self.assertFalse(any(c[0] == 'env' for c in self.calls))

    def test_candidate_change_invalidates_plan(self):
        a = self.engine.plan(dict(name='nginx'))
        self.version = '2.0'
        self.assertNotEqual(a['revision'],self.engine.plan(dict(name='nginx'))['revision'])

    def test_removal_refused(self):
        self.simulation += 'Remv important-service [1.0]\n'
        with self.assertRaises(ValueError):
            self.engine.plan(dict(name='nginx'))

    def test_unknown_simulation_format_refused(self):
        self.simulation = 'Inst unknown-format\n'
        with self.assertRaises(ValueError):
            self.engine.plan(dict(name='nginx'))

    def test_missing_candidate_does_not_add_repository(self):
        self.version = '(none)'
        with self.assertRaises(ValueError):
            self.engine.plan(dict(name='nginx'))
        self.assertFalse(any(c[0] == 'apt-get' for c in self.calls))

    def test_install_preserves_configuration_and_verifies_version(self):
        rows, message = self.engine.execute(dict(name='nginx'))
        command = self.calls[0]
        self.assertIn('--no-remove',command)
        self.assertIn('Dpkg::Options::=--force-confold',command)
        self.assertIn('DEBIAN_FRONTEND=noninteractive',command)
        self.assertEqual('1.0',rows[0]['health'])
        self.assertIn('不代表服务健康',message)

    def test_partial_install_is_not_success(self):
        self.installed = ''
        with self.assertRaises(ValueError):
            self.engine.execute(dict(name='nginx'))

    def test_index_refresh_is_explicit_and_fails_partial_repositories(self):
        self.engine.plan(dict(name='apt-index'))
        self.assertEqual([],self.calls)
        self.engine.execute(dict(name='apt-index'))
        self.assertEqual([['apt-get','-o','APT::Update::Error-Mode=any','update']],self.calls)

    def test_arbitrary_package_injection_is_rejected(self):
        for name in ['nginx; reboot', '--allow-unauthenticated', 'openssh-server']:
            with self.assertRaises(ValueError):
                self.engine.plan(dict(name=name))
            with self.assertRaises(ValueError):
                self.engine.execute(dict(name=name))


class DockerRepositoryTest(unittest.TestCase):
    setUp=EnvironmentTest.setUp
    runner=EnvironmentTest.runner
    def setup_repo(self):
        self.engine.installed=lambda p: '1' if p in ('ca-certificates','gnupg') else ''
        self.engine.run=lambda args,**kw: 'amd64' if args[0]=='dpkg' else 'pub:-:4096:1:key:0:0::::::\nfpr:::::::::'+environment.DOCKER_KEY+':\n'
        self.apt=Path(self.temp.name)/'apt'
        self.data=b'-----BEGIN PGP PUBLIC KEY BLOCK-----\nfixture\n'

    def test_repository_is_explicit_and_readback_verified(self):
        self.setup_repo()
        plan=environment.docker_repository(self.engine,apt_root=self.apt)
        self.assertFalse(self.apt.exists())
        old=os.umask(0o077)
        try: environment.docker_repository(self.engine,True,self.apt,lambda:self.data)
        finally: os.umask(old)
        self.assertEqual(0o755,(self.apt/"keyrings").stat().st_mode & 0o777)
        source=self.apt/'sources.list.d/vpsdeck-docker.sources'
        self.assertIn('bookworm',source.read_text())
        self.assertEqual(0o644,source.stat().st_mode & 0o777)
        self.assertNotEqual(plan['revision'],environment.docker_repository(self.engine,apt_root=self.apt)['revision'])

    def test_repository_rejects_untrusted_key(self):
        self.setup_repo()
        self.engine.run=lambda args,**kw: 'amd64' if args[0]=='dpkg' else 'pub:-:4096:1:key:0:0::::::\nfpr:::::::::WRONG:\n'
        with self.assertRaisesRegex(ValueError,'指纹'):
            environment.docker_repository(self.engine,True,self.apt,lambda:self.data)
        self.assertFalse(self.apt.exists())

    def test_repository_rejects_foreign_source(self):
        self.setup_repo()
        self.apt.mkdir();(self.apt/'sources.list').write_text('deb https://download.docker.com/linux/debian bookworm stable')
        with self.assertRaisesRegex(ValueError,'已有其他'):
            environment.docker_repository(self.engine,apt_root=self.apt)

    def test_repository_rejects_existing_runtime(self):
        self.setup_repo();self.engine.installed=lambda p:'1'
        with self.assertRaisesRegex(ValueError,'冲突'):
            environment.docker_repository(self.engine,apt_root=self.apt)
