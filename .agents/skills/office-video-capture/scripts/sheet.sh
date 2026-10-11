#!/bin/bash
# sheet.sh <clip.mp4> [frames-per-second=2] [columns=5]  — contact sheet + smoothness check.
#
# Writes sheets/<clip>.png (tiles left to right, top to bottom, at the given rate; frame k is at
# k/fps seconds) and prints duration, fps and how many frames were unique. A recording with many
# repeated frames stutters; re-record it rather than smoothing it in the edit.
# The ffmpeg on this machine may lack drawtext, so tiles carry no timecode: count them.
set -e
source "$(dirname "$0")/../../office-choreography/scripts/env.sh"
CLIP="$1"; RATE="${2:-2}"; COLS="${3:-5}"
[ -f "$CLIP" ] || { echo "usage: sheet.sh <clip.mp4> [fps] [cols]" >&2; exit 2; }
mkdir -p "$CAPTURE_DIR/sheets"
base=$(basename "${CLIP%.*}")
dur=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$CLIP")
fps=$(ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of default=nw=1:nk=1 "$CLIP")
n=$(python3 -c "print(max(1, round(float('$dur') * float('$RATE'))))")
rows=$(( (n + COLS - 1) / COLS ))
ffmpeg -v error -y -i "$CLIP" -vf "fps=$RATE,scale=384:-1,tile=${COLS}x${rows}" -frames:v 1 "$CAPTURE_DIR/sheets/$base.png"
total=$(ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=nb_read_frames -of default=nw=1:nk=1 "$CLIP")
unique=$(ffmpeg -i "$CLIP" -vf mpdecimate -f null - 2>&1 | grep -Eo 'frame= *[0-9]+' | tail -1 | grep -Eo '[0-9]+')
echo "$base: ${dur}s @ $fps, $unique/$total unique frames, $n tiles (${COLS} per row, 1/${RATE}s apart) -> $CAPTURE_DIR/sheets/$base.png"
