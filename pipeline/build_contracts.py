import json, os,os
ROOT = os.environ.get('MDR_ROOT') or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
cat=json.load(open(f'{ROOT}/data/module-catalog.json'))['modules']
fx={m['id']:m for m in json.load(open(f'{ROOT}/ref/schwung/tests/fixtures/module-contracts.json'))['modules']}
def parse(v):
    if isinstance(v,str):
        try: return json.loads(v)
        except: return None
    return v
out=[]
for m in cat:
    i=m['id']; mj={}
    p=f'{ROOT}/data/module-json/{i}.json'
    if os.path.exists(p):
        try: mj=json.load(open(p))
        except: mj={}
    caps=mj.get('capabilities') or {}
    rec=dict(id=i,name=m['name'],author=m.get('author',''),component_type=m['component_type'],
             subcategory=m.get('subcategory'),tags=m.get('tags',[]),description=m.get('description',''),
             abbrev=mj.get('abbrev'),version=mj.get('version'),github_repo=m['github_repo'],
             pad_layout=caps.get('pad_layout'))
    if i in fx:
        f=fx[i]; rec['ui_hierarchy']=parse(f.get('ui_hierarchy')); rec['chain_params']=parse(f.get('chain_params')) or []; rec['source']='fixture'
    else:
        uh=parse(mj.get('ui_hierarchy') or caps.get('ui_hierarchy'))
        cp=parse(mj.get('chain_params') or caps.get('chain_params')) or []
        rec['ui_hierarchy']=uh; rec['chain_params']=cp
        rec['source']='module.json' if (uh or cp) else 'none'
    out.append(rec)
import glob
for f in glob.glob(f'{ROOT}/data/so-contracts/*.json'):
    i=os.path.basename(f)[:-5]; d=json.load(open(f))
    uh=d.get('ui_hierarchy'); cp=d.get('chain_params')
    if isinstance(uh,str): uh=json.loads(uh)
    if isinstance(cp,str): cp=json.loads(cp)
    for m in out:
        if m['id']==i and m['source']=='none' and (uh or cp):
            m['ui_hierarchy']=uh; m['chain_params']=cp or []; m['source']='so'
json.dump(out,open(f'{ROOT}/data/contracts.json','w'))
from collections import Counter
print(Counter(r['source'] for r in out))
print('none:',[r['id'] for r in out if r['source']=='none'])

# ---------------------------------------------------------------------------
# Effective contract = what Schwung's chain host would actually serve on a Move,
# from the live DSP probe (build/contract/<id>.json), with the host's precedence:
#   audio/MIDI FX : ui_hierarchy from module.json first, else the plugin
#   sound gen     : ui_hierarchy from the plugin only
#   chain_params  : the plugin's (if useful), else module.json
# and the SCREEN a Move shows: the knob grid when a hierarchy is served,
# otherwise the module's own ui_chain.js, otherwise a grid from chain_params.
def first_hier(text):
    i = text.find('"ui_hierarchy"')
    if i < 0: return None
    j = text.find('{', i)
    if j < 0: return None
    d = 0
    for k in range(j, len(text)):
        if text[k] == '{': d += 1
        elif text[k] == '}':
            d -= 1
            if d == 0:
                try: return json.loads(text[j:k + 1])
                except Exception: return None
    return None

dm = json.load(open(f'{ROOT}/data/dsp-map.json'))
rep = {}
try: rep = {r['id']: r['kind'] for r in json.load(open(f'{ROOT}/build/film_custom_report.json'))}
except Exception: pass
for m in out:
    i = m['id']; e = dm.get(i) or {}
    d = e.get('dir')
    if d and not os.path.isabs(d): d = os.path.join(ROOT, d)
    served = {}
    p = f'{ROOT}/build/contract/{i}.json'
    if os.path.exists(p):
        try: served = json.load(open(p))
        except Exception: served = {}
    mj_text = open(os.path.join(d, 'module.json')).read() if d and os.path.exists(os.path.join(d, 'module.json')) else ''
    try: mj = json.loads(mj_text) if mj_text else {}
    except Exception: mj = {}
    file_hier = first_hier(mj_text)
    file_cp = mj.get('chain_params') or (mj.get('capabilities') or {}).get('chain_params')
    plug_hier = None
    if served.get('ui_hierarchy'):
        try: plug_hier = json.loads(served['ui_hierarchy'])
        except Exception: plug_hier = None
    plug_cp = None
    if served.get('chain_params'):
        try: plug_cp = json.loads(served['chain_params'])
        except Exception: plug_cp = None
    if p and os.path.exists(p):   # the DSP is probe-able: trust the host's rules over the old capture
        if m['component_type'] in ('audio_fx', 'midi_fx'):
            hier = file_hier or plug_hier
        else:
            hier = plug_hier
        cp = plug_cp or file_cp or []
        m['ui_hierarchy'] = hier
        m['chain_params'] = cp
        m['source'] = 'live'
    has_chain_ui = bool(d) and (os.path.exists(os.path.join(d, mj.get('ui_chain') or 'ui_chain.js')))
    if m['component_type'] in ('tool', 'overtake'):
        m['screen'] = 'module-ui'
    elif m.get('ui_hierarchy'):
        m['screen'] = 'grid'
    elif has_chain_ui:
        m['screen'] = 'module-ui'
    else:
        m['screen'] = 'grid' if m.get('chain_params') else 'info'
    m['canvas'] = bool(d) and os.path.exists(os.path.join(d, 'canvas.js'))
    m['module_dir'] = os.path.relpath(d, ROOT) if d else d     # relative: the workspace can move
json.dump(out, open(f'{ROOT}/data/contracts.json', 'w'))
from collections import Counter
print('screens', Counter(m['screen'] for m in out), 'sources', Counter(m['source'] for m in out))
print('module-ui (non tool):', [m['id'] for m in out if m['screen'] == 'module-ui' and m['component_type'] not in ('tool', 'overtake')])
print('info:', [m['id'] for m in out if m['screen'] == 'info'])
