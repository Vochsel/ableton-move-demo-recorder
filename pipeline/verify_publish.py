#!/usr/bin/env python3
"""verify_publish.py — HEAD every video/poster the manifest points at; re-upload any that
are missing (uploads occasionally fail) and report what is still broken."""
import json, os, subprocess, sys
ROOT = os.environ.get('MDR_ROOT') or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
bucket = os.environ['MDR_BUCKET']
mods = json.load(open(f'{ROOT}/site/modules.json'))
LOCAL = {'flat': 'out/flat/schwung-{id}.mp4', 'video3d': 'out/3d/schwung-{id}-3d.mp4', 'poster': 'out/posters/{id}.jpg', 'poster3d': 'out/posters/{id}-3d.jpg'}
head = lambda u: subprocess.run(['curl', '-sI', '-o', '/dev/null', '-w', '%{http_code}', u], capture_output=True, text=True).stdout
bad = []
for m in mods:
    for k, tpl in LOCAL.items():
        if head(m[k]) == '200': continue
        key = m[k].split('.r2.dev/')[-1] if '.r2.dev/' in m[k] else m[k].split('/', 3)[-1]
        src = os.path.join(ROOT, tpl.format(id=m['id']))
        ctype = 'video/mp4' if src.endswith('.mp4') else 'image/jpeg'
        for _ in range(3):
            subprocess.run(['npx', 'wrangler', 'r2', 'object', 'put', f'{bucket}/{key}', '--file', src, '--content-type', ctype,
                            '--cache-control', 'public, max-age=86400', '--remote'], capture_output=True)
            if head(m[k]) == '200': print('re-uploaded', key); break
        else:
            bad.append(key)
print(f'checked {len(mods) * 4} files; still missing: {bad or "none"}')
sys.exit(1 if bad else 0)
