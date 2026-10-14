#!/usr/bin/env python3
"""findings.py — build/FINDINGS.md for module authors, from the fuzz, UI-fuzz, audit and
visual-review reports, plus hand-written notes in data/findings-notes.md."""
import glob, json, os
ROOT = os.environ.get('MDR_ROOT') or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
J = lambda p, d=None: json.load(open(p)) if os.path.exists(p) else d
contracts = {m['id']: m for m in J(f'{ROOT}/data/contracts.json', [])}
fz = J(f'{ROOT}/build/fuzz/report.json', {})
ui = J(f'{ROOT}/build/fuzz/ui-report.json', {})
rev = {}
for f in glob.glob(f'{ROOT}/build/audit/review*.jsonl') + glob.glob(f'{ROOT}/data/audit/review*.jsonl'):
    for line in open(f):
        try: r = json.loads(line); rev[r['id']] = r
        except Exception: pass
au = J(f'{ROOT}/build/audit/report.json', {})
who = lambda i: contracts.get(i, {}).get('author', '?')

L = ['# Module demo findings', '',
     'From rendering catalog modules headlessly: each module\'s released `dsp.so` runs in an ARM64 Linux container behind a host '
     'that implements Schwung\'s plugin API, and each screen is drawn by Schwung\'s own renderer (or the module\'s own UI code) from '
     'values read back from the DSP every frame. Treat these as leads to confirm on hardware.', '']

crash = {}
for i, x in fz.items():
    for f in x.get('findings', []):
        if f['kind'] == 'crash' and f.get('rc') == 139: crash.setdefault(i, f)
        if f['kind'] == 'timeout': crash.setdefault(i, f)
if crash:
    L += ['## Crashes and timeouts under random input', '']
    for i, f in sorted(crash.items()):
        L.append(f"- **{i}** ({who(i)}): {'segfault' if f['kind'] == 'crash' else 'host timeout'} under a random score (fuzz iteration {f['iter']}). "
                 f"Repro: `build/fuzz/{i}.{f['iter']}.score.txt` with `pipeline/host` (see docs/FUZZING.md).")
    L.append('')

hang = [(i, f) for i, r in ui.items() for f in r.get('findings', []) if f['kind'] in ('hang', 'throws')]
if hang:
    L += ['## UI renderer hangs and exceptions', '']
    for i, f in hang:
        L.append(f"- **{i}** ({who(i)}): {f['kind']} — {f.get('page', '')} {f.get('detail', '')[:160]}  (repro: `node pipeline/fuzz_ui.mjs --one --iters 3 {i}`)")
    L.append('')

slow = [(i, max(f['realtime_x'] for f in x['findings'] if f['kind'] == 'slow')) for i, x in fz.items() if any(f['kind'] == 'slow' for f in x.get('findings', []))]
L += ['## Performance', '']
L += [f"- **{i}**: the DSP loop alone took {x}× real time under random parameters." for i, x in sorted(slow, key=lambda y: -y[1])] or \
     ['No module\'s DSP loop came near real time under random parameters (measured inside the host, start-up excluded).']
L.append('')

lim = [(i, r) for i, r in sorted(rev.items()) if r.get('verdict') == 'limitation']
if lim:
    L += ['## Needs something a headless demo cannot provide', '']
    L += [f"- **{i}**: {r.get('note') or '; '.join(r.get('problems', []))}" for i, r in lim]
    L.append('')

silent = [i for i, r in au.items() if any(f['kind'] == 'stand-in-audio' for f in r.get('findings', [])) and i not in dict(lim)]
if silent:
    L += ['## Silent when run headless (stand-in audio used)', '']
    L += [f"- **{i}**: {au[i].get('audio_note', '')}" for i in silent]
    L.append('')

wi = {i: sorted({f['key'] for f in x.get('findings', []) if f['kind'] == 'write-ignored'}) for i, x in fz.items()}
wi = {i: k for i, k in wi.items() if k}
if wi:
    L += ['## Parameter writes the DSP never reflected back (unverified)', '',
          'In-range values from each module\'s own `chain_params`, read back afterwards (allowing for step, clamping and the module\'s enum '
          'convention). Often a declared range that differs from what the module accepts, or a different display scale.', '']
    L += [f"- **{i}**: {', '.join('`' + k + '`' for k in ks[:8])}{' …' if len(ks) > 8 else ''}" for i, ks in sorted(wi.items())]
    L.append('')

notes = f'{ROOT}/data/findings-notes.md'
if os.path.exists(notes):
    L += ['## Notes from hand investigation', '', open(notes).read().strip(), '']
open(f'{ROOT}/build/FINDINGS.md', 'w').write('\n'.join(L) + '\n')
print(f'build/FINDINGS.md: {len(L)} lines')
