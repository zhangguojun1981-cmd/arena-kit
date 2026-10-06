"""Real Debian 12 APT test inside a disposable, unpublished Docker container."""
import os
from pathlib import Path
import subprocess
import uuid

assert os.environ.get('VPSDECK_ENVIRONMENT_ACCEPTANCE') == '1', 'Disposable container opt-in required'
source = (Path(__file__).parents[1]/'app/src/main/assets/vpsdeck_environment.py').read_text()
test = r'''
import os, subprocess

def runner(args, timeout=120):
    r = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout, env=dict(os.environ, LC_ALL='C', LANG='C'))
    if r.returncode:
        raise RuntimeError('command failed: '+r.stdout.decode()[-1000:])
    return r.stdout.decode()

e = Environment(runner)
assert e.platform()['ID'] == 'debian'
assert e.platform()['VERSION_ID'] == '12'
rows = e.list()
assert all(r['supported'] for r in rows)
nginx = next(r for r in rows if r['name']=='nginx')
assert not nginx['packages'][0]['installed']
assert nginx['packages'][0]['candidate']
plan = e.plan(dict(name='nginx'))
assert any(p['name']=='nginx' for p in plan['services'])
assert not e.installed('nginx'), 'simulation must not install'
result, message = e.execute(dict(name='nginx'))
assert result[0]['state'] == 'installed'
assert result[0]['health'] == e.installed('nginx')
runner(['nginx','-t'])
assert next(r for r in e.list() if r['name']=='nginx')['packages'][0]['installed']
e.plan(dict(name='docker-prerequisites'))
e.execute(dict(name='docker-prerequisites'))
e.plan(dict(name='docker-repository'))
e.execute(dict(name='docker-repository'))
e.execute(dict(name='apt-index'))
plan=e.plan(dict(name='docker'))
assert any(p['name']=='docker-ce' for p in plan['services'])
result,message=e.execute(dict(name='docker'))
assert e.installed('docker-ce')
assert runner(['docker','compose','version','--short']).strip()
print('PASS Docker official key verification, repository setup, APT simulation/install and Compose CLI; no daemon/network-health claim')
print('PASS Debian 12 real APT discovery, dependency plan, install, version verification and nginx syntax')
'''
name = 'vpsdeck-env-accept-' + uuid.uuid4().hex[:10]
try:
    subprocess.run(['docker','run','--rm','--name',name,'-i','debian:12-slim','sh','-c',
                    'apt-get update -qq </dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends python3 </dev/null && exec python3 -'],
                   input=(source+'\n'+test).encode(), check=True, timeout=1200)
finally:
    subprocess.run(['docker','rm','-f',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
