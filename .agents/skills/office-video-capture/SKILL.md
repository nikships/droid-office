---
name: office-video-capture
description: Record 30/60 fps MP4 takes of the Droid Office 3D scene from scripted choreography moves, verify frame uniqueness on contact sheets, and cut GIFs, PR proof clips, or voiced HyperFrames videos.
---

# Recording the office

Wraps [`office-choreography`](../office-choreography/SKILL.md) moves in `agent-browser record`: boot the headed `office-rig` session first (`office-choreography/scripts/boot.sh`), and stage busy desks when needed with [`office-demo-staging`](../office-demo-staging/SKILL.md).

**Capture scope:** Captures the 3D scene page (`agent-browser` + `office-rig.js`). Use [`office-clone`'s `desktop` helper](../office-clone/references/native-desktop.md) for native macOS window stills and AX checks (`agent-desktop` captures stills only, not video), and native display recorders for Metal/HDR presentation proof.

## 1. Record takes

```bash
R=.agents/skills/office-choreography/scripts; V=.agents/skills/office-video-capture/scripts
export CAPTURE_DIR=~/videos/my-demo && mkdir -p "$CAPTURE_DIR" && cd "$CAPTURE_DIR"
$R/run.sh $R/moves/board-pan.setup.js && agent-browser screenshot "$PWD/frame.png"   # preview framing
MOVE_ARG=computers FPS=60 $V/rec.sh b-computers $R/moves/board-pan.setup.js $R/moves/board-pan.js
$V/sheet.sh clips/b-computers.mp4 3 6
```

`rec.sh <name> <setup> <action>` hides side panels (`CLEAN=0` keeps them), runs `<setup>` off camera, records while `<action>` runs (ending with `__sleep` for edit handles), and stops the recorder on exit even if `<action>` throws. Consult [`references/shot-recipes.md`](references/shot-recipes.md) for proven setups, durations and usable ranges.

- **FPS**: use `FPS=60` for camera moves intended for half-speed playback and `FPS=30` otherwise; verify `#warmup.on` is gone and `document.getElementById('fps').textContent` reads ~60 before rolling (`boot.sh` sets `?pace=full`).
- **One-way actions**: dry-run aim (`__aim`) without pressing `E` (`Q` returns a carried card) before recording a take that mutates state.
- **Worker status flips**: record with `moves/hold.js` (`MOVE_ARG=<ms>`) while polling `office-demo-staging/scripts/wait-status.sh` from a second shell.

## 2. Audit contact sheets

`sheet.sh <clip> [rate] [cols]` writes `sheets/<clip>.png` (1 tile per `1/rate` s) and prints unique frame counts. Re-record any moving shot with repeated-frame stutter (~50% unique at 60 fps means `?pace=full` was missing; static holds repeat frames normally). Confirm every sheet shows clean geometry, only approved terminals/workers, wand-only sidearm footage (never the .44 Magnum), and no stray toasts or HUD, then log each take's usable timestamp range.

## 3. Cut and verify

- **Quick clip, PR proof or GIF**: trim with `ffmpeg` (`-ss`/`-t`, `setpts=2*PTS` for half-speed 60 fps dollies; `fps=15,scale=960:-1` + palette for GIFs).
- **Voiced HyperFrames video**: follow [`references/making-a-video.md`](references/making-a-video.md) and the worked composition in [`references/example-launch/`](references/example-launch/).
- **Final check**: run `scripts/verify.sh <mp4>` and confirm expected video/audio streams, loudness, peak and contact sheet.

## 4. Clean up

Run `agent-browser close`, tear down any staged demo items with `office-demo-staging/scripts/cleanup.sh`, and retain `CAPTURE_DIR` until editing finishes. Done when `verify.sh` passes on the output file, the browser session is closed, and staged workers/issues are cleaned up.
