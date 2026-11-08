---
name: office-3d-testing
description: Drive and assert on the Droid Office 3D scene through its `window.office` automation API (goTo, interact, open, ride, camera, state) in place of WASD, E and mouse drags. Use to check a change to `src/client/` (world, ui, main.ts, automation.ts), the WebSocket protocol or anything the office page shows; to reproduce a bug or test acceptance criteria in the 3D office; or to screenshot it.
---

# Testing the 3D office

Every office tab exposes `window.office`. It walks or teleports you to desks, boards and places, presses keys at them, opens ☰ menu windows, rides the elevator, sets the camera, and returns JSON state for assertions. Use it for scene navigation and state, and Playwright for HTML controls; both are deterministic where steering by hand is not.

The full command reference is [docs/guide/development.md, "Automation API"](../../../docs/guide/development.md#automation-api-windowoffice), and the code is `src/client/automation.ts`.

## 1. Pick the office

- **A clone of the owner's office** is the default. Build, clone and start it with [`office-clone`](../office-clone/SKILL.md) (sections 1 and 2), and run each check with its `office-run.mjs` (section 3), which also covers the native Electron (`--source`) and native desktop (`--desktop`) variants.
- **The owner's own office** on :4600 is fine to drive too, through the HTTP API below or their open tab. It acts on their screen: commands move their player and open windows there. `office-run.mjs` refuses :4600, so it never gets there by accident.

## 2. Drive it

Every command except `state()`, `list()` and `commands()` returns a promise that resolves with a `state()` snapshot once the action has finished, or rejects with an `Error` that says why. `await` every command, `closeAll()` included. A steps file gets `js` (runs a function in the page), `open`, `click`, `shot`, `waitFor`, `sleep`, `rig`, `reload`, `log` and Playwright's `page`:

```js
// steps.mjs
export default async ({ js, shot, log }) => {
  await js(() => window.office.goTo('issues'));          // teleport in front of the Issues board, facing it
  const s = await js(() => window.office.interact());    // E: the board opens
  if (s.modals[0]?.label !== 'Issues board') throw new Error(JSON.stringify(s.modals));
  await shot('issues');
  await js(() => window.office.closeAll());
  await js(() => window.office.ride('Home'));            // resolves when the doors open on Home
  log(JSON.stringify(await js(() => window.office.state().floor)));
};
```

| Command | Use |
| --- | --- |
| `office.list()` | Every target `goTo` accepts here: `{id, kind, label, worker?}` |
| `office.goTo(target, {walk?, timeout?})` | Desk id (`desk-3`), worker id or name, desk label, board or place kind (`issues`, `pulls`, `actions`, `coffee`, `elevator`, `gong`, `jukebox`, `bookshelf`, `tv`, `ladder`, `bar`, `dj`), floor id or name, `roof`. `{walk: true}` walks the office paths instead of teleporting |
| `office.interact(key = 'E')` | Presses E, P, R, X, B, C or O at the `goTo` target, or else at the nearest thing in reach. E at a worker opens its terminal |
| `office.open(id)` | Runs a ☰ menu command (`issues`, `pulls`, `pipelines`, `search`, `elevator`, `roof`, `decor`, `settings`, `phone`, `help`, `upgrade`, `waiting`) |
| `office.commands()` | Those commands, with whether each is offered here and why one is blocked |
| `office.closeAll()` | Closes every open window |
| `office.ride(floor)` | Elevator to a floor id or name, or `roof` |
| `office.camera(preset)` | `first`, a fixed level pose looking straight ahead, so screenshots compare between runs |
| `office.state()` | Floor, position, facing, seat, `using` (what E would use), `modals` (open windows by label), `terminal`, `workers`, `floors` |

Assert on `state()` JSON. Screenshots are for what JSON cannot show (a mesh, a layout, a colour): `await js(() => window.office.camera('first'))`, then `await shot('first')`.

### Over HTTP

The server runs the same commands in the office tab opened last (a phone never counts). A tab must be open (a run of `office-run.mjs` in progress, or the owner's own tab), so this complements the runner:

```bash
curl -s -X POST http://127.0.0.1:4677/api/automation -H 'content-type: application/json' \
  -d '{"cmd":"goTo","args":["desk-3"],"timeout":30000}'
# 200 {"ok":true,"value":{…state…}} · 422 {"ok":false,"error":"…"} · 409 no tab open · 504 no answer in time
```

### Input between targets

Walking into furniture, turning, jumping, climbing, the sidearm and its spells all happen between `goTo` targets. Call `rig()` in the steps file to load the movement rig from [`office-choreography`](../office-choreography/SKILL.md), script the input with `__walkTo`, `__look`, `__hold` and `__tap`, and assert on `state()` afterwards:

```js
export default async ({ rig, js, sleep, log }) => {
  await rig();
  await js(async () => { await window.office.goTo('ladder'); window.__tap('KeyE', 'e'); await window.__hold(['KeyW'], 1000); });
  await sleep(500);
  log(JSON.stringify(await js(() => window.office.state())));
};
```

For video proof of a fix (a PR, a bug repro), record the same steps with [`office-video-capture`](../office-video-capture/SKILL.md)'s `rec.sh`.

## 3. Pitfalls

- **A step waits on something slow** (a cloud worker's turn, a build). Use `waitFor(fn, arg, timeoutMs)` on `state()` with a long enough command timeout, and wait for the change you caused (`working`, then `done`): the end state may already hold before your action starts.
- **Walking from inside the elevator car gets stuck** ("Stuck on the way to …"). Teleport first (`goTo` without `walk`), then walk from there.
- **The player faces the wrong way, or the page looks stale after a rebuild.** Restart the office and reload the tab before debugging the client.
- **The character picker is up.** The clone has no `local-storage.json` (clone-office.sh couldn't read the Mac app's storage). Re-clone, or pick a character in the steps.
- **A new feature does not show up.** A new ☰ menu entry or interactable kind appears in `commands()` or `list()` by itself; a new way to move the player needs a method on `AutomationHost` in `src/client/main.ts`.

## 4. Clean up

Follow [`office-clone`](../office-clone/SKILL.md) section 5: stop `start.sh` and the clone's PTY hosts, remove `$T`, and delete anything the check made in the owner's Factory account or on GitHub.
