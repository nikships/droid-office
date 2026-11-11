---
name: office-choreography
description: Choreograph first-person movement in the Droid Office 3D scene (`office-rig.js` eased pans/turns, steered walks, key holds/taps, crosshair aiming) between `window.office` targets. Use for camera moves, live demos, or testing walking, climbing, collisions and the sidearm.
---

# Scripting movement in the office

`scripts/office-rig.js` layers smooth first-person motion onto [`window.office`](../office-3d-testing/SKILL.md) via synthetic drag-to-look and key events on the office's own handlers. Pair with [`office-video-capture`](../office-video-capture/SKILL.md) to record takes and [`office-demo-staging`](../office-demo-staging/SKILL.md) to populate desks.

**Input scope:** Synthetic rig events test scene handlers and choreograph camera moves. Use [`office-clone`'s `desktop` helper](../office-clone/references/native-desktop.md) for native macOS AX checks, and request explicit owner permission with `agent-desktop-macos` for physical OS input (`agent-desktop key-down`/`key-up` are reserved no-ops, so key holds stay on the rig).

## 1. Boot the rig session

Target an [`office-clone`](../office-clone/SKILL.md) (`$T`, default) or `:4600` (where desk keys act on the owner's live workers):

```bash
R=.agents/skills/office-choreography/scripts
OFFICE_URL=http://127.0.0.1:4677 OFFICE_SETTINGS=$T/load-settings.js OFFICE_FLOOR=droid-office $R/boot.sh
```

`boot.sh` (with `env.sh` forcing headed mode and disabling idle daemon shutdown) opens a 1920×1080 headed `office-rig` session at `?pace=full` (preventing the 5 FPS idle drop after 30s or while covered), applies `OFFICE_SETTINGS` (skipping the character picker), sets `droid-office.worktree=1`, injects `office-rig.js`, and rides to `OFFICE_FLOOR`. Rerun `boot.sh` if an eval reports `office is not defined` or `document.getElementById('fps').textContent` drops to ~5 FPS.

## 2. Script moves

`run.sh` runs inline JS or move files, reloading the rig if the page refreshed and binding `MOVE_ARG` to `window.__arg`:

```bash
$R/run.sh "(async()=>{ await office.goTo('desk-12'); await __walkTo(-6,9.6,{run:true}); return __look(Math.PI,-0.1,800) })()"
MOVE_ARG=gemdex $R/run.sh $R/moves/elevator-ride.setup.js $R/moves/elevator-ride.js
```

| Helper | Behavior |
| --- | --- |
| `__look(yaw, pitch, ms)` | Eased turn to absolute radians (`null` preserves an axis) |
| `__pan(dx, dy, ms)` | Eased touch drag-look (`0.005` rad/px) |
| `__yawTo(x, z)` | Yaw facing floor coordinates `(x, z)` |
| `__walkTo(x, z, {run, tol, pitch, maxMs})` | Holds `KeyW` (+ `ShiftLeft` when `run`), steering per frame until within `tol` or `maxMs` |
| `__hold(codes, ms)` / `__tap(code, key)` | Hold `KeyboardEvent.code` array for `ms`, or tap once (`'KeyE'`, `'Digit7'`, `'Space'`) |
| `__aim(needle)` / `__hint()` | Spiral-nudge crosshair until `#hint` matches `needle` (`true`/`false`); read current `#hint` |
| `__clean(on)` | Hide (`true`) or restore (`false`) `aside.side` panels |
| `__sleep(ms)` / `__unlock()` | Pause `ms`; exit pointer lock (camera helpers call `__unlock()` automatically) |

Split reusable moves (`scripts/moves/*.js`) into **setup** (teleport via `office.goTo`, frame pose) and **action** (motion returning `JSON.stringify(office.state().player)`). Consult [`references/places-and-keys.md`](references/places-and-keys.md) for coordinates, facings and key bindings.

## 3. Pitfalls

- **Obstacles & elevator cars**: `__walkTo` steers straight-line against real colliders; chain short waypoints around furniture, and teleport out of the elevator (`goTo` without `walk`) before walking.
- **Eval timeouts (~30s)**: poll `office.state()` from the shell with short evals (`office-demo-staging/scripts/wait-status.sh`) instead of blocking inside one long eval.
- **Pointer lock & open modals**: click UI buttons via JS (`btn.click()`) rather than `agent-browser click` so pointer lock stays clear, and call `await office.closeAll()` before sending scene keys.
- **Sidearm & live desks**: digits `1`–`6` fire emotes when unarmed (rooftop and ladders stow the sidearm); use the wand rather than the .44 Magnum in demos and recordings. Trigger `E` (hire) and `X` (dismiss) only on workers you staged.

## 4. Close

Run `agent-browser close` when finished (the session disables idle timeout). Done when the `office-rig` browser session is closed and any staged workers are cleaned up.
