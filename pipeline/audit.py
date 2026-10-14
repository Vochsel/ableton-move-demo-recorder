import os
#!/usr/bin/env python3
"""audit.py — automated discrepancy checks over every module's demo data.

  python3 pipeline/audit.py   -> build/audit/report.json + report.md

Per module:
  screen        grid / module-ui, and whether it is drawn from the DSP trace
  audio         the module's own DSP or stand-ins (and why)
  static        the OLED never changes (a dead screen)
  blank         frames with nothing lit
  frozen        the longest run of identical frames
  seam          pixels differing between the last and first frame (loop seam)
  unanswered    page keys the DSP never answered in the trace
  turn-ignored  a knob turn the DSP never reflected back (the screen and sound won't move)
  quiet/hot     audio loudness outliers
"""
import base64, json, os, re, struct, subprocess

ROOT = os.environ.get('MDR_ROOT') or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
contracts = {m['id']: m for m in json.load(open(f'{ROOT}/data/contracts.json'))}
audio_rep = json.load(open(f'{ROOT}/build/audio/report.json')) if os.path.exists(f'{ROOT}/build/audio/report.json') else {}
OUT = f'{ROOT}/build/audit'
os.makedirs(OUT, exist_ok=True)


def oled(i):
    p = f'{ROOT}/build/oled/{i}.js'
    if not os.path.exists(p):
        return None
    s = open(p).read()
    return json.loads(s[s.index('{'):s.rindex('}') + 1])


def trace(i):
    p = f'{ROOT}/build/trace/{i}.jsonl'
    if not os.path.exists(p):
        return None
    fr = []
    for line in open(p):
        try: fr.append(json.loads(line))
        except Exception: pass
    return fr


def loudness(i):
    w = f'{ROOT}/build/audio/{i}.wav'
    if not os.path.exists(w):
        return None
    r = subprocess.run(['ffmpeg', '-i', w, '-af', 'volumedetect', '-f', 'null', '-'], capture_output=True, text=True)
    m = re.search(r'mean_volume: (-?[\d.]+) dB', r.stderr)
    return float(m.group(1)) if m else None


report = {}
for i, mod in contracts.items():
    f = []
    o = oled(i)
    sc = json.load(open(f'{ROOT}/build/score/{i}.json')) if os.path.exists(f'{ROOT}/build/score/{i}.json') else None
    a = audio_rep.get(i, ['', ''])
    note = a[1] if len(a) > 1 else ''
    src = 'stand-in' if ('stand-in' in note or (a and a[0] in ('custom', 'standin'))) else ('module' if a and a[0] else 'none')
    info = {'name': mod['name'], 'type': mod['component_type'], 'screen': mod.get('screen'), 'audio': src,
            'audio_note': note[:120], 'recipe': os.path.exists(f'{ROOT}/data/recipes/{i}.json')}
    if not o:
        f.append({'kind': 'no-film'})
    else:
        info['live'] = bool(o.get('live') or o.get('traced'))
        info['loop'] = o.get('loop')
        b = base64.b64decode(o['data'])
        frames = [b[k * 1024:(k + 1) * 1024] for k in range(o['frames'])]
        distinct = len(set(frames))
        blank = sum(1 for x in frames if not any(x))
        run, best = 1, 1
        for k in range(1, len(frames)):
            run = run + 1 if frames[k] == frames[k - 1] else 1
            best = max(best, run)
        seam = sum(bin(x ^ y).count('1') for x, y in zip(frames[0], frames[-1]))
        info.update({'distinct_frames': distinct, 'blank_frames': blank, 'longest_freeze_s': round(best / 30, 1), 'seam_px': seam})
        if distinct <= 2: f.append({'kind': 'static-screen', 'distinct': distinct})
        if blank > 30: f.append({'kind': 'blank-screen', 'frames': blank})
        if best > 150: f.append({'kind': 'frozen', 'seconds': round(best / 30, 1)})
        if seam > 60 and o.get('loop'): f.append({'kind': 'loop-seam', 'pixels': seam})
        if mod.get('screen') == 'grid' and not o.get('live'): f.append({'kind': 'not-live', 'detail': 'grid film without a DSP trace'})
    tr = trace(i)
    if tr and sc:
        seen = set()
        for fr in tr: seen |= set(fr)
        page_keys = set()
        for sgm in sc.get('segs', []):
            for T in sgm.get('turns', []): page_keys.add(T['key'])
        plan_keys = []
        kp = f'{ROOT}/build/plan/{i}.keys.txt'
        if os.path.exists(kp): plan_keys = [k for k in open(kp).read().split() if k]
        unanswered = [k for k in plan_keys if k not in seen]
        if plan_keys and len(unanswered) > len(plan_keys) * 0.3:
            f.append({'kind': 'unanswered', 'count': len(unanswered), 'of': len(plan_keys), 'keys': unanswered[:6]})
        # did each automated key move in the trace while it was being turned?
        auto = {}
        for e in sc.get('automation', []): auto.setdefault(e['key'], []).append(e)
        for k, ev in auto.items():
            if len(ev) < 4: continue
            vals = set()
            for fr in tr:
                t = fr.get('f', 0) / 30
                if ev[0]['t'] <= t <= ev[-1]['t'] and k in fr: vals.add(fr[k])
            if k in seen and len(vals) <= 1:
                f.append({'kind': 'turn-ignored', 'key': k, 'value': next(iter(vals), None)})
            elif k not in seen:
                f.append({'kind': 'turn-unreadable', 'key': k})
    if src == 'stand-in' and mod['component_type'] in ('sound_generator', 'audio_fx', 'midi_fx'):
        f.append({'kind': 'stand-in-audio', 'detail': note[:100]})
    lv = loudness(i)
    info['mean_db'] = lv
    if lv is not None and lv < -32: f.append({'kind': 'quiet', 'mean_db': lv})
    report[i] = {**info, 'findings': f}

json.dump(report, open(f'{OUT}/report.json', 'w'), indent=1)
by = {}
for i, r in report.items():
    for x in r['findings']: by.setdefault(x['kind'], []).append((i, x))
md = ['# Demo audit', '', f'{len(report)} modules.', '',
      '| | count |', '|---|---|']
for k in sorted(by): md.append(f'| {k} | {len({i for i, _ in by[k]})} |')
md.append('')
for k in sorted(by):
    md.append(f'## {k}')
    for i, x in by[k]: md.append(f"- {i}: {json.dumps({a: b for a, b in x.items() if a != 'kind'})}")
    md.append('')
open(f'{OUT}/report.md', 'w').write('\n'.join(md))
print('\n'.join(md[:20]))
