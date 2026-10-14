#!/bin/bash
# fetch_module_json.sh — each catalog module's module.json from its GitHub repo -> data/module-json/
ROOT=${MDR_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
cd $ROOT
mkdir -p data/module-json
python3 -c "
import json
for m in json.load(open('data/module-catalog.json'))['modules']:
    print(m['id'], m['github_repo'], m.get('default_branch','main'))
" | xargs -P 12 -n 3 sh -c '
out=data/module-json/$0.json
[ -s $out ] && exit 0
gh api "repos/$1/contents/module.json?ref=$2" --jq .content 2>/dev/null | base64 -d > $out 2>/dev/null
if ! python3 -c "import json,sys;json.load(open(\"$out\"))" 2>/dev/null; then
  p=$(gh api "repos/$1/git/trees/$2?recursive=1" --jq ".tree[].path" 2>/dev/null | grep -E "(^|/)module.json$" | grep -v test | head -1)
  if [ -n "$p" ]; then gh api "repos/$1/contents/$p?ref=$2" --jq .content | base64 -d > $out; else rm -f $out; echo MISSING $0 $1; fi
fi'
