"""Real managed create/rebuild/config recovery via independent systemd workers."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import uuid

assert os.environ.get('VPSDECK_DEPLOYMENT_ACCEPTANCE')=='1', 'Disposable runner opt-in required'
assert os.geteuid()==0, 'Independent systemd fixture requires isolated root runner'
assets=Path(__file__).parents[1]/'app/src/main/assets'
source='\n'.join((assets/f).read_text() for f in ('vpsdeck_environment.py','vpsdeck_databases.py','vpsdeck_deployments.py','vpsdeck_jobs.py'))
# This harness contains only disposable fixtures. Expose runner diagnostics on failures
# without changing production error redaction or re-executing a failed mutation.
needle="require(p.returncode == 0, '工具执行失败，退出码 %s；请在服务器核查（不回传可能含凭据的输出）' % p.returncode)"
assert source.count(needle)==1
source=source.replace(needle,"require(p.returncode == 0, 'DISPOSABLE FIXTURE ONLY: '+text[-4000:])")
scope={'__name__':'deployment_acceptance'}
exec(compile(source,'bundle','exec'),scope)
engine=scope['Engine']()
deploy=scope['Deployments']()
name='vpsdeck-accept-'+uuid.uuid4().hex[:10]
resource_id=uuid.uuid4().hex
image1=name+':one';image2=name+':two'
identifiers=[]
backup_tags=[]
project=None

def task(spec):
    ident=uuid.uuid4().hex
    identifiers.append(ident)
    request=dict(id=ident,action=spec['operation'],project=spec,revision=engine.plan(spec)['revision'])
    engine.submit(request,source)
    deadline=time.monotonic()+120
    while time.monotonic()<deadline:
        row=next(r for r in engine.states() if r['id']==ident)
        if row['state']=='succeeded':
            return row
        if row['state']=='needs_review':
            raise AssertionError(row)
        time.sleep(1)
    raise AssertionError('task did not finish: '+repr(row))

try:
    with tempfile.TemporaryDirectory(prefix='vpsdeck-build-fixture-') as temp:
        path=Path(temp)
        (path/'Dockerfile').write_text('FROM busybox:1.36\nARG VERSION\nLABEL vpsdeck.acceptance.version=$VERSION\nCMD ["sleep","3600"]\n')
        for version,image in [('one',image1),('two',image2)]:
            subprocess.run(['docker','build','--build-arg','VERSION='+version,'-t',image,temp],check=True,timeout=180)
    spec=dict(kind='deployment',operation='create-container',id=resource_id,name=name,image=image1,memory=256,cpus=1,publish=False,volume=True,volumePath='/data',environment='LITERAL=keep$VALUE',command='',restart='unless-stopped')
    task(spec)
    row=next(r for r in deploy.listing() if r['name']==name)
    assert row['phase']=='ready'
    first=row['runtime']['image']
    project=deploy.owned(name)
    environment=json.loads(subprocess.check_output(['docker','inspect','--format','{{json .Config.Env}}',name]))
    assert 'LITERAL=keep$VALUE' in environment, environment
    subprocess.run(['docker','exec',name,'sh','-c','printf sentinel > /data/preserved'],check=True)
    task(dict(kind='deployment',operation='rebuild-container',name=name,image=image2,expected=row['revision']))
    row=next(r for r in deploy.listing() if r['name']==name)
    assert row['runtime']['image']!=first
    assert subprocess.check_output(['docker','exec',name,'cat','/data/preserved'])==b'sentinel'
    snapshot=next(b for b in row['backups'] if b['image']==image1)
    task(dict(kind='deployment',operation='restore-container',name=name,backup=snapshot['id'],expected=row['revision']))
    row=next(r for r in deploy.listing() if r['name']==name)
    assert row['runtime']['image']==first
    assert subprocess.check_output(['docker','exec',name,'cat','/data/preserved'])==b'sentinel'
    print('PASS independent workers: create, image-ID-pinned rebuild, literal env, retained volume, old config/image recovery',flush=True)
finally:
    for ident in identifiers:
        subprocess.run(['systemctl','stop','vpsdeck-'+ident+'.service'],capture_output=True)
    directory=scope['DEPLOY_ROOT']/name
    if directory.exists():
        for file in (directory/'backups').glob('*.json'):
            backup_tags.append(json.loads(file.read_text())['config']['services']['app']['image'])
    if project is not None:
        subprocess.run(deploy.command(project)+['down','--volumes','--remove-orphans'],capture_output=True,timeout=90)
    subprocess.run(['docker','rm','-f',name],capture_output=True)
    subprocess.run(['docker','volume','rm','vpsdeck-'+resource_id],capture_output=True)
    pinned=subprocess.check_output(['docker','image','ls','--format','{{.Repository}}:{{.Tag}}','--filter','reference=vpsdeck-pinned/'+name+':*']).decode().splitlines()
    for image in backup_tags+pinned+[image1,image2]:
        subprocess.run(['docker','image','rm',image],capture_output=True)
    shutil.rmtree(directory,ignore_errors=True)
    for ident in identifiers:
        shutil.rmtree(scope['ROOT']/ident,ignore_errors=True)
