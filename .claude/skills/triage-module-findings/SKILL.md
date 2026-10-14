---
name: triage-module-findings
description: Fuzz Schwung module DSPs and UI renderers, separate real module bugs from harness artifacts, bisect crashes/hangs to a minimal repro, and write findings for module authors. Use when asked to fuzz modules, check module robustness, or prepare a findings/bug report for module authors.
---

# Triage module findings

## 1. Run the checks

```bash
bin/mdr fuzz [ids] --iters 3      # build/fuzz/report.md   (DSP; ~10 min for the catalog)
bin/mdr fuzz-ui [ids]             # build/fuzz/ui-report.md (renderer + widgets)
bin/mdr audit                     # build/audit/report.md
```

Run long ones in the background. `docs/FUZZING.md` explains every kind.

## 2. Separate real bugs from artifacts

Before reporting anything, rule these out:

- **rc 127 or "no such file" from docker:** a mount hiccup. Re-run.
- **`slow`:** only the in-host `RENDER_MS` counts, never wall time.
- **`write-ignored`:** check the enum convention (names vs indices), step quantisation, clamping and display scale (a declared 0–1 range shown as 0–100). Read the trace before calling it a bug.
- **`canvas-load-throws` with `import`:** the fuzzer's plain-script loader. The film pipeline loads ES modules correctly.
- **`silent`:** expected for samplers without samples, line-input modules and tools.

Real are: `crash` (rc 139) that reproduces, `hang`, `throws` on normal values, clipping or DC offset on sane settings, and display bugs you can see in the sheets.

## 3. Bisect to a minimal repro

- **DSP crash:** re-run `build/fuzz/<id>.<iter>.score.txt` in the host (command in docs/FUZZING.md), then delete `V` lines key by key and `N` lines in halves until it stops crashing. If it only crashes with the full combination (a race), say so and keep the full score as the repro.
- **UI hang:** for each page and key, render with one garbage value under a timeout (`perl -e 'alarm 3; exec @ARGV' node …`). If no single key hangs, it's the module's widget (`canvas.js`): look for loops whose step comes from a value.

## 4. Write it up

Add hand-found details to `data/findings-notes.md` (one bullet per module, with the precise trigger and the repro path), then:

```bash
bin/mdr findings                  # build/FINDINGS.md
```

Be specific and modest: the findings come from a headless harness, not a Move, so frame them as leads to confirm on hardware.
