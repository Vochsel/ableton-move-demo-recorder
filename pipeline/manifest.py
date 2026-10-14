#!/usr/bin/env python3
"""manifest.py <public-base> — site/modules.json from every module with both renders on disk."""
import json, os, sys

ROOT = os.environ.get('MDR_ROOT') or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
pub = sys.argv[1].rstrip('/')
contracts = json.load(open(f'{ROOT}/data/contracts.json'))
audio = json.load(open(f'{ROOT}/build/audio/report.json')) if os.path.exists(f'{ROOT}/build/audio/report.json') else {}
LABEL = {'sound_generator': 'Sound Generator', 'audio_fx': 'Audio FX', 'midi_fx': 'MIDI FX',
         'overtake': 'Overtake', 'tool': 'Tool', 'utility': 'Utility'}
import glob
rev = {}
for f in glob.glob(f'{ROOT}/build/audit/review*.jsonl'):
    for line in open(f):
        try: r = json.loads(line); rev[r['id']] = r
        except Exception: pass
out = []
for m in contracts:
    i = m['id']
    if not (os.path.exists(f'{ROOT}/out/flat/schwung-{i}.mp4') and os.path.exists(f'{ROOT}/out/3d/schwung-{i}-3d.mp4')):
        continue
    a = audio.get(i, ['', ''])
    note = a[1] if len(a) > 1 else ''
    src = 'stand-in' if ('stand-in' in note or a[0] in ('custom', 'standin')) else 'module'
    out.append({
        'id': i, 'name': m['name'], 'author': m['author'], 'type': m['component_type'], 'typeLabel': LABEL.get(m['component_type'], m['component_type']),
        'desc': m['description'], 'repo': m['github_repo'],
        'flat': f'{pub}/v2/{i}.mp4', 'video3d': f'{pub}/v2/{i}-3d.mp4',
        'poster': f'{pub}/v2/{i}.jpg', 'poster3d': f'{pub}/v2/{i}-3d.jpg',
        'audio': src,
        'limit': (rev.get(i, {}).get('note') or '') if rev.get(i, {}).get('verdict') == 'limitation' else '',
    })
os.makedirs(f'{ROOT}/site', exist_ok=True)
json.dump(out, open(f'{ROOT}/site/modules.json', 'w'), indent=0)
print(f'manifest: {len(out)} modules')
