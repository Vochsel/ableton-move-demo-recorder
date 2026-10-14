#!/bin/bash
# render_all.sh [ids...] — video half: flat + 3D renders, mux, posters, R2 upload, manifest, deploy.
# Data (scores, audio, films) must already be built by run_data.sh.
ROOT=${MDR_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
PUBLISH=${MDR_PUBLISH:-0}
BUCKET=${MDR_BUCKET:-}; PUB=${MDR_PUBLIC_URL:-}
if [ "$PUBLISH" = 1 ] && { [ -z "$BUCKET" ] || [ -z "$PUB" ]; }; then echo "publishing needs MDR_BUCKET and MDR_PUBLIC_URL (publish.bucket / publish.publicUrl in mdr.config.json)"; exit 1; fi
cd $ROOT
if [ $# -eq 0 ]; then set -- $(python3 -c "import json;print(' '.join(m['id'] for m in json.load(open('data/contracts.json'))))"); fi
ALL=("$@")
put() { npx wrangler r2 object put "$BUCKET/$2" --file "$1" --content-type "$3" --cache-control "public, max-age=86400" --remote > /dev/null 2>&1 && echo "  up $2" || echo "  UPLOAD FAILED $2"; }
export -f put; export BUCKET
for ((b=0; b<${#ALL[@]}; b+=25)); do
  IDS=("${ALL[@]:b:25}")
  echo "== batch $((b/25+1)): ${IDS[*]}"
  python3 -c "import json,sys; json.dump([{'moduleId':i,'name':i} for i in sys.argv[1:]], open('build/rows-r.json','w'))" "${IDS[@]}"
  (cd compositions/flat && npx hyperframes@0.8.155 render --batch $ROOT/build/rows-r.json --output "$ROOT/out/raw-flat/{name}.mp4" --quality high 2>&1 | grep -E "Batch complete|failed" )
  (cd compositions/move3d && npx hyperframes@0.8.155 render --batch $ROOT/build/rows-r.json --output "$ROOT/out/raw-3d/{name}.mp4" --quality high 2>&1 | grep -E "Batch complete|failed" )
  pipeline/finalize.sh "${IDS[@]}" > /dev/null
  mkdir -p out/posters
  for id in "${IDS[@]}"; do
    ffmpeg -loglevel error -y -ss 7.1 -i out/3d/schwung-$id-3d.mp4 -frames:v 1 -vf scale=960:-1 -q:v 3 out/posters/$id-3d.jpg
    ffmpeg -loglevel error -y -ss 4.5 -i out/flat/schwung-$id.mp4 -frames:v 1 -vf scale=960:-1 -q:v 3 out/posters/$id.jpg
  done
  for id in "${IDS[@]}"; do
    echo "out/flat/schwung-$id.mp4 v2/$id.mp4 video/mp4"
    echo "out/3d/schwung-$id-3d.mp4 v2/$id-3d.mp4 video/mp4"
    echo "out/posters/$id.jpg v2/$id.jpg image/jpeg"
    echo "out/posters/$id-3d.jpg v2/$id-3d.jpg image/jpeg"
  done > build/uploads.txt
  if [ "$PUBLISH" = 1 ]; then
    xargs -P 4 -n 3 bash -c 'put "$0" "$1" "$2"' < build/uploads.txt | grep -c "  up" | sed 's/^/  uploaded: /'
    python3 pipeline/manifest.py "$PUB"
    [ -n "$MDR_VERCEL_SCOPE" ] && (cd site && vercel deploy --prod --yes --scope "$MDR_VERCEL_SCOPE" > /dev/null 2>&1 && echo "== site redeployed")
  fi
done
echo "== ALL RENDERED"
