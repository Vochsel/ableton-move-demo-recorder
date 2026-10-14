#!/bin/bash
# run_data.sh [ids...] — the data half of the pipeline (no video): plan, probe, score,
# real-DSP audio + per-frame trace, grid films, module-UI films.
ROOT=${MDR_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
cd $ROOT
if [ $# -eq 0 ]; then set -- $(python3 -c "import json;print(' '.join(m['id'] for m in json.load(open('data/contracts.json'))))"); fi
echo "== data for $# modules"
node pipeline/demo.mjs plan "$@" > build/log-plan.txt 2>&1
python3 pipeline/audio.py probe "$@" > build/log-probe.txt 2>&1
node pipeline/demo.mjs score "$@" > build/log-score.txt 2>&1
python3 pipeline/audio.py render "$@" > build/log-audio.txt 2>&1
node pipeline/demo.mjs film "$@" > build/log-film.txt 2>&1
UI=$(python3 -c "
import json,sys
ids=set(sys.argv[1:])
print(' '.join(m['id'] for m in json.load(open('data/contracts.json')) if m['screen']=='module-ui' and m['id'] in ids))" "$@")
[ -n "$UI" ] && node pipeline/film_custom.mjs --trace $UI > build/log-film-ui.txt 2>&1
echo "== data done"
