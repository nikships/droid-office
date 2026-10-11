---
name: office-video-capture
description: Record smooth video of the Droid Office 3D office — demo clips, B-roll, README GIFs, social posts, bug repros or PR video proof. Records 30/60 fps MP4 takes of scripted moves from a headed agent-browser session, reviews them with contact sheets and a stutter check, and covers turning takes into a finished, voiced video with HyperFrames. Use when asked to record, film, screen-capture or make a video or clip of the office or a feature in it.
---

# Recording the office

Recording builds on [`office-choreography`](../office-choreography/SKILL.md): a take is a choreography move with a recorder wrapped round it. Boot that session first (`office-choreography/scripts/boot.sh`). For a busy office with real work in it, stage it with [`office-demo-staging`](../office-demo-staging/SKILL.md).

## 1. Record a take

```bash
R=.agents/skills/office-choreography/scripts; V=.agents/skills/office-video-capture/scripts
export CAPTURE_DIR=~/videos/my-demo && mkdir -p "$CAPTURE_DIR" && cd "$CAPTURE_DIR"
$R/run.sh $R/moves/board-pan.setup.js && agent-browser screenshot "$PWD/frame.png"   # frame it, look
MOVE_ARG=computers FPS=60 $V/rec.sh b-computers $R/moves/board-pan.setup.js $R/moves/board-pan.js
$V/sheet.sh clips/b-computers.mp4 3 6
```

`rec.sh <name> <setup> <action>` does the following:
- Hides the side panels (`CLEAN=0` keeps them).
- Runs the setup off camera.
- Records while the action runs, and always stops the recorder, even when the action fails.

The action decides how long the take is, so end it with an `__sleep` to leave a tail to cut on.

- **FPS.** Use 60 for camera moves that will play slowed down (half speed reads as a dolly). Use 30 for everything else. The recorder captures 60 distinct frames a second at 1920×1080, but only if the tab draws them. `boot.sh` opens the tab at `?pace=full`, so it never drops to the office's idle pace (about 5 FPS after 30 s of stillness) or stops while covered. Check `document.getElementById('fps').textContent` before a long or static take.
- **Dry-run anything that can miss.** For example, aim at a card without the final E. Then put the scene back (Q puts a card back) and record. A missed take after a real hire can't be redone.
- **Stills.** `agent-browser screenshot <path>`.
- **Long waits.** A take that waits on a worker (confetti, a needs-input jump) records with `moves/hold.js` and a long `MOVE_ARG`. Watch for the status flip from a second shell with `wait-status.sh`, not from inside the page.

`references/shot-recipes.md` lists the takes that worked, with their FPS, lengths and usable ranges.

## 2. Review every take

`sheet.sh <clip> [rate] [cols]` writes `sheets/<clip>.png`, one tile every 1/rate seconds, and prints how many frames are unique. On a moving shot, many repeated frames mean a stutter, so re-record rather than patch it in the edit. About half unique at 60 fps means the tab was idling, which `?pace=full` fixes. A static shot repeats frames normally. Look at each sheet for:
- a toast, a dialog or the HUD you didn't want;
- the camera clipping into furniture;
- a private terminal or a worker the owner didn't want shown;
- the .44 Magnum (never show it).

Note each clip's usable range ("confetti at 4–6 s") while it is fresh.

## 3. Use the takes

- **A quick clip, GIF or PR proof.** Trim it with ffmpeg (`-ss`/`-t`, `setpts=2*PTS` for half speed). For a GIF, use `fps=15,scale=960:-1` with a palette.
- **A finished video** with captions, a voiceover and music: follow `references/making-a-video.md`, which builds on the `hyperframes` skills. `references/example-launch/` is a complete worked example.
- **Check any final file** with `scripts/verify.sh <mp4>`. It prints the streams, the loudness and the peak, and writes a frame sheet.

## 4. Clean up

Run `agent-browser close`. Keep `CAPTURE_DIR` (clips, sheets, your move scripts) until the edit is done. Tear down staged workers and issues with `office-demo-staging/scripts/cleanup.sh`.
