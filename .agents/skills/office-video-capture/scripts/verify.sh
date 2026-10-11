#!/bin/bash
# verify.sh <video.mp4> [t1,t2,...]  — checks a finished render before anyone sees it.
#
# Prints the streams and duration, integrated loudness and true peak (aim for about -16 to -14 LUFS
# and a peak under -1 dBTP for social feeds), and tiles frames at the given times (default: 16
# evenly spaced) into <video>-check.jpg, in time order, to look at.
set -e
V="$1"; TIMES="$2"
[ -f "$V" ] || { echo "usage: verify.sh <video.mp4> [t1,t2,...]" >&2; exit 2; }
ffprobe -v error -show_entries stream=codec_name,width,height,r_frame_rate,sample_rate,channels -show_entries format=duration,bit_rate -of compact "$V"
ffmpeg -hide_banner -nostats -i "$V" -af ebur128=peak=true -f null - 2>&1 | grep -E '^\s+(I:|LRA:|Peak:)'
dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$V")
[ -n "$TIMES" ] || TIMES=$(python3 -c "d=$dur; print(','.join(f'{(i+0.5)*d/16:.2f}' for i in range(16)))")
tmp=$(mktemp -d)
i=0
for t in ${TIMES//,/ }; do
  ffmpeg -v error -y -ss "$t" -i "$V" -frames:v 1 -vf scale=480:-1 "$tmp/$(printf '%03d' $i).png"
  i=$((i + 1))
done
cols=4; rows=$(( (i + cols - 1) / cols ))
out="${V%.*}-check.jpg"
ffmpeg -v error -y -framerate 1 -i "$tmp/%03d.png" -filter_complex "tile=${cols}x${rows}" -frames:v 1 "$out"
rm -rf "$tmp"
echo "frames at $TIMES -> $out"
