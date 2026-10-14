#!/usr/bin/env python3
"""gather_docs.py [ids] — each module's catalog entry, README (GitHub), help.json and current
recipe in one file, build/audit/docs/<id>.md, for whoever writes or reviews its demo."""
import base64, json, os, subprocess, sys, concurrent.futures as cf
ROOT = os.environ.get('MDR_ROOT') or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
cat = {m['id']: m for m in json.load(open(f'{ROOT}/data/module-catalog.json'))['modules']}
dm = json.load(open(f'{ROOT}/data/dsp-map.json')) if os.path.exists(f'{ROOT}/data/dsp-map.json') else {}
os.makedirs(f'{ROOT}/build/audit/docs', exist_ok=True)
def one(i):
    m = cat[i]
    parts = [f"# {m['name']} ({i}) — {m['component_type']}\n\nCatalog: {m['description']}\n"]
    r = subprocess.run(['gh', 'api', f"repos/{m['github_repo']}/readme", '--jq', '.content'], capture_output=True, text=True)
    if r.returncode == 0 and r.stdout.strip():
        parts.append('## README\n' + base64.b64decode(r.stdout).decode('utf8', 'replace')[:6000])
    d = (dm.get(i) or {}).get('dir') or ''
    hp = os.path.join(ROOT, d, 'help.json') if d else ''
    if hp and os.path.exists(hp): parts.append('## help.json\n' + open(hp).read()[:4000])
    rp = f'{ROOT}/data/recipes/{i}.json'
    if os.path.exists(rp): parts.append('## current demo recipe\n' + open(rp).read())
    open(f'{ROOT}/build/audit/docs/{i}.md', 'w').write('\n\n'.join(parts))
ids = sys.argv[1:] or list(cat)
with cf.ThreadPoolExecutor(10) as ex: list(ex.map(one, ids))
print(f'docs: {len(ids)} modules -> build/audit/docs/')
