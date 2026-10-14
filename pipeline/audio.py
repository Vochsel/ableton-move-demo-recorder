#!/usr/bin/env python3
"""audio.py — run each module's real DSP (ARM64, in Docker) against its score.

  python3 pipeline/audio.py probe  <ids|--all>
  python3 pipeline/audio.py render <ids|--all>

render writes build/audio/<id>.wav: exactly 12 s, a seamless loop (the score is
played twice and the second pass kept, so tails wrap). MIDI FX output notes are
written back into build/oled/<id>.js as pad events, so the lights show what the
module actually played.
"""
import json, os, subprocess, sys, concurrent.futures as cf, re

ROOT = os.environ.get('MDR_ROOT') or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SR, LOOP = 44100, 12.0
DM = json.load(open(f'{ROOT}/data/dsp-map.json'))
for _e in DM.values():               # paths are stored relative to the workspace
    if _e:
        for _k in ('dir', 'so'):
            if _e.get(_k) and not os.path.isabs(_e[_k]): _e[_k] = os.path.join(ROOT, _e[_k])
LT = json.load(open(f'{ROOT}/build/loadtest/result.json'))
STANDIN_SYNTH = os.environ.get('MDR_STANDIN_SYNTH', 'obxd')   # real Schwung modules used when a
STANDIN_DRUM = os.environ.get('MDR_STANDIN_DRUMS', '8w8')     # module makes no sound headless
os.makedirs(f'{ROOT}/build/audio', exist_ok=True)
os.makedirs(f'{ROOT}/build/probe', exist_ok=True)
W = lambda p: p.replace(ROOT, '/w')
WORK = f'{ROOT}/build/audiowork'
os.makedirs(WORK, exist_ok=True)


def defaults(i):
    e = DM[i]
    try:
        d = json.load(open(os.path.join(e['dir'], 'module.json'))).get('defaults')
    except Exception:
        d = None
    if not d:
        return '-'
    p = f'{WORK}/{i}.defaults.json'
    json.dump(d, open(p, 'w'))
    return W(p)


CATDIR = {'sound_generator': 'sound_generators', 'audio_fx': 'audio_fx', 'midi_fx': 'midi_fx',
          'tool': 'tools', 'overtake': 'overtake', 'utility': 'utilities'}
# files a module expects at an absolute on-device path, outside its own directory
EXTRA = {'breakbeat': [('samples', '/data/UserData/breakbeat-samples/Built-in')],
         'dr32': [('samples', '/data/UserData/UserLibrary/Samples/DR32')]}


def install_path(mod):
    """Where the module lives on a Move, so absolute-path assets resolve."""
    return f"/data/UserData/schwung/modules/{CATDIR.get(DM[mod]['ctype'], 'other')}/{mod}"


SAMPLELIB = f'{ROOT}/build/samplelib'      # rendered from Schwung's own synths (see run log)
SFZLIB = f'{ROOT}/build/sfzlib'
EXTRA_ABS = {'sfz': [(SFZLIB, '/data/UserData/schwung/modules/sound_generators/sfz/instruments')]}


def mounts(mods):
    v = []
    if os.path.isdir(SAMPLELIB):
        v += ['-v', f'{SAMPLELIB}:/data/UserData/UserLibrary/Samples:ro']
    for m in mods:
        e = DM.get(m)
        if not e:
            continue
        v += ['-v', f"{e['dir']}:{install_path(m)}:ro"]
        for sub, dest in EXTRA.get(m, []):
            v += ['-v', f"{os.path.join(e['dir'], sub)}:{dest}:ro"]
        for src, dest in EXTRA_ABS.get(m, []):
            if os.path.isdir(src):
                v += ['-v', f'{src}:{dest}:ro']
    return v


def docker(args, timeout=400, mods=()):
    r = subprocess.run(['docker', 'run', '--rm', '-v', f'{ROOT}:/w', *mounts(mods), 'schost', 'schost', *args],
                       capture_output=True, text=True, timeout=timeout)
    return r.returncode, r.stderr


def probe(i):
    plan = json.load(open(f'{ROOT}/build/plan/{i}.json'))
    if plan['role'] not in ('synth', 'fx', 'midifx') or not plan['keys']:
        return i, 'skip'
    e = DM[i]
    extra = []
    rp = f'{ROOT}/data/recipes/{i}.json'
    if os.path.exists(rp):
        sets = (json.load(open(rp)).get('set') or {})
        if sets:
            sf = f'{WORK}/{i}.sets.txt'
            open(sf, 'w').write(''.join(f'{k} {v}\n' for k, v in sets.items()))
            extra = [W(sf)]
    rc, err = docker(['probe', LT[i]['kind'], f"{install_path(i)}/{os.path.basename(e['so'])}", install_path(i), defaults(i),
                      f'/w/build/plan/{i}.keys.txt', f'/w/build/probe/{i}.json', *extra], mods=[i])
    n = len(json.load(open(f'{ROOT}/build/probe/{i}.json'))) if rc == 0 else 0
    return i, f'rc={rc} values={n}/{len(plan["keys"])}'


def contract(i):
    """Ask the running DSP what it serves — this decides grid vs the module's own screen."""
    e = DM.get(i)
    if not e or not e.get('so') or LT.get(i, {}).get('status') != 'OK':
        return i, 'no dsp'
    os.makedirs(f'{ROOT}/build/contract', exist_ok=True)
    kf = f'{WORK}/contract-keys.txt'
    open(kf, 'w').write('ui_hierarchy\nchain_params\nui_pages\n')
    rc, err = docker(['probe', LT[i]['kind'], f"{install_path(i)}/{os.path.basename(e['so'])}", install_path(i), defaults(i),
                      W(kf), f'/w/build/contract/{i}.json'], mods=[i])
    if rc:
        return i, f'rc={rc}'
    d = json.load(open(f'{ROOT}/build/contract/{i}.json'))
    return i, ' '.join(f"{k}={len(v)}" for k, v in d.items()) or 'serves nothing'


def smp(t):
    return int(round(t * SR))


def note_lines(notes, passes=2, keep=lambda n: True):
    out = []
    for p in range(passes):
        off = p * LOOP
        for n in notes:
            if not keep(n):
                continue
            out.append((smp(n['t'] + off), f"N {smp(n['t'] + off)} 144 {n['note']} {n['vel']}"))
            out.append((smp(n['t1'] + off) - 1, f"N {smp(n['t1'] + off) - 1} 128 {n['note']} 0"))
    return out


def auto_lines(auto, tag='V', passes=2):
    out = []
    for p in range(passes):
        for a in auto:
            s = smp(a['t'] + p * LOOP)
            out.append((s, f"{tag} {s} {a['key']} {a['value']}"))
    return out


def write_score(path, lines):
    lines.sort(key=lambda x: (x[0], 0 if x[1][0] == 'V' or x[1][0] == 'S' else 1))
    open(path, 'w').write('\n'.join(l for _, l in lines) + '\n')


def render_module(kind, mod, score_path, out_raw, extra=(), also=()):
    e = DM[mod]
    return docker(['render', kind, f"{install_path(mod)}/{os.path.basename(e['so'])}", install_path(mod), defaults(mod),
                   W(score_path), W(out_raw), str(LOOP * 2), *extra], mods=[mod, *also])


def mix_raw(a, b, out):
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-f', 's16le', '-ar', str(SR), '-ac', '2', '-i', a,
                    '-f', 's16le', '-ar', str(SR), '-ac', '2', '-i', b,
                    '-filter_complex', 'amix=inputs=2:normalize=0', '-f', 's16le', '-ar', str(SR), '-ac', '2', out], check=True)


def standin_mix(i, notes, out_raw):
    """Drums on 8W8, everything else on OB-Xd — both real Schwung modules."""
    d_s, s_s = f'{WORK}/{i}.sd.txt', f'{WORK}/{i}.ss.txt'
    write_score(d_s, note_lines(notes, keep=lambda n: n['part'] == 'drums'))
    write_score(s_s, note_lines(notes, keep=lambda n: n['part'] != 'drums'))
    a, b = f'{WORK}/{i}.sd.raw', f'{WORK}/{i}.ss.raw'
    r1 = render_module('synth', STANDIN_DRUM, d_s, a)
    r2 = render_module('synth', STANDIN_SYNTH, s_s, b)
    if r1[0] or r2[0]:
        raise RuntimeError(f'stand-in failed {r1} {r2}')
    mix_raw(a, b, out_raw)


def peak_db(raw):
    r = subprocess.run(['ffmpeg', '-f', 's16le', '-ar', str(SR), '-ac', '2', '-i', raw, '-ss', '12', '-af', 'volumedetect', '-f', 'null', '-'],
                       capture_output=True, text=True)
    m = re.search(r'max_volume: (-?[\d.]+|-inf) dB', r.stderr)
    return float(m.group(1)) if m and m.group(1) != '-inf' else -200.0


def finish(raw, wav):
    """Keep the second pass and bring it to a consistent loudness."""
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-f', 's16le', '-ar', str(SR), '-ac', '2', '-i', raw,
                    '-af', f'atrim=start_sample={int(LOOP*SR)}:end_sample={int(2*LOOP*SR)},asetpts=PTS-STARTPTS,'
                           'loudnorm=I=-16:TP=-1.5:LRA=11:linear=true,aresample=48000,apad=whole_len=576000,atrim=end_sample=576000',
                    '-ar', '48000', wav], check=True)


def midifx_pads(i, notes_txt):
    """Rewrite pad events from what the MIDI FX actually emitted."""
    sp = f'{ROOT}/build/score/{i}.json'
    o = json.load(open(sp))
    on = {}
    pads = []
    for line in open(notes_txt):
        s, st, n, v = map(int, line.split())
        t = s / SR - LOOP
        if t < 0:
            continue
        if (st & 0xF0) == 0x90 and v > 0:
            on[n] = (t, v)
        elif n in on:
            t0, vel = on.pop(n)
            pads.append((t0, t, n, vel))
    for n, (t0, vel) in on.items():
        pads.append((t0, LOOP, n, vel))
    def padfor(note):
        if '_drum' in i or True:
            pass
        x = note
        while x < 48: x += 12
        while x > 70: x -= 12
        for r in range(4):
            c = x - (48 + 5 * r)
            if 0 <= c < 8: return r * 8 + c
        return None
    drums = o.get('standinDrums')
    ev = [e for e in o['events'] if e.get('type') != 'pad']
    for t0, t1, n, vel in pads:
        if drums:
            s = n - 36
            p = (s // 4) * 8 + (s % 4) if 0 <= s < 16 else None
        else:
            p = padfor(n)
        if p is not None:
            ev.append({'t': round(t0, 4), 't1': round(max(t1, t0 + 0.06), 4), 'type': 'pad', 'pad': p, 'vel': vel, 'note': n})
    o['events'] = sorted(ev, key=lambda e: e['t'])
    json.dump(o, open(sp, 'w'))
    return len(pads)


def trace_args(i):
    k = f'{ROOT}/build/plan/{i}.trace.txt'
    if not os.path.exists(k):
        return []
    os.makedirs(f'{ROOT}/build/trace', exist_ok=True)
    return ['--trace', W(k), f'/w/build/trace/{i}.jsonl']


def render(i):
    sc = json.load(open(f'{ROOT}/build/score/{i}.json'))
    role = sc['role']
    raw = f'{WORK}/{i}.out.raw'
    wav = f'{ROOT}/build/audio/{i}.wav'
    s_path = f'{WORK}/{i}.score.txt'
    note = ''
    try:
        if role == 'synth':
            extra = []
            try:
                scaps = json.load(open(os.path.join(DM[i]['dir'], 'module.json'))).get('capabilities') or {}
            except Exception:
                scaps = {}
            if scaps.get('audio_in'):     # line-in instruments get the source loop on their input
                src = f'{WORK}/{i}.src.raw'
                standin_mix(i, sc['notes'], src)
                extra = ['--input', W(src)]
            write_score(s_path, note_lines(sc['notes']) + auto_lines(sc['automation']))
            rc, err = render_module('synth', i, s_path, raw, extra + trace_args(i))
            if rc: raise RuntimeError(f'render rc={rc} {err[-200:]}')
        elif role == 'fx':
            src = f'{WORK}/{i}.src.raw'
            standin_mix(i, sc['notes'], src)
            try:
                caps = json.load(open(os.path.join(DM[i]['dir'], 'module.json'))).get('capabilities') or {}
            except Exception:
                caps = {}
            midi = note_lines(sc['notes']) if caps.get('midi_in') else []
            write_score(s_path, midi + auto_lines(sc['automation']))
            rc, err = render_module('fx', i, s_path, raw, ['--input', W(src)] + (['--fxmidi'] if caps.get('midi_in') else []) + trace_args(i))
            if rc: raise RuntimeError(f'render rc={rc} {err[-200:]}')
        elif role == 'midifx':
            si = STANDIN_DRUM if sc.get('standinDrums') else STANDIN_SYNTH
            e = DM[si]
            notes_txt = f'{WORK}/{i}.notes.txt'
            write_score(s_path, note_lines(sc['notes']) + auto_lines(sc['automation']))
            rc, err = render_module('midifx', i, s_path, raw,
                                    ['--synth', W(e['so']), W(e['dir']), defaults(si), '--notes', W(notes_txt)] + trace_args(i))
            if rc: raise RuntimeError(f'render rc={rc} {err[-200:]}')
            note = f'out-notes={midifx_pads(i, notes_txt)}'
        else:
            standin_mix(i, sc['notes'], raw)
            note = 'stand-in'
        pk = peak_db(raw)
        if pk < -50 and role != 'standin' and role != 'custom':
            standin_mix(i, sc['notes'], raw)
            note = f'SILENT ({pk:.0f} dB) -> stand-in'
        finish(raw, wav)
        return i, role, f'ok peak={pk:.1f}dB {note}'
    except Exception as ex:
        try:
            standin_mix(i, sc['notes'], raw)
            finish(raw, wav)
            return i, role, f'FAILED -> stand-in: {str(ex)[:160]}'
        except Exception as ex2:
            return i, role, f'FAILED: {ex} / {ex2}'


if __name__ == '__main__':
    cmd, *rest = sys.argv[1:]
    ids = [c['id'] for c in json.load(open(f'{ROOT}/data/contracts.json'))] if '--all' in rest else [a for a in rest if not a.startswith('--')]
    fn = {'probe': probe, 'render': render, 'contract': contract}[cmd]
    report = {}
    with cf.ThreadPoolExecutor(6) as ex:
        for res in ex.map(fn, ids):
            print(*res, flush=True)
            report[res[0]] = res[1:]
    if cmd == 'render':
        p = f'{ROOT}/build/audio/report.json'
        old = json.load(open(p)) if os.path.exists(p) else {}
        old.update(report)
        json.dump(old, open(p, 'w'), indent=1)
