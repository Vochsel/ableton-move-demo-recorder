# Contributing

Thanks for helping. Most contributions fall into one of three kinds.

## 1. Module authors: make your module's demo right

Nobody knows how to show off your module better than you do. The quickest fix is a **recipe**, a small JSON file that says what to play, which pages and knobs to show, and any setup.

1. Look at the current demo in the [gallery](https://schwung-module-demos.vercel.app), or record it locally with `bin/mdr record <your-id>`.
2. Write or edit `data/recipes/<your-id>.json`; the schema and examples are in [docs/RECIPES.md](docs/RECIPES.md). `bin/mdr recipe <your-id>` lists the pages and keys you can use.
3. Check it: `bin/mdr data <your-id> && bin/mdr sheets <your-id>`, then look at `build/audit/sheets/<your-id>.png`.
4. Open a PR with `"locked": true` in the recipe, so automated reviews leave it alone.

No time to set it up? Open a "demo looks wrong" issue and describe how the module should be played. We'll write the recipe.

**If your module is silent headless**, `docs/runs/` and `build/FINDINGS.md` may have a question for you, such as a parameter that must be set or a file it expects at an absolute path. Mounting extra paths for your module is a one-line change in `pipeline/audio.py` (`EXTRA` / `EXTRA_ABS`).

**Fuzz findings** about your module are leads from a headless harness, not verdicts. Each one comes with a repro score; see [docs/FUZZING.md](docs/FUZZING.md).

## 2. Improve the recorder

- Read [AGENTS.md](AGENTS.md) for the invariants and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the map. The one rule: nothing on screen or in the audio may be invented when the real thing is available.
- Keep the scripts runnable on their own (`python3 pipeline/x.py ids…`), with `bin/mdr` as a thin wrapper.
- Before a PR, run `bash scripts/check.sh` and record a few varied modules (a synth, an FX, a MIDI FX, one with its own `ui_chain.js`). Look at the sheets.

## 3. Report a bug

Use the "Bug in the recorder" issue form and include `bin/mdr doctor` output.

## Style

Match the code around you. Comments say why, not what. Python and Node use the standard library only; the dependencies are Docker, ffmpeg and HyperFrames (via `npx`).

## Code of conduct

Be kind, assume good intent, and remember there's a person behind every module. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
