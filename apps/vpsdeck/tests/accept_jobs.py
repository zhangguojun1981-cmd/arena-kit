"""Opt-in ROOT disposable Docker/systemd acceptance; never run on production."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import uuid

assert os.environ.get('VPSDECK_JOBS_ACCEPTANCE') == '1', 'Disposable runner opt-in required'
assert os.geteuid() == 0, 'Needs isolated root runner'
path = Path(__file__).parents[1] / 'app/src/main/assets/vpsdeck_jobs.py'
spec = importlib.util.spec_from_file_location('jobs', path)
jobs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(jobs)
source = path.read_text()
engine = jobs.Engine()
identifiers = []
project_name = 'vpsdeck-accept-' + uuid.uuid4().hex[:10]
with tempfile.TemporaryDirectory(prefix='vpsdeck-compose-') as temp:
    config = Path(temp)/'compose.json'
    config.write_text(json.dumps({'services': {'fixture': {'image': 'busybox:1.36', 'command': ['sleep','3600']}}}))
    project = dict(name=project_name, directory=temp, files=[str(config)])
    command = engine.command(project)
    try:
        jobs.run(command + ['up','-d'], timeout=180)
        discovered = next(p for p in engine.projects() if p['name'] == project_name)
        assert discovered['directory'] == temp
        assert discovered['files'] == [str(config)]
        for action in ['register', 'stop', 'up']:
            ident = uuid.uuid4().hex
            identifiers.append(ident)
            request = dict(id=ident, action=action, project=discovered, revision=engine.plan(discovered)['revision'])
            engine.submit(request, source)
            # Destroy/recreate controller: the job must be independent of the submitting process/state.
            reader = jobs.Engine()
            deadline = time.monotonic() + 90
            while time.monotonic() < deadline:
                row = next(r for r in reader.states() if r['id'] == ident)
                if row['state'] == 'succeeded':
                    break
                if row['state'] == 'needs_review':
                    raise AssertionError(row)
                time.sleep(1)
            else:
                raise AssertionError('Persistent task did not finish: ' + repr(row))
            if action!='register': assert row['resources'], row
            else: assert any(p['name']==project_name for p in reader.registered())
            assert not (jobs.ROOT/ident/'request.json').exists()
            try:
                engine.submit(request, source)
            except FileExistsError:
                pass
            else:
                raise AssertionError('Duplicate task was replayed')
            print('PASS independent systemd worker, verified Compose', action, flush=True)
    finally:
        registry=engine.root.parent/'compose-registry.json'
        if registry.exists():
            jobs.atomic(registry,[p for p in engine.registered() if p['name']!=project_name])
        for ident in identifiers:
            subprocess.run(['systemctl','stop','vpsdeck-'+ident+'.service'], capture_output=True)
        subprocess.run(command + ['down','--remove-orphans'], capture_output=True, timeout=90)
        for ident in identifiers:
            shutil.rmtree(jobs.ROOT/ident, ignore_errors=True)
