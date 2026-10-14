# Architecture

```
            catalog                       data (per module)                          video
 ┌──────────────────────────┐  ┌──────────────────────────────────────────┐  ┌──────────────────────┐
 │ module-catalog.json      │  │ plan  -> pages, keys to probe and trace  │  │ HyperFrames flat     │
 │ module.json (GitHub)     │  │ probe -> resting values (after setup)    │  │ HyperFrames move3d   │
 │ releases -> ref/rel/     │─▶│ score -> notes, knob turns, pad events   │─▶│ finalize: x264 + AAC │
 │ dsp map, load test       │  │ audio -> real DSP x2 + per-frame trace   │  │ posters, R2, gallery │
 │ live contract probe      │  │ film  -> OLED frames from the trace      │  └──────────────────────┘
 │ contracts.json (screen)  │  └──────────────────────────────────────────┘
 └──────────────────────────┘
```

Everything a module shows and plays comes from **one score** (`build/score/<id>.json`). The DSP hears it, the screen is drawn from what the DSP reports back, and the compositions light pads and turn knobs from it.

## Catalog (`mdr catalog`)

| step | script | output |
|---|---|---|
| catalog | curl `catalogUrl` | `data/module-catalog.json` |
| module.json per repo | `fetch_module_json.sh` | `data/module-json/<id>.json` |
| releases | `fetch_releases.py` (release.json → asset) | `ref/rel/<id>/x/…` |
| DSP map | `map_dsp.py` (`nm -D` for the entry points) | `data/dsp-map.json` |
| load test | `loadtest.py` (create an instance in the host) | `build/loadtest/result.json` |
| live contract | `audio.py contract` (`ui_hierarchy`, `chain_params`, `ui_pages` from the running DSP) | `build/contract/<id>.json` |
| binary contracts | `extract_so_contracts.py` (JSON embedded in a `.so`) | `data/so-contracts/` |
| contracts + screen | `build_contracts.py` | `data/contracts.json` |
| composition metadata | `gen_modules_js.py` | `compositions/flat/data/modules.js` |

**Screen choice** (`build_contracts.py`) copies the device's rules. For audio and MIDI FX, the chain host serves `module.json`'s `ui_hierarchy` first, then the plugin's; for sound generators, only the plugin's. If a hierarchy is served, Schwung shows the knob grid. If not, and there's a `ui_chain.js`, it runs the module's own screen. Tools and overtakes run their `ui.js`.

## The headless host (`pipeline/host/host.c`)

A C program built into the `schost` Docker image (Debian, aarch64). It `dlopen`s a module's `dsp.so` and drives it the way Schwung's chain does: 44.1 kHz, 128-frame blocks, `host_api_v1_t` callbacks (BPM 120, clock running, beat position), MIDI clock at 24 ppq plus transport start, and line input from a file.

- `probe <kind> <so> <dir> <defaults> <keys> <out.json> [sets]`: apply the recipe's `set` values, render until every key answers (up to ~15 s, for modules that load asynchronously), and write the values.
- `render <kind> … <score.txt> <out.raw> <secs> [--input raw] [--synth so dir defaults] [--notes out] [--trace keys out] [--fxmidi]`: play a sample-timed score (`N` MIDI, `V` set_param, `S` stand-in set_param). Optionally chain a MIDI FX into a stand-in synth and log its output notes. Optionally read every listed key back at each video frame of the second pass (the trace). Reports `RENDER_MS` for the DSP loop alone.

`kind` is `synth` (`move_plugin_init_v2/v1`), `fx` (`move_audio_fx_init_v2/v1`) or `midifx` (`move_midi_fx_init`). Modules are mounted at their on-device install path, `/data/UserData/schwung/modules/<cat>/<id>`, so absolute-path assets resolve. The sample library is at `/data/UserData/UserLibrary/Samples`.

## Data (`mdr data`, `pipeline/run_data.sh`)

1. **plan** (`demo.mjs plan`): pick up to 3 pages with Schwung's `planPages`, using the served hierarchy, or `ui_pages` for modules that draw their own screen. Write the keys to probe and every key to trace: contract keys, canvas and viz extra keys, resolved child template keys, and string literals from the module's UI scripts.
2. **probe** (`audio.py probe`): resting values, read after the recipe's setup.
3. **score** (`demo.mjs score`): 6 bars at 120 BPM. Notes come from the recipe or the module's role. Each page gets knob turns that sweep out and come back; values are formatted the way the module speaks (enum names or indices). The output includes pad events (on Move's default In-Key layout), knob events, jog and clicks.
4. **audio** (`audio.py render`): the module's DSP plays the score twice and the second pass is kept, so tails wrap. Effects process a source loop played on the stand-ins; MIDI FX drive a stand-in, and their real output notes become the pad events. If a module is silent, stand-ins replace it and the module is flagged. The output is loudness-normalised to −16 LUFS, exactly 12 s at 48 kHz, plus `build/trace/<id>.jsonl`.
5. **film**:
   - **Knob grid** (`demo.mjs film`): Schwung's `renderPageMovy` draws the page from that frame's traced values. The module's canvas scripts are registered (including ES modules), and full-screen canvases (`recipe.fullscreen`) are emulated after `shadow_ui.js`'s canvas runtime. A film claims `loop: true` only when its first and last frames match.
   - **Module UI** (`film_custom.mjs --trace`): the module's own `ui_chain.js`/`ui.js` runs in a mock QuickJS host (`pipeline/custom/`). Its parameter reads are served from the trace, and score events are fed in as Move MIDI.

## Video (`mdr render`, `pipeline/render_all.sh`)

Both compositions take a `moduleId` variable and are batch-rendered by HyperFrames.

- `compositions/flat`: module info, a pixel-grid OLED, 8 encoders, a 4×8 pad grid and 16 step LEDs.
- `compositions/move3d`: Three.js. The Move is built procedurally from Ableton's dimension drawing (`lib/move3d.js`). It renders with 2× supersampling, GTAO and light bloom; the camera follows a closed spline (5 s close on the screen with sliding glare, then out around the device and back).

`finalize.sh` re-encodes to H.264 CRF 20 and muxes the audio at 64 kHz AAC, so the loop has no gap. Posters are taken at fixed times. With `--publish`, files go to R2 under `v2/` and the gallery manifest is rebuilt.

## Quality tools

- `audit.py`: static, blank or frozen screens; loop seams; unanswered keys; ignored turns; stand-in audio; loudness.
- `fuzz.py`: random and extreme notes and parameter writes at every DSP. Flags crashes, timeouts, clipping, DC offset, a slow DSP loop, and writes never reflected back.
- `fuzz_ui.mjs`: every page of every grid module with normal, extreme and garbage values, plus the module's widgets, with a 60 s watchdog per module. Flags renderer exceptions, hangs, off-screen drawing and missing glyphs.
- `sheets.mjs` + the **audit-move-demos** skill: a visual review of each film against the module's README and help. Its recipes are merged by `apply_review.py`, which validates every key and page first.
- `findings.py`: all of the above as a report for module authors.

## Vendored libraries

`compositions/flat/vendor/` contains [three.js](https://threejs.org) r181 (MIT, see `vendor/three/LICENSE`): only the core build and the addons the 3D composition imports. It also contains [GSAP](https://gsap.com) 3.14 (free under its standard licence). Both are vendored so renders never depend on a CDN; a network blip once failed 11 renders mid-run.
