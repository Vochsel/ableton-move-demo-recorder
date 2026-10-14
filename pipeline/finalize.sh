#!/bin/bash
# finalize.sh <id>... — re-encode each render (x264 CRF 20) and mux its synced loop audio
# (build/audio/<id>.wav, 64 kHz AAC so 12 s is a whole number of AAC frames). 4 at a time.
ROOT=${MDR_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
one() {
  id=$1; v=$2
  src=$ROOT/out/raw-$v/$id.mp4
  dst=$ROOT/out/$v/schwung-$id.mp4; [ "$v" = 3d ] && dst=$ROOT/out/$v/schwung-$id-3d.mp4
  mkdir -p $ROOT/out/$v
  [ -f "$src" ] || { echo "missing $src"; return; }
  a=$ROOT/build/audio/$id.wav
  if [ -f "$a" ]; then
    ffmpeg -loglevel error -y -i "$src" -i "$a" -map 0:v -map 1:a -c:v libx264 -crf 20 -preset medium -pix_fmt yuv420p -af aresample=64000 -c:a aac -b:a 256k -t 12 -movflags +faststart "$dst"
  else
    ffmpeg -loglevel error -y -i "$src" -c:v libx264 -crf 20 -preset medium -pix_fmt yuv420p -movflags +faststart "$dst"
  fi
  echo "finalized $id $v"
}
export -f one; export ROOT
for id in "$@"; do echo "$id flat"; echo "$id 3d"; done | xargs -P 4 -n 2 bash -c 'one "$0" "$1"'
