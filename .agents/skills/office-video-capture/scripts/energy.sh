#!/bin/bash
# energy.sh <audio> [window s=2]  — the loudness of a music bed, window by window ("t:dB").
#
# Shows where a generated track's drop, breakdown and ending really are, which rarely match the
# prompt: line the drop up with the voiceover's turn and cut or crossfade around a dip.
A="$1"; STEP="${2:-2}"
[ -f "$A" ] || { echo "usage: energy.sh <audio> [window s]" >&2; exit 2; }
dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$A")
echo "$(basename "$A") ${dur}s"
t=0
while python3 -c "import sys; sys.exit(0 if $t < $dur else 1)"; do
  v=$(ffmpeg -hide_banner -ss "$t" -t "$STEP" -i "$A" -af volumedetect -f null - 2>&1 | awk '/mean_volume/{print $5}')
  printf '%s:%s ' "$t" "$v"
  t=$(python3 -c "print(round($t + $STEP, 3))")
done
echo
