---
name: audit-move-demos
description: Visually audit recorded Move module demos against each module's own documentation using parallel subagents, then merge their suggested recipes. Use after `mdr data` on many modules, or when asked to check whether demos are correct.
---

# Visual audit of demos

The automated audit (`bin/mdr audit`) can't tell whether a demo shows a module doing its thing. This one can: reviewers look at each contact sheet next to the module's README.

## 1. Prepare

```bash
bin/mdr sheets                   # build/audit/sheets/<id>.png
bin/mdr audit                    # build/audit/report.json
bin/mdr docs                     # build/audit/docs/<id>.md: README + help.json + current recipe
```

Split the ids into batches of ~50 (`build/audit/batch<N>.txt`).

## 2. Fan out reviewers

Launch one subagent per batch, in parallel and in the background, with this brief (fill in N):

> For each module id in build/audit/batch<N>.txt, Read build/audit/sheets/<id>.png (6 OLED frames across the 12 s loop, each captioned with the knob being turned and nearby notes), build/audit/docs/<id>.md, build/score/<id>.json (`play`, `role` — standin means silent headless, `screen`, `segs`) and its entry in build/audit/report.json. Judge whether the demo fairly shows the module working. Wrong things look like: an effect bypassed or at 0 mix, knobs turned on disabled sections, notes that don't suit it (chords into a mono synth), a MIDI FX fed the wrong input, "no file"/"loading"/browser screens, static screens, or anything that contradicts the docs. Write one JSON line per module to build/audit/review<N>.jsonl: {"id","verdict":"good|fixable|limitation","problems":[...],"recipe":{...}|null,"note"}. limitation = needs a ROM, network, hardware or user files. For fixable, give a recipe per docs/RECIPES.md using only keys and page names you can see in the score, segs or docs; 1–2 audible turns per page; never volume, preset, browse, trigger or learn. Read every image.

## 3. Merge and re-run

```bash
bin/mdr review-apply                 # validates keys and pages; prints changed ids; skips "locked" recipes
bin/mdr data $(python3 -c "import json;print(' '.join(json.load(open('build/audit/applied.json'))['changed']))")
bin/mdr sheets <changed ids>         # spot-check a sample of them
```

Reviewers guess some keys (taken from on-screen labels). `review-apply` drops the ones that don't exist and reports them; fix those by hand with the write-demo-recipe skill. Keep the verdicts: `cp build/audit/review*.jsonl data/audit/`.
