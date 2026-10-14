#!/usr/bin/env bash
# check.sh — fast static checks (what CI runs): syntax of every script and recipe.
set -euo pipefail
cd "$(dirname "$0")/.."
fail=0
for f in pipeline/*.py; do python3 -m py_compile "$f" || fail=1; done
for f in bin/mdr pipeline/*.mjs pipeline/custom/*.mjs compositions/flat/lib/*.js; do node --check "$f" 2>/dev/null || { [[ $f == *.mjs || $f == bin/mdr ]] && node --input-type=module --check < "$f" || fail=1; }; done
for f in pipeline/*.sh scripts/*.sh; do bash -n "$f" || fail=1; done
for f in data/recipes/*.json; do python3 -c "
import json,sys
d=json.load(open('$f'))
allowed={'note','locked','play','notes','part','pages','turns','fullscreen','set','automation','jog','padGate'}
bad=set(d)-allowed
assert not bad, f'unknown recipe fields {bad}'
assert d.get('play') in (None,'drums','mono','poly','groove','single','plucks','held','none'), 'bad play'
for t in d.get('turns',[]): assert 'key' in t, 'turn without key'
" || { echo "bad recipe: $f"; fail=1; }; done
[ $fail = 0 ] && echo "all checks passed" || { echo "checks failed"; exit 1; }
