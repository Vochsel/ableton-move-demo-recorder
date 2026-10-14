import json, os,subprocess,concurrent.futures as cf,os
ROOT = os.environ.get('MDR_ROOT') or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
dm=json.load(open(f'{ROOT}/data/dsp-map.json'))
def kind(e):
    a=e['api']
    if e['ctype']=='midi_fx' and 'midi_fx' in a: return 'midifx'
    if e['ctype']=='audio_fx' and 'audio_fx' in a: return 'fx'
    if 'plugin_init' in a: return 'synth'
    if 'audio_fx' in a: return 'fx'
    if 'midi_fx' in a: return 'midifx'
    return None
def w(p): return p.replace(ROOT,'/w')
def one(i):
    e=dm[i]
    if not e or not e['so']: return i,None,'no so'
    k=kind(e)
    if not k: return i,None,'no api'
    mj=os.path.join(e['dir'],'module.json'); defs='-'
    try:
        d=json.load(open(mj)).get('defaults')
        if d: open(f'{ROOT}/build/loadtest/{i}.defaults.json','w').write(json.dumps(d)); defs=f'/w/build/loadtest/{i}.defaults.json'
    except: pass
    r=subprocess.run(['docker','run','--rm','-v',f'{ROOT}:/w','schost','schost','probe',k,w(e['so']),w(e['dir']),defs,'/w/build/loadtest/empty.txt',f'/w/build/loadtest/{i}.json'],capture_output=True,text=True,timeout=300)
    err=(r.stderr.strip().splitlines() or [''])[-1][:100]
    return i,k,('OK' if r.returncode==0 else f'rc={r.returncode} {err}')
res={}
IDS=[a for a in __import__("sys").argv[1:]] or list(dm)
old=json.load(open(f"{ROOT}/build/loadtest/result.json")) if os.path.exists(f"{ROOT}/build/loadtest/result.json") else {}
with cf.ThreadPoolExecutor(8) as ex:
    for i,k,s in ex.map(one,IDS):
        res[i]=dict(kind=k,status=s)
        if s!='OK': print(i,k,s)
old.update(res); res=old
json.dump(res,open(f"{ROOT}/build/loadtest/result.json","w"),indent=1)
print(sum(1 for v in res.values() if v['status']=='OK'),'OK of',len(res))
