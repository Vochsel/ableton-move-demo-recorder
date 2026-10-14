import json, os,subprocess,os,concurrent.futures as cf,urllib.request,tarfile
ROOT = os.environ.get('MDR_ROOT') or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
cat=json.load(open(f'{ROOT}/data/module-catalog.json'))['modules']
def gh(*a): return subprocess.run(['gh','api',*a],capture_output=True,text=True).stdout
def one(m):
    i=m['id']; d=f'{ROOT}/ref/rel/{i}'
    if os.path.exists(d+'/.done'): return i,'cached'
    os.makedirs(d,exist_ok=True)
    url=None
    try:
        import base64
        rj=json.loads(base64.b64decode(gh(f"repos/{m['github_repo']}/contents/release.json?ref={m.get('default_branch','main')}",'--jq','.content')))
        if 'modules' in rj and i in rj['modules']: url=rj['modules'][i].get('download_url')
        url=url or rj.get('download_url')
    except Exception: pass
    if not url:
        out=gh(f"repos/{m['github_repo']}/releases/latest",'--jq',f'.assets[] | select(.name=="{m["asset_name"]}") | .browser_download_url').strip()
        url=out or None
    if not url: return i,'NO URL'
    tgz=d+'/pkg.tar.gz'
    try:
        urllib.request.urlretrieve(url,tgz)
        with tarfile.open(tgz) as t: t.extractall(d+'/x',filter='data')
        os.remove(tgz); open(d+'/.done','w').write(url); return i,'ok'
    except Exception as e: return i,'ERR '+str(e)[:80]
with cf.ThreadPoolExecutor(12) as ex:
    for i,s in ex.map(one,cat):
        if s not in('ok','cached'): print(i,s)
