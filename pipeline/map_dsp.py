#!/usr/bin/env python3
"""map_dsp.py — for every downloaded release (ref/rel/<id>/x), find the module's own
module.json, its dsp .so and which plugin entry points it exports -> data/dsp-map.json."""
import json, os, glob, subprocess
ROOT = os.environ.get('MDR_ROOT') or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
cat = json.load(open(f'{ROOT}/data/module-catalog.json'))['modules']
SYMS = ['move_plugin_init_v2', 'move_plugin_init_v1', 'move_audio_fx_init_v2', 'move_audio_fx_init_v1', 'move_midi_fx_init']
res = {}
for m in cat:
    i = m['id']; base = f'{ROOT}/ref/rel/{i}/x'
    pick = None
    for p in glob.glob(base + '/**/module.json', recursive=True):
        try:
            if json.load(open(p)).get('id') == i: pick = p; break
        except Exception: pass
    if not pick:
        c = glob.glob(base + '/**/module.json', recursive=True)
        pick = c[0] if c else None
    if not pick:
        res[i] = None; continue
    d = os.path.dirname(pick); mj = json.load(open(pick))
    so = os.path.join(d, mj['dsp']) if isinstance(mj.get('dsp'), str) and os.path.exists(os.path.join(d, mj['dsp'])) else None
    if not so:
        c = glob.glob(d + '/*.so'); so = c[0] if c else None
    api = ''
    if so:
        nm = subprocess.run(['nm', '-D', '--defined-only', so], capture_output=True, text=True).stdout
        api = ' '.join(s for s in SYMS if s in nm)
    rel = lambda x: os.path.relpath(x, ROOT) if x else x     # relative: the workspace can move
    res[i] = dict(dir=rel(d), so=rel(so), api=api, ctype=m['component_type'])
json.dump(res, open(f'{ROOT}/data/dsp-map.json', 'w'), indent=1)
# film_custom.mjs / extract_so_contracts.py look for releases at ref/modules/<id>/<id>
for i, e in res.items():
    if not e: continue
    link = f'{ROOT}/ref/modules/{i}/{i}'
    os.makedirs(os.path.dirname(link), exist_ok=True)
    if not os.path.lexists(link): os.symlink(os.path.join(ROOT, e['dir']), link)
print(f'mapped {sum(1 for v in res.values() if v and v["so"])} DSP libraries of {len(res)} modules')
