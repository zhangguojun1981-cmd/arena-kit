import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

path = Path(__file__).parents[1] / 'app/src/main/assets/vpsdeck_jobs.py'
spec = importlib.util.spec_from_file_location('jobs', path)
jobs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(jobs)


class JobsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.config = self.base / 'compose.json'
        self.config.write_text('{}')
        self.project = dict(name='demo', directory=str(self.base), files=[str(self.config)])
        self.calls = []
        self.config_data = dict(services=dict(web=dict(image='nginx:alpine')))
        self.status = '[{"Service":"web","State":"running","Health":"healthy"}]'
        self.fail_launch = False
        self.engine = jobs.Engine(self.base / 'jobs', self.run_command)
        self.auth = patch.object(jobs.Engine, 'authorize', return_value=None)
        self.auth.start()
        self.addCleanup(self.auth.stop)
        self.addCleanup(self.temp.cleanup)

    def run_command(self, args, **kwargs):
        self.calls.append(args)
        if args[0] == 'systemd-run' and self.fail_launch:
            raise RuntimeError('launch result lost')
        if args[-3:] == ['config', '--format', 'json']:
            return json.dumps(self.config_data)
        if args[-4:] == ['ps', '--all', '--format', 'json']:
            return self.status
        if args[:2] == ['systemctl', 'is-active']:
            return 'inactive'
        return ''

    def request(self, action='up'):
        return dict(id='a'*32, action=action, project=self.project,
                    revision=self.engine.plan(self.project)['revision'])

    def submit(self, action='up'):
        request = self.request(action)
        self.engine.submit(request, '# test worker, never executed')
        return request

    def test_plan_returns_no_environment_secrets(self):
        self.config_data['services']['web']['environment'] = {'PASSWORD': 'do-not-return'}
        result = self.engine.plan(self.project)
        self.assertNotIn('do-not-return', json.dumps(result))
        self.assertEqual('nginx:alpine', result['services'][0]['image'])

    def test_submit_has_no_request_or_secrets_in_argv(self):
        self.submit()
        launch = next(c for c in self.calls if c[0] == 'systemd-run')
        self.assertIn('--service-type=exec', launch)
        self.assertNotIn(str(self.config), launch)
        folder = self.base / 'jobs' / ('a'*32)
        self.assertEqual(0, folder.stat().st_mode & 0o077)
        self.assertEqual(0, (folder/'request.json').stat().st_mode & 0o077)

    def test_duplicate_id_cannot_relaunch(self):
        request = self.submit()
        with self.assertRaises(FileExistsError):
            self.engine.submit(request, 'ignored')
        self.assertEqual(1, sum(c[0] == 'systemd-run' for c in self.calls))

    def test_changed_environment_rejects_stale_plan(self):
        request = self.request()
        self.config_data['services']['web']['environment'] = {'NEW': 'value'}
        with self.assertRaises(ValueError):
            self.engine.submit(request, '')
        self.assertFalse((self.base/'jobs').exists())

    def test_worker_success_persists_and_removes_request(self):
        self.submit()
        self.engine.work('a'*32)
        self.assertEqual('succeeded', self.engine.states()[0]['state'])
        self.assertFalse((self.base/'jobs'/('a'*32)/'request.json').exists())
        with self.assertRaises(ValueError):
            self.engine.work('a'*32)
        self.assertEqual(1, sum(c[-3:] == ['up', '-d', '--no-build'] for c in self.calls))

    def test_worker_rechecks_revision_before_mutation(self):
        self.submit()
        self.config_data['services']['web']['image'] = 'nginx:changed'
        self.engine.work('a'*32)
        self.assertEqual('needs_review', self.engine.states()[0]['state'])
        self.assertFalse(any(c[-3:] == ['up', '-d', '--no-build'] for c in self.calls))

    def test_up_exit_zero_but_unhealthy_is_not_success(self):
        self.submit()
        self.status = '{"Service":"web","State":"running","Health":"unhealthy"}\n'
        self.engine.work('a'*32)
        self.assertEqual('needs_review', self.engine.states()[0]['state'])

    def test_ndjson_ps_parsing_and_stop_verification(self):
        self.submit('stop')
        self.status = '{"Service":"web","State":"exited"}\n{"Service":"other","State":"exited"}\n'
        self.engine.work('a'*32)
        self.assertEqual('succeeded', self.engine.states()[0]['state'])

    def test_missing_executor_is_unknown_not_success_or_replay(self):
        self.submit()
        self.assertEqual('unknown', self.engine.states()[0]['state'])
        self.assertEqual(1, sum(c[0] == 'systemd-run' for c in self.calls))

    def test_lost_launch_response_keeps_id_and_record(self):
        self.fail_launch = True
        with self.assertRaises(ValueError):
            self.submit()
        self.assertEqual('unknown', self.engine.states()[0]['state'])
        with self.assertRaises(FileExistsError):
            self.engine.submit(self.request(), '')

    def test_build_only_project_rejected(self):
        self.config_data = dict(services=dict(web=dict(build='.')))
        with self.assertRaises(ValueError):
            self.submit()

    def test_name_and_job_traversal_rejected(self):
        for value in ['../demo', 'demo;id', 'Demo', '-demo']:
            with self.assertRaises(ValueError):
                jobs.name(value)
        with self.assertRaises(ValueError):
            jobs.job_id('../'+'a'*32)

    def test_world_readable_store_rejected(self):
        store = self.base/'jobs'
        store.mkdir(mode=0o755)
        store.chmod(0o755)
        with self.assertRaises(ValueError):
            self.submit()

    def test_global_job_lock_contention_never_runs_mutation(self):
        self.submit()
        with open(self.base/'jobs'/'.mutation-lock', 'a') as lock:
            jobs.fcntl.flock(lock, jobs.fcntl.LOCK_EX | jobs.fcntl.LOCK_NB)
            self.engine.work('a'*32)
        self.assertEqual('needs_review', self.engine.states()[0]['state'])
        self.assertFalse(any(c[-3:] == ['up', '-d', '--no-build'] for c in self.calls))


if __name__ == '__main__':
    unittest.main()
