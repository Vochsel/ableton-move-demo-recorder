# AGENTS.md

Instructions for coding agents working in this repo. Humans: start with README.md.

## What this is

A pipeline that records demo videos of Schwung modules (add-on synths, effects, MIDI effects and tools for the Ableton Move) without a Move. The module's real DSP runs headless; its real screen is drawn from the DSP's own state; two HyperFrames compositions render the video. `bin/mdr` wraps every step. `docs/ARCHITECTURE.md` is the map; read it before changing the pipeline.

## The one rule

**Nothing on screen or in the audio may be invented when the real thing is available.**

- Audio comes from the module's `dsp.so`. Stand-ins (`obxd`, `8w8`) are used only when the module is silent headless, and the gallery says so.
- Screen values come from the DSP trace (`build/trace/<id>.jsonl`). A key the DSP never answered stays unanswered, so the widget draws its real "no answer" state; never substitute a fake.
- Which screen is shown is decided the way Schwung decides it (see "Screen choice"). Never just pick the grid.
- Pads, knobs and audio come from one score (`build/score/<id>.json`). Never animate one without the other.

## Commands

```bash
bin/mdr doctor                    # environment check
bin/mdr record <id>               # data + both videos, local only
bin/mdr data <id> && bin/mdr sheets <id>   # quick iteration: no video render, look at build/audit/sheets/<id>.png
bin/mdr fuzz <id> --iters 3       # DSP fuzz one module
node pipeline/fuzz_ui.mjs --one quilt     # UI fuzz one module, prints JSON
```

Every script takes ids as arguments; with none, it runs on the whole catalog.

## Invariants that broke before (don't regress)

- **Screen choice.** The DSP's live `ui_hierarchy` wins. For audio FX and MIDI FX, the chain host serves `module.json`'s `ui_hierarchy` first, then the plugin's. For sound generators it asks the plugin only. A hierarchy means the knob grid. No hierarchy plus `ui_chain.js` means the module's own screen. Tools and overtakes always use their own `ui.js`. This is implemented in `pipeline/build_contracts.py` from `build/contract/<id>.json`.
- **Wait for loading.** Some modules (Surge, MiniJV, Osirus) answer nothing until loaded. The probe in `host.c` keeps rendering for up to ~15 s until every key has answered once.
- **Apply recipe `set` values before probing.** Resting values must be read after setup, or every knob turn returns to a pre-setup value. This silenced sfz.
- **Enum wire format.** Learn it from what the module reports (`param_format.mjs`'s `learnEnumWireFormat`). Some modules take option names, some take indices; writing the other form is silently ignored.
- **Child template keys.** `sample` on a pad level means `p01_sample`; resolve with `child_key.mjs`. This applies to the plan, score and film.
- **Canvas scripts may be ES modules** with imports relative to their on-device path (`modules/<cat>/<id>/../../../shared`). Load them as modules from the mirror in `build/esm/`.
- **MIDI FX need transport start (`0xFA`) through `process_midi`**, as well as the clock. Audio FX get MIDI only if they declare `capabilities.midi_in`; older audio-FX v2 structs don't have an `on_midi` field, so calling it is a segfault.
- **Absolute on-device paths.** Modules are mounted at `/data/UserData/schwung/modules/<cat>/<id>`, plus the paths in `audio.py` `EXTRA`/`EXTRA_ABS`. The sample library is at `/data/UserData/UserLibrary/Samples`.
- **Loops.** The score is rendered twice and the second pass kept, so tails wrap. AAC goes out at 64 kHz, because 12 s × 64000 is a whole number of AAC frames: no trailing silence, no click at the loop point. Knob turns sweep out and come back, and the screen returns to its first page. A film claims `loop: true` only if its first and last frames match; otherwise the compositions dissolve the last 0.5 s.
- **zsh.** Unquoted `$VAR` does not word-split in zsh. Use bash for the shell scripts (they are invoked via `bash`), or `${=VAR}`.

## Changing things

- **Pipeline step:** edit `pipeline/*`, then run `bin/mdr data <a few ids>` and look at the sheets before running everything.
- **Compositions:** `compositions/flat/index.html` and `compositions/move3d/index.html`. Shared code is in `compositions/flat/lib/` (`oled.js` for decoding/drawing and pad/step/knob state; `move3d.js` for the Move model built from Ableton's dimension drawing). Check with `cd compositions/flat && npx hyperframes@0.8.155 snapshot --at 0.5,6,11.9`.
- **Host:** `pipeline/host/host.c`, then `docker build -t schost pipeline/host`.
- **A module looks wrong:** write a recipe (`docs/RECIPES.md`) before you touch code. Most problems are what was played, not how it was drawn.

## Output conventions

- Videos: `out/flat/schwung-<id>.mp4` and `out/3d/schwung-<id>-3d.mp4`, 1920×1080, 30 fps, 12 s, H.264 CRF 20 + AAC 256k at 64 kHz.
- Report the real outcome. If a module fell back to stand-ins, or a check failed, say so. `build/audit/report.md` and `build/fuzz/*.md` are the record.
