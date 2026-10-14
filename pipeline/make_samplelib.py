#!/usr/bin/env python3
"""make_samplelib.py — a small, licence-clean sample library for sampler modules,
rendered through the headless host from two real Schwung modules (drums from the
stand-in drum machine, keys/pad/SFZ from the stand-in synth):

  build/samplelib/Schwung Demo/*.wav   mounted at /data/UserData/UserLibrary/Samples
  build/sfzlib/Schwung Demo Keys/      mounted into the sfz module's instruments folder
"""
import os, subprocess, sys
ROOT = os.environ.get('MDR_ROOT') or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'pipeline'))
import audio as A
SR = 44100
lib = f'{ROOT}/build/samplelib/Schwung Demo'; sfz = f'{ROOT}/build/sfzlib/Schwung Demo Keys'
os.makedirs(lib, exist_ok=True); os.makedirs(sfz, exist_ok=True); os.makedirs(f'{ROOT}/build/samplelib/DR32', exist_ok=True)

def render(mod, notes, secs, out):
    sp = f'{A.WORK}/lib.score.txt'
    lines = []
    for t, dur, n, v in notes:
        lines.append((int(t * SR), f'N {int(t * SR)} 144 {n} {v}'))
        lines.append((int((t + dur) * SR), f'N {int((t + dur) * SR)} 128 {n} 0'))
    lines.sort(); open(sp, 'w').write('\n'.join(l for _, l in lines) + '\n')
    raw = f'{A.WORK}/lib.raw'
    e = A.DM[mod]
    A.docker(['render', 'synth', A.W(e['so']), A.W(e['dir']), A.defaults(mod), A.W(sp), A.W(raw), str(secs)])
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-f', 's16le', '-ar', '44100', '-ac', '2', '-i', raw,
                    '-af', 'silenceremove=start_periods=1:start_threshold=-60dB,afade=t=out:st=%.2f:d=0.05' % (secs - 0.06),
                    '-c:a', 'pcm_s16le', '-ar', '44100', out], check=True)

D, S = A.STANDIN_DRUM, A.STANDIN_SYNTH
for name, n in [('kick', 36), ('rim', 37), ('snare', 38), ('clap', 39), ('closed-hat', 42), ('low-tom', 45), ('open-hat', 46), ('high-tom', 50)]:
    render(D, [(0, 0.2, n, 115)], 1.2, f'{lib}/{name}.wav')
render(D, [(t * 0.125, 0.1, n, v) for t, n, v in [(0, 36, 120), (2, 42, 80), (4, 38, 110), (6, 42, 80), (7, 36, 100), (8, 36, 115), (10, 42, 80), (12, 38, 110), (14, 46, 90),
                                                (16, 36, 120), (18, 42, 80), (20, 38, 110), (22, 42, 80), (24, 36, 110), (26, 36, 100), (28, 38, 110), (29, 39, 90), (30, 46, 90), (31, 39, 90)]], 4.0, f'{lib}/break-120bpm.wav')
render(S, [(0, 3.5, n, 100) for n in (48, 55, 60, 63)], 4.5, f'{lib}/pad-chord.wav')
render(S, [(0, 1.4, 60, 100)], 2.0, f'{lib}/keys-C3.wav')
regions = []
for n in range(36, 97, 6):
    fn = f'keys-{n}.wav'; render(S, [(0, 1.6, n, 100)], 2.2, f'{sfz}/{fn}')
    regions.append(f'<region> sample={fn} pitch_keycenter={n} lokey={n - 3} hikey={n + 2}')
open(f'{sfz}/Schwung Demo Keys.sfz', 'w').write('<group> ampeg_release=0.4\n' + '\n'.join(regions) + '\n')
print('sample library:', sorted(os.listdir(lib)))
