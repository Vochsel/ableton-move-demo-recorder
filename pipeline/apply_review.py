import os
#!/usr/bin/env python3
"""apply_review.py — merge the visual audit's suggested recipes into data/recipes.

Every key and page name is checked against the module's real contract/score
before it is accepted; anything that doesn't exist is dropped and reported.
Prints the ids whose recipe changed (feed them to run_data.sh).
"""
import glob, json, os, sys

ROOT = os.environ.get('MDR_ROOT') or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
contracts = {m['id']: m for m in json.load(open(f'{ROOT}/data/contracts.json'))}
changed, dropped, reviews = [], [], {}
for f in sorted(glob.glob(f'{ROOT}/build/audit/review*.jsonl')):
    for line in open(f):
        line = line.strip()
        if not line: continue
        try: r = json.loads(line)
        except Exception: continue
        reviews[r['id']] = r

def known_keys(i):
    ks = set()
    m = contracts.get(i, {})
    for p in m.get('chain_params') or []:
        if isinstance(p, dict) and p.get('key'): ks.add(p['key'])
    def walk(x):
        if isinstance(x, dict):
            if isinstance(x.get('key'), str): ks.add(x['key'])
            for v in x.values(): walk(v)
        elif isinstance(x, list):
            for v in x:
                if isinstance(v, str): ks.add(v)
                else: walk(v)
    walk(m.get('ui_hierarchy'))
    sp = f'{ROOT}/build/contract/{i}.json'
    if os.path.exists(sp):
        try:
            d = json.load(open(sp))
            if d.get('ui_pages'): walk(json.loads(d['ui_pages']))
        except Exception: pass
    kp = f'{ROOT}/build/plan/{i}.trace.txt'
    if os.path.exists(kp): ks |= {k for k in open(kp).read().split() if k}
    return ks

def page_names(i):
    sc = f'{ROOT}/build/score/{i}.json'
    names = set()
    if os.path.exists(sc):
        for s in json.load(open(sc)).get('segs', []): names.add(s['name'])
    # also every page the planner can produce (names appear in the hierarchy levels)
    m = contracts.get(i, {})
    for lvl in ((m.get('ui_hierarchy') or {}).get('levels') or {}).values():
        for k in ('name', 'label'):
            if isinstance(lvl.get(k), str): names.add(lvl[k])
    return names

for i, r in reviews.items():
    rec = r.get('recipe')
    if r.get('verdict') != 'fixable' or not isinstance(rec, dict):
        continue
    keys = known_keys(i)
    out = {k: v for k, v in rec.items() if k in ('play', 'notes', 'note', 'part')}
    if rec.get('pages'):
        pn = page_names(i)
        ok = [p for p in rec['pages'] if p in pn]
        if len(ok) != len(rec['pages']): dropped.append((i, 'pages', [p for p in rec['pages'] if p not in pn]))
        if ok: out['pages'] = ok
    if rec.get('turns'):
        ok = [t for t in rec['turns'] if isinstance(t, dict) and t.get('key') in keys]
        if len(ok) != len(rec['turns']): dropped.append((i, 'turns', [t.get('key') for t in rec['turns'] if t.get('key') not in keys]))
        if ok: out['turns'] = ok
    if rec.get('set'):
        ok = {k: v for k, v in rec['set'].items() if k in keys}
        if len(ok) != len(rec['set']): dropped.append((i, 'set', [k for k in rec['set'] if k not in keys]))
        if ok: out['set'] = ok
    p = f'{ROOT}/data/recipes/{i}.json'
    old = json.load(open(p)) if os.path.exists(p) else {}
    if old.get('locked'):
        continue        # hand-written recipes (mestela's, samplers) win over the review
    merged = {**old, **out, 'note': (out.get('note') or r.get('note') or old.get('note') or '') + ' [audit]'}
    if merged != old:
        json.dump(merged, open(p, 'w'), indent=1)
        changed.append(i)

json.dump({'changed': changed, 'dropped': dropped}, open(f'{ROOT}/build/audit/applied.json', 'w'), indent=1)
print(' '.join(changed))
print('dropped:', dropped, file=sys.stderr)
