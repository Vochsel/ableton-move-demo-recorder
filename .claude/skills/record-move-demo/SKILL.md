---
name: record-move-demo
description: Record demo videos of Schwung modules for Ableton Move (one module, a list, or the whole catalog), from setup through data, render and optional publishing to R2 + the Vercel gallery. Use when asked to record, re-record, render or publish Move/Schwung module demos.
---

# Record Move module demos

`bin/mdr` drives everything. Read `docs/ARCHITECTURE.md` if anything below is unclear.

## 1. Make sure the workspace is ready

```bash
bin/mdr doctor
```

- `ref/schwung` or the `schost` image is missing → `bin/mdr setup`
- `data/contracts.json` is missing → `bin/mdr catalog` (about 15 min; run it in the background)
- the module is a sampler (granny, mrsample, mrdrums, slicer, sfz, dr32) and `build/samplelib` is missing → `bin/mdr samples`

A module that isn't in the catalog yet: add its entry to `data/module-catalog.json` (the same shape as Schwung's `module-catalog.json`), then re-run `bin/mdr catalog`.

## 2. Build the data and look before rendering

```bash
bin/mdr data <ids>
bin/mdr sheets <ids>          # build/audit/sheets/<id>.png
bin/mdr audit                 # build/audit/report.md
```

Open every sheet with the Read tool. A demo is good when the screen shows the module working and the turned knobs make an obvious difference. Signs it isn't:

- the effect is bypassed or its mix is 0
- a "no file", "loading" or browser screen
- the screen is static
- turns on disabled sections
- `stand-in-audio` in the audit for a module that should make sound

If it isn't good, use the **write-demo-recipe** skill, then repeat this step.

## 3. Render

```bash
bin/mdr record <ids>                       # local: out/flat/schwung-<id>.mp4, out/3d/schwung-<id>-3d.mp4
bin/mdr render <ids> --publish             # render + upload + gallery deploy (needs publish config)
bin/mdr publish                            # repair pass: re-uploads anything that failed
```

The 3D version takes about 50 s per module; the flat one about 12 s. For more than a few modules, run in the background and watch `build/render_all.log`.

## 4. Report honestly

For each module, say whether the audio is its own DSP or stand-ins (`build/audio/report.json`), and list any audit findings left. Check one output with ffprobe: 12.000 s, 1920×1080, AAC at 64 kHz.
