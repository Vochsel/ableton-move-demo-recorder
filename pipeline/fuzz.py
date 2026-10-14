#!/usr/bin/env python3
"""fuzz.py — throw random and extreme input at every module's real DSP.

  python3 pipeline/fuzz.py [ids...] [--iters N]

Per module, N random scores (notes anywhere in 24..96, random lengths and
velocities, chords and repeats; parameter writes of random keys from the
module's own chain_params at random, min, max, out-of-range and garbage values,
including rapid automation), each rendered twice through the headless host with
a per-frame trace of every written key. Flags:

  crash / timeout       the host died (signal) or ran past its alarm
  slow                  rendering slower than real time (it would glitch on a Move)
  silent                a sound generator stayed silent through every note
  clip                  >1% of samples at full scale
  dc                    a DC offset over 5% of full scale
  write-ignored         a write the DSP never reflected back (wrong wire format?)

Writes build/fuzz/report.json and build/fuzz/report.md.
"""
import json, os, random, re, struct, subprocess, sys, time, concurrent.futures as cf

ROOT = os.environ.get('MDR_ROOT') or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'pipeline'))
import audio as A   # docker(), install_path(), defaults(), W()

SR = 44100
SECS = 4.0
OUT = f'{ROOT}/build/fuzz'
os.makedirs(OUT, exist_ok=True)
contracts = {m['id']: m for m in json.load(open(f'{ROOT}/data/contracts.json'))}
LT = A.LT


def params(mod):
    out = []
    for p in mod.get('chain_params') or []:
        if not isinstance(p, dict) or not p.get('key'):
            continue
        if p.get('access') == 'read' or p.get('type') in ('canvas', 'string', 'filepath', 'action'):
            continue
        out.append(p)
    return out


def rand_value(p, R):
    t = p.get('type')
    if t == 'enum':
        opts = p.get('options') or []
        r = R.random()
        if r < 0.6 and opts:
            return str(R.randrange(len(opts))), 'index'
        if r < 0.85 and opts:
            return R.choice(opts), 'name'
        return R.choice(['-1', str(len(opts) + 3), '']), 'bad'
    lo = p.get('min', 0) if isinstance(p.get('min'), (int, float)) else 0
    hi = p.get('max', 1) if isinstance(p.get('max'), (int, float)) else 1
    r = R.random()
    if r < 0.15:
        v = lo
    elif r < 0.3:
        v = hi
    elif r < 0.38:
        return R.choice([str(hi + (hi - lo) * 3), str(lo - (hi - lo) * 3), 'nan', '1e30', 'abc', '']), 'bad'
    else:
        v = lo + (hi - lo) * R.random()
    return (str(int(round(v))) if t == 'int' else f'{v:.4f}'), 'ok'


def make_score(i, mod, it, path_score, path_keys):
    R = random.Random(f'{i}/{it}')
    ps = params(mod)
    lines, written = [], []
    loop = SECS / 2
    for rep in range(2):
        off = rep * loop
        RR = random.Random(f'{i}/{it}/notes')         # same notes both passes
        for _ in range(RR.randint(4, 24)):
            t = RR.random() * (loop - 0.2)
            dur = RR.choice([0.02, 0.1, 0.3, 0.8, 1.5])
            n = RR.randint(24, 96)
            for k in range(RR.choice([1, 1, 1, 3])):
                s = int((t + off) * SR)
                lines.append((s, f'N {s} 144 {n + k * 4} {RR.randint(1, 127)}'))
                e = int((min(loop, t + dur) + off) * SR) - 1
                lines.append((e, f'N {e} 128 {n + k * 4} 0'))
        RW = random.Random(f'{i}/{it}/writes')
        for _ in range(RW.randint(3, 12) if ps else 0):
            p = RW.choice(ps)
            t = RW.random() * (loop * 0.8)
            ramp = RW.random() < 0.3
            for j in range(12 if ramp else 1):
                v, kind = rand_value(p, RW)
                s = int((t + off + j * 0.01) * SR)
                lines.append((s, f"V {s} {p['key']} {v}"))
                if rep == 1 and j == (11 if ramp else 0):
                    written.append({'t': t + j * 0.01, 'key': p['key'], 'value': v, 'kind': kind, 'type': p.get('type'), 'options': p.get('options'),
                                    'min': p.get('min'), 'max': p.get('max'), 'step': p.get('step')})
    lines.sort(key=lambda x: x[0])
    open(path_score, 'w').write('\n'.join(l for _, l in lines) + '\n')
    open(path_keys, 'w').write('\n'.join(sorted({w['key'] for w in written})) + '\n')
    return written


def analyse(raw):
    d = open(raw, 'rb').read()
    n = len(d) // 2
    if n == 0:
        return None
    x = struct.unpack(f'<{n}h', d)
    half = x[n // 2:]
    peak = max(abs(v) for v in half) if half else 0
    clip = sum(1 for v in half if abs(v) >= 32760) / max(1, len(half))
    dc = abs(sum(half) / max(1, len(half))) / 32768
    return {'peak': peak, 'clip': clip, 'dc': dc}


def reflected(w, tr):
    """did the trace ever show the written value after the write?"""
    want = w['value']
    for fr in tr:
        if fr.get('f', 0) / 30.0 < w['t'] + 0.05:
            continue
        got = fr.get(w['key'])
        if got is None:
            return None            # key never readable: not a finding by itself
        if got == want:
            return True
        try:
            g, wv = float(re.sub(r'[^0-9eE+.-]', '', got) or 'x'), float(want)
            lo, hi = w.get('min', 0), w.get('max', 1)
            tol = max(float(w.get('step') or 0), 0.01 * abs((hi if isinstance(hi, (int, float)) else 1) - (lo if isinstance(lo, (int, float)) else 0)), 1e-3)
            if abs(g - wv) <= tol * 1.01:
                return True
            # a clamp to the declared range is the module honouring the write
            if isinstance(lo, (int, float)) and isinstance(hi, (int, float)) and (abs(g - lo) <= tol or abs(g - hi) <= tol) and not (lo <= wv <= hi):
                return True
        except ValueError:
            pass
        if w['type'] == 'enum' and w['options']:
            opts = w['options']
            try:
                if want.isdigit() and int(want) < len(opts) and got == opts[int(want)]:
                    return True
                if want in opts and got.strip().isdigit() and int(got) == opts.index(want):
                    return True
            except Exception:
                pass
    return False


def fuzz(i, iters):
    e = A.DM.get(i)
    lt = LT.get(i, {})
    if not e or lt.get('status') != 'OK':
        return i, {'skipped': 'no loadable DSP'}
    mod = contracts[i]
    kind = lt['kind']
    findings, runs = [], []
    for it in range(iters):
        sp, kp = f'{OUT}/{i}.{it}.score.txt', f'{OUT}/{i}.{it}.keys.txt'
        raw, trp = f'{OUT}/{i}.{it}.raw', f'{OUT}/{i}.{it}.trace.jsonl'
        written = make_score(i, mod, it, sp, kp)
        extra = ['--trace', A.W(kp), A.W(trp)]
        if kind == 'fx':
            src = f'{A.WORK}/{i}.src.raw'
            if not os.path.exists(src):
                src = f'{A.WORK}/obxd.src.raw' if os.path.exists(f'{A.WORK}/obxd.src.raw') else None
            if src:
                extra += ['--input', A.W(src)]
        if kind == 'midifx':
            si = A.STANDIN_SYNTH
            extra += ['--synth', A.W(A.DM[si]['so']), A.W(A.DM[si]['dir']), A.defaults(si)]
        t0 = time.time()
        try:
            rc, err = A.docker(['render', kind, f"{A.install_path(i)}/{os.path.basename(e['so'])}", A.install_path(i),
                                A.defaults(i), A.W(sp), A.W(raw), str(SECS), *extra], mods=[i], timeout=300)
        except subprocess.TimeoutExpired:
            rc, err = 'timeout', ''
        wall = time.time() - t0
        run = {'iter': it, 'rc': rc, 'wall': round(wall, 2)}
        if rc == 9 or rc == 'timeout' or 'TIMEOUT' in (err or ''):
            findings.append({'kind': 'timeout', 'iter': it})
        elif rc not in (0, '0'):
            findings.append({'kind': 'crash', 'iter': it, 'rc': rc, 'detail': (err or '')[-160:]})
        else:
            a = analyse(raw) or {}
            run.update(a)
            if a.get('clip', 0) > 0.01:
                findings.append({'kind': 'clip', 'iter': it, 'ratio': round(a['clip'], 3)})
            if a.get('dc', 0) > 0.05:
                findings.append({'kind': 'dc', 'iter': it, 'dc': round(a['dc'], 3)})
            m = re.search(r'RENDER_MS ([\d.]+) AUDIO_MS ([\d.]+)', err or '')
            if m and float(m.group(1)) > 0.5 * float(m.group(2)):   # DSP loop alone, not start-up
                findings.append({'kind': 'slow', 'iter': it, 'realtime_x': round(float(m.group(1)) / float(m.group(2)), 2)})
            tr = []
            if os.path.exists(trp):
                for line in open(trp):
                    try: tr.append(json.loads(line))
                    except Exception: pass
            speaks = {}   # key -> 'name' | 'index', learned from what the module reports
            for fr in tr:
                for k, v in fr.items():
                    if k == 'f' or k in speaks: continue
                    speaks[k] = 'index' if str(v).strip().lstrip('-').isdigit() else 'name'
            for w in written:
                if w['kind'] not in ('ok', 'index', 'name'):
                    continue
                if w['type'] == 'enum' and w['kind'] in ('index', 'name') and speaks.get(w['key']) and speaks[w['key']] != w['kind']:
                    continue   # the other wire convention: the host would never send it
                r = reflected(w, tr)
                if r is False:
                    findings.append({'kind': 'write-ignored', 'iter': it, 'key': w['key'], 'value': w['value'], 'how': w['kind']})
        runs.append(run)
        for p in (raw, trp):
            if os.path.exists(p): os.remove(p)
    if kind == 'synth' and all(r.get('peak', 0) < 30 for r in runs if r.get('rc') in (0, '0')) and any(r.get('rc') in (0, '0') for r in runs):
        findings.append({'kind': 'silent'})
    # collapse repeated write-ignored on the same key
    seen, uniq = set(), []
    for f in findings:
        k = (f['kind'], f.get('key'), f.get('how'))
        if k in seen and f['kind'] == 'write-ignored':
            continue
        seen.add(k); uniq.append(f)
    return i, {'kind': kind, 'runs': runs, 'findings': uniq}


if __name__ == '__main__':
    args = sys.argv[1:]
    iters = 3
    if '--iters' in args:
        iters = int(args[args.index('--iters') + 1]); args = [a for a in args if a not in ('--iters', str(iters))]
    ids = args or list(contracts)
    report = {}
    with cf.ThreadPoolExecutor(6) as ex:
        for i, r in ex.map(lambda x: fuzz(x, iters), ids):
            report[i] = r
            fs = r.get('findings') or []
            if fs:
                print(i, ', '.join(sorted({f['kind'] for f in fs})), flush=True)
    json.dump(report, open(f'{OUT}/report.json', 'w'), indent=1)
    lines = ['# DSP fuzz report', '', f'{len(ids)} modules, {iters} random scores each, {SECS:.0f} s per render.', '']
    by = {}
    for i, r in report.items():
        for f in r.get('findings') or []:
            by.setdefault(f['kind'], []).append((i, f))
    for k in sorted(by):
        lines.append(f'## {k} ({len({i for i, _ in by[k]})} modules)')
        for i, f in by[k][:200]:
            lines.append(f"- {i}: {json.dumps({x: y for x, y in f.items() if x != 'kind'})}")
        lines.append('')
    open(f'{OUT}/report.md', 'w').write('\n'.join(lines))
    print('report:', f'{OUT}/report.md')
