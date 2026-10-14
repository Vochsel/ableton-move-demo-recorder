#!/usr/bin/env python3
"""gen_modules_js.py — module metadata the compositions read (compositions/flat/data/modules.js)."""
import json, os
ROOT = os.environ.get('MDR_ROOT') or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LABEL = {'sound_generator': 'Sound Generator', 'audio_fx': 'Audio FX', 'midi_fx': 'MIDI FX', 'overtake': 'Overtake', 'tool': 'Tool', 'utility': 'Utility'}
c = json.load(open(f'{ROOT}/data/contracts.json'))
out = {m['id']: dict(name=m['name'], author=m['author'], type=LABEL.get(m['component_type'], m['component_type']), ctype=m['component_type'],
                     sub=m.get('subcategory'), tags=m.get('tags') or [], desc=m['description'], version=m.get('version'),
                     repo=m['github_repo'], abbrev=m.get('abbrev'), pad_layout=m.get('pad_layout')) for m in c}
os.makedirs(f'{ROOT}/compositions/flat/data', exist_ok=True)
open(f'{ROOT}/compositions/flat/data/modules.js', 'w').write('window.MODULES=' + json.dumps(out) + ';\n')
print(f'modules.js: {len(out)} modules')
