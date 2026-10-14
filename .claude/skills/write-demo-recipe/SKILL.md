---
name: write-demo-recipe
description: Work out how a Schwung/Move module should be played and shown in its demo and write data/recipes/<id>.json — which notes, pages, knob turns, starting values, jog/automation gestures or fullscreen canvas. Use when a module's demo looks wrong, inactive or misrepresents what it does, or when a module author gives feedback on their demo.
---

# Write a demo recipe

The schema is in `docs/RECIPES.md`; the examples in `data/recipes/` are a good model (mestela's modules, the samplers).

## 1. Understand the module

```bash
bin/mdr recipe <id>          # current recipe, planner pages/keys, last score
```

- **The docs:** `bin/mdr docs <id>`, then read `build/audit/docs/<id>.md` (README + help.json + current recipe).
- **Keys you may use:** `build/plan/<id>.trace.txt`. Values the DSP reports are in `build/probe/<id>.json` and `build/trace/<id>.jsonl`, which also tell you whether enums are names or indices.
- **What it does with input:** notes, clock, line input, or nothing. Is it driven by its own UI (jog, pads, a full-screen canvas)? Look for `ui_chain.js`, `canvas.js` or `canvas_script` in the module folder (`data/dsp-map.json` → `dir`).

## 2. Decide what a 12 s loop should show

One idea, shown clearly:

- **Input:** feed it what it expects (single triggers, held chords, a beat, plucks), or nothing if it runs off clock.
- **Setup:** switch it on in `set` (mix up, not bypassed, the needed mode, a sample path from `/data/UserData/UserLibrary/Samples/Schwung Demo/`).
- **Turns:** 1–2 knobs per page that make an obvious audible or visible difference. Never volume, preset, browse, trigger, learn or randomize.
- **Gestures:** if the module's own UI makes it work (scratching, a held cut), reproduce what that UI writes with `automation`, `jog`, `padGate` and `fullscreen`. Read the UI script to see which parameters it sets.

## 3. Verify

```bash
bin/mdr data <id> && bin/mdr sheets <id>
grep "^<id> " build/log-audio.txt          # "ok peak=…" = own DSP; "stand-in" = silent headless
```

Look at the sheet. Check that turned keys move in the trace: `python3 pipeline/audit.py`, looking for `turn-ignored`. Set `"locked": true` on a hand-tuned recipe so automated reviews don't overwrite it.

## When a recipe can't fix it

Some modules need a ROM, a network stream, external hardware or user files. Say so in the recipe's `note`, and add the module to `data/findings-notes.md` if it's a question for its author.
