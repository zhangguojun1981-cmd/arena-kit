"""Real Nginx/static/proxy acceptance, only in an explicitly enabled disposable CI runner."""
import importlib.util, pathlib, tempfile, subprocess, socket, uuid, shutil, time, os
assert os.environ.get('VPSDECK_NGINX_ACCEPTANCE') == '1'
path = pathlib.Path(__file__).parents[1]/'app/src/main/assets/vpsdeck_sites.py'
spec = importlib.util.spec_from_file_location('sites',path); sites=importlib.util.module_from_spec(spec);spec.loader.exec_module(sites)

def port():
    with socket.socket() as s:s.bind(('127.0.0.1',0));return s.getsockname()[1]

with tempfile.TemporaryDirectory(prefix='vpsdeck-nginx-ci-') as directory:
    p=pathlib.Path(directory); (p/'conf.d').mkdir(); config=p/'nginx.conf'
    config.write_text('worker_processes 1;\npid '+str(p/'nginx.pid')+';\nerror_log '+str(p/'error.log')+';\nevents { worker_connections 64; }\nhttp { access_log off; include '+str(p/'conf.d/*.conf')+'; }\n')
    base=['nginx','-p',directory,'-c',str(config)]
    def run(args):
        command=base+['-t'] if args==['nginx','-t'] else base+['-s','reload'] if args==['systemctl','reload','nginx'] else args
        r=subprocess.run(command,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=20)
        return r.returncode,r.stdout.decode()
    e=sites.Engine(str(p/'state'),str(p/'conf.d'),run)
    site_id=uuid.uuid4().hex; proxy_id=uuid.uuid4().hex; web=pathlib.Path('/var/www/vpsdeck-ci-'+site_id)
    assert not web.exists()
    try:
        subprocess.run(base,check=True)
        a=dict(id=site_id,domain='static.example.test',port=port(),kind='static',root=str(web),enabled=True,tls=False)
        with e.lock():e.apply(dict(spec=a,expected='',createRoot=True))
        time.sleep(1); assert e.health(site_id)['status']==200
        b=dict(id=proxy_id,domain='proxy.example.test',port=port(),kind='proxy',root=str(web),upstream='http://127.0.0.1:'+str(a['port']),enabled=True,tls=False)
        with e.lock():e.apply(dict(spec=b,expected=''))
        time.sleep(1); assert e.health(proxy_id)['status']==200
        old=e.read(site_id)
        with e.lock():e.apply(dict(spec=dict(old,enabled=False),expected=sites.revision(old)))
        time.sleep(1); assert e.health(proxy_id)['status']==502
        print('REAL_NGINX_ACCEPTANCE: static HTTP200, reverse proxy HTTP200, disable origin -> proxy HTTP502; PASS')
    finally:
        subprocess.run(base+['-s','quit'],stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
        if web.exists():shutil.rmtree(web)
