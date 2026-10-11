---
name: office-choreography
description: Script smooth first-person movement in the Droid Office 3D office from JavaScript, on top of `window.office` — eased camera pans and turns, walks that steer to a point, held and tapped keys, aiming the crosshair at a card or worker, and reusable move scripts (aisle walk, board pan, terminal, elevator, fire pole, arcade, rooftop, wand). Use whenever you need to move, look or press keys in the office beyond what `goTo`/`interact` give: driving a live demo, setting up a camera move for a recording, reproducing an input bug, or testing walking, climbing, the sidearm or the arcade.
---

# Scripting movement in the office

`window.office` jumps you to places and presses desk keys. For everything between those jumps, `scripts/office-rig.js` adds a movement rig to the office tab: eased turns and pans, walks that steer themselves, key holds and taps, and crosshair aiming. It works through the office's own drag-to-look and key handlers with synthetic events, so what you script is exactly what a player could do. The full `window.office` command list is in [`office-3d-testing`](../office-3d-testing/SKILL.md).

Related skills: [`office-video-capture`](../office-video-capture/SKILL.md) records these moves. [`office-demo-staging`](../office-demo-staging/SKILL.md) fills the office with demo work.

## 1. Open a session with the rig

```bash
R=.agents/skills/office-choreography/scripts
OFFICE_URL=http://127.0.0.1:4600 OFFICE_FLOOR=droid-office $R/boot.sh
```

`boot.sh` does the following:
- Opens the office headed at 1920×1080 in agent-browser session `office-rig`, at `?pace=full`. That flag keeps this one tab drawing every frame. Without it, the office drops to about 5 FPS after 30 s of stillness and stops while its window is covered, which makes moves stutter.
- Saves a profile, which skips the character picker.
- Sets the tab's worktree pref, so a hire from this tab never works in the owner's checkout.
- Waits until you are in, loads the rig, and rides to `OFFICE_FLOOR`.

Choose the office first:
- An **isolated test office** (`office-3d-testing` step 1) is safe for anything.
- The **owner's office** (:4600) has real workers and boards, but needs the owner's OK. Your tab has its own camera, but desk keys act on real workers.

`env.sh` (sourced by every script) forces headed mode and turns off agent-browser's idle shutdown. A headless relaunch drops the page to `about:blank`. **If an eval says `office is not defined`, rerun `boot.sh`.**

## 2. Move

Run moves with `run.sh`. It takes files or inline code, reloads the rig if a page reload cleared it, and sets `window.__arg` from `MOVE_ARG`:

```bash
$R/run.sh "(async()=>{ await office.goTo('desk-12'); await __walkTo(-6,9.6,{run:true}); return __look(Math.PI,-0.1,800) })()"
MOVE_ARG=gemdex $R/run.sh $R/moves/elevator-ride.setup.js $R/moves/elevator-ride.js
```

| Rig helper | Does |
| --- | --- |
| `__look(yaw, pitch, ms)` | Eased turn to an absolute yaw/pitch in radians (`null` keeps one) |
| `__pan(dx, dy, ms)` | Eased drag-look by pixels (0.005 rad per px) |
| `__yawTo(x, z)` | The yaw that faces a floor point |
| `__walkTo(x, z, {run, tol, pitch, maxMs})` | Holds W (and Shift), steering every frame, until within `tol` of the point or `maxMs` runs out |
| `__hold(['KeyW','ShiftLeft'], ms)` | Holds keys by `code` |
| `__tap('KeyE', 'e')` | One key press (`'Digit7'`, `'ArrowLeft'`, `'Space'`, `'Enter'` …) |
| `__aim('#153')` | Nudges the crosshair in a spiral until the `#hint` line contains the text. Resolves true or false |
| `__hint()` | What the crosshair is on, with the keys it offers |
| `__clean(on)` | Hide or show the side panels |
| `__sleep(ms)` / `__unlock()` | Wait. Release pointer lock (the camera helpers do it themselves) |

Write a move as one async IIFE that resolves with `JSON.stringify(office.state().player)` or similar, so every step reports where it ended up. Split a move into a **setup** (get into position) and an **action** (the motion itself), as `scripts/moves/*.js` do. Then the same action can be run live, recorded, or asserted on. `references/places-and-keys.md` has positions, facings and what every key does.

Rough to fine:
1. `office.goTo(target)` teleports, and `office.goTo(target, {walk: true})` walks the office paths.
2. `__walkTo` and `__look` frame the exact spot.
3. Read the position with `office.state().player` and copy the numbers into the move script.

## 3. Pitfalls

- **Low frame rate.** Read `document.getElementById('fps').textContent` (the rig hides the counter, but it still updates). It should say about 60 FPS. If it shows ~5, the tab was opened without `?pace=full`; rerun `boot.sh`.
- **Collisions are real.** `__walkTo` heads straight for the point, so a chair or plant in the way stops it until `maxMs` runs out. Route round obstacles with several short `__walkTo` calls.
- **Long evals drop the connection.** Keep each eval under ~30 s. To wait for something slow (a worker finishing), poll `office.state()` from the shell with short evals, as `office-demo-staging/scripts/wait-status.sh` does.
- **Pointer lock stops drag-to-look.** A real click (for example `agent-browser click` on a dialog button) can grab pointer lock. The rig's camera helpers release it first. To avoid it, click buttons from script (`button.click()` in an eval).
- **Keys do nothing while a window is open** (and while you type in a field). Run `await office.closeAll()` first. Esc closes the top window.
- **The sidearm can't come out on the roof or while climbing.** With nothing drawn, digits 1–6 play emotes instead of spells. Never script the .44 Magnum into a demo or a recording.
- **Walking out of the elevator car can stick** ("Stuck on the way to …"). Teleport with `goTo` first, then walk.
- **E means the real thing.** E with a carried card at a free desk hires a worker. X → SEND HOME fires one. Script those only on workers you staged.

## 4. Done

Run `agent-browser close`. The session never idles out on its own.
