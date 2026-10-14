# Fuzzing and auditing

Three tools, three questions:

| tool | question | output |
|---|---|---|
| `mdr fuzz` (`pipeline/fuzz.py`) | does the module's DSP survive arbitrary input, and does it honour its own contract? | `build/fuzz/report.{md,json}` |
| `mdr fuzz-ui` (`pipeline/fuzz_ui.mjs`) | does every page render (Schwung's renderer plus the module's widgets) for any value? | `build/fuzz/ui-report.{md,json}` |
| `mdr audit` (`pipeline/audit.py`) | does each demo show the module working? | `build/audit/report.{md,json}` |

## DSP fuzz

Per module, N random scores (`--iters`, default 3), each rendered twice for 4 s:

- **Notes:** anywhere in 24–96, lengths 20 ms to 1.5 s, velocities 1–127, some 3-note chords.
- **Parameter writes:** random keys from the module's own `chain_params`, at random, minimum, maximum, out-of-range and garbage values (`nan`, `1e30`, `abc`, empty). 30% are 12-step ramps. Enums are written both as index and as name.
- **Trace:** every written key is read back each frame.

| kind | meaning |
|---|---|
| `crash` | the host died with a signal (139 = SIGSEGV). Real, and worth reporting |
| `timeout` | the host hit its 240 s alarm |
| `slow` | the DSP loop alone ran at more than 0.5× real time (start-up excluded) |
| `silent` | a sound generator was silent through every run. Expected for samplers without samples and line-input modules |
| `clip` / `dc` | more than 1% of samples at full scale / a DC offset over 5% |
| `write-ignored` | an in-range write was never read back. Allowances are made for step, clamping, and the module's enum convention, learned from what it reports. Usually a contract quirk; verify before reporting |

**Reproducing a crash.** The score is kept at `build/fuzz/<id>.<iter>.score.txt`. Re-run it in the host (paths as in `pipeline/audio.py`):

```bash
docker run --rm -v $PWD:/w -v $PWD/ref/rel/<id>/x/<id>:/data/UserData/schwung/modules/<cat>/<id>:ro schost \
  schost render synth /data/UserData/schwung/modules/<cat>/<id>/dsp.so /data/UserData/schwung/modules/<cat>/<id> - \
  /w/build/fuzz/<id>.0.score.txt /w/build/fuzz/repro.raw 4
```

Then bisect by deleting lines from the score.

## UI fuzz

Every page of every knob-grid module, six value sets each: normal, extreme, garbage, then random mixes. A random knob is touched; the module's canvas widgets are loaded. Each module runs in its own process with a 60 s watchdog, so a widget that loops forever is reported as `hang`, not as a stalled run.

| kind | meaning |
|---|---|
| `hang` | a renderer or widget never returned. On a Move this freezes the shadow UI tick. Bisect with garbage values on single keys |
| `throws` / `throws-on-garbage` | an exception while drawing. The device disables a widget that throws |
| `draws-off-screen` | pixels outside 128×64, silently lost on the device. Usually only with garbage values |
| `missing-glyph` | a character the device font cannot draw |
| `canvas-load-throws` | a widget script failed to load |

## Demo audit

`audit.py` reads the data outputs: static screens, blank frames, freezes over 5 s, loop seams, page keys the DSP never answered, knob turns the DSP never reflected back, stand-in audio, and quiet output.

What it can't judge is whether the demo shows the module doing its thing. That's the **visual audit** (the `audit-move-demos` skill): `mdr sheets` plus each module's README and help text, reviewed by agents that write a verdict (`good` / `fixable` / `limitation`) and a recipe for each fixable module. `mdr review-apply` merges those recipes after checking every key and page exists.

## Findings

`mdr findings` turns all of it into `build/FINDINGS.md` for module authors. Hand investigation (bisected crashes, display bugs) goes in `data/findings-notes.md` and is appended. The catalog run's report is in `docs/runs/`.
