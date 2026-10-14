# The catalog run (2026-10-14)

All 158 modules of the Schwung catalog were recorded on an M1 Pro (10 cores, Docker on aarch64).

```bash
bin/mdr setup && bin/mdr catalog && bin/mdr samples
bin/mdr data --all                       # ~45 min
bin/mdr fuzz --iters 3 && bin/mdr fuzz-ui && bin/mdr audit
bin/mdr sheets                           # then the audit-move-demos skill: 3 reviewers × ~53 modules
bin/mdr review-apply && bin/mdr data $(cat build/audit/changed.txt)
bin/mdr render --all --publish           # ~25 min per batch of 25 (3D ≈ 50 s/module)
```

## Results

- **Audio:** 145 of 158 modules load headless. The rest are UI-only tools, overtakes and modules with no DSP.
- **Stand-ins:** 14 modules play stand-ins because they need things a headless run can't provide (ROMs, network streams, user kits), or because they're silent for reasons still open with their authors.
- **Screen:** 108 modules use Schwung's knob grid (with their own widgets), 50 their own UI code. 147 contracts came from live DSP probes.
- **Visual audit:** 71 good, 52 fixed with recipes, 35 limitations. The verdicts are in `data/audit/`.
- **Fuzzing:** 2 modules crash under random input, 1 more under a specific gesture, and 1 widget hangs on garbage values. See `runs/2026-10-14-catalog-findings.md`.

The recipes written along the way, by hand and by the audit, are in `data/recipes/`. Mestela's modules got hand-written recipes after his feedback that the generic demos misrepresented them; that feedback is what led to live DSP traces, the screen-choice rules and recipes.
