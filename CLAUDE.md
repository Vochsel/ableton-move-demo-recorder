@AGENTS.md

## Claude Code specifics

Skills in `.claude/skills/`, which load automatically when a task matches:

- **record-move-demo**: record one module, a list, or the catalog, end to end, including publishing.
- **write-demo-recipe**: work out how a module should be played and shown, and write `data/recipes/<id>.json`.
- **audit-move-demos**: the visual audit. It fans out subagents over contact sheets plus each module's docs and merges their recipes.
- **triage-module-findings**: run the fuzzers and audit, separate real bugs from harness artifacts, and write findings for authors.

Long steps (`mdr catalog`, `mdr data --all`, `mdr render --all`) take tens of minutes to hours. Run them in the background and check their logs (`build/log-*.txt`, `build/render_all.log`); don't poll with sleeps.

When reviewing outputs, look at the images. `build/audit/sheets/<id>.png` shows six frames with captions; the Read tool shows it.
