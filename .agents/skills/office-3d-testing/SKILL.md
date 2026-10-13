---
name: office-3d-testing
description: Test, verify or screenshot the Droid Office 3D UI (the three.js office in the browser) through its `window.office` automation API instead of steering with WASD and E. Use whenever a change to `src/client/` (world, ui, main.ts, automation.ts), the WebSocket protocol, or anything the office page shows needs checking in the running office, or when asked to QA, reproduce a bug, test acceptance criteria or capture screenshots in the 3D office.
---

# Testing the 3D office

Every office tab exposes `window.office`. It walks or teleports you to desks, boards and places, presses keys at them, opens ☰ menu windows, rides the elevator, sets the camera and returns JSON state for assertions. Use it for every check in the 3D UI; never steer by hand with keys or mouse drags.

The full command reference lives in [docs/guide.md, "Automation API"](../../../docs/guide.md#automation-api-windowoffice) and the code in `src/client/automation.ts`.

## 1. Build and start a clone of the owner's office

Test on a copy of the owner's real install, made and started by [`office-clone`](../office-clone/SKILL.md): their floors and repositories, Factory account, decor, Whiteboards and browser settings, with nobody at the desks. Never test on invented, mocked or seeded data or an empty throwaway office, and never against the owner's own office (the Mac app or `npm run dev` on :4600): commands move their player and open windows on their screen.

```bash
npm run build                                          # the clone runs this checkout's dist/
.agents/skills/office-clone/scripts/clone-office.sh    # prints T, e.g. /tmp/office-clone-Kk3x
$T/start.sh                                            # fireAndForget; port 4677 or the next free one
```

- Start `start.sh` as a background process (fireAndForget). A process backgrounded with `&` inside a one-off shell dies when that shell exits.
- `start.sh` sets `HOME` to the clone's. The office always adds a Home floor at the home directory, and the owner's real one holds their workers. Never start an office on the owner's own folders.
- Rebuild and restart `start.sh` after every source change.

## 2. Run a check: `office-run.mjs`

Drive the clone with [`office-clone`](../office-clone/SKILL.md)'s runner. Each run launches its own headless browser with GPU WebGL, opens the clone as the owner (their profile and settings, no character picker), waits until the office is in and its warm-up is done, runs a steps file and closes the browser. Nothing stays open between commands, so nothing goes stale.

```bash
node .agents/skills/office-clone/scripts/office-run.mjs $T steps.mjs --out /tmp/shots
```

Don't hold an `agent-browser` session open for checks. When its daemon dies, the next command quietly starts a headless Chrome for Testing, which closes the page (`about:blank`) about 30 seconds in. That, not WebGL, is why such sessions kept dropping.

## 3. Drive it

Every command except `state()`, `list()` and `commands()` returns a promise. It resolves with a `state()` snapshot once the action has finished, and rejects with an `Error` that says why. `await` every command, including `closeAll()`. A steps file gets `js` (runs a function in the page), `open`, `click`, `shot`, `waitFor`, `sleep`, `rig`, `reload`, `log` and Playwright's `page`:

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
| `office.goTo(target, {walk?, timeout?})` | Desk id (`desk-3`), `station-*`, worker id or name, desk label, board agent name, board or place kind (`issues`, `pulls`, `actions`, `coffee`, `elevator`, `gong`, `jukebox`, `bookshelf`, `tv`, `ladder`, `bar`, `dj`), floor id or name, `roof`. `{walk: true}` walks the office paths instead of teleporting |
| `office.interact(key = 'E')` | Presses E, P, R, X, B, C or O at the `goTo` target, or else at the nearest thing in reach. E at a worker opens its terminal |
| `office.open(id)` | Runs a ☰ menu command (`issues`, `pulls`, `pipelines`, `search`, `elevator`, `roof`, `decor`, `settings`, `phone`, `help`, `upgrade`, `waiting`) |
| `office.commands()` | Those commands, with whether each is offered here and why one is blocked |
| `office.closeAll()` | Closes every open window |
| `office.ride(floor)` | Elevator to a floor id or name, or `roof` |
| `office.camera(preset)` | `first`, a fixed level pose looking straight ahead, so screenshots compare between runs |
| `office.state()` | Floor, position, facing, seat, `using` (what E would use), `modals` (open windows by label), `terminal`, `workers`, `floors` |

Assert on `state()` JSON. Use screenshots for what JSON cannot show (a mesh, a layout, a color): `await js(() => window.office.camera('first'))`, then `await shot('first')`.

### Without a browser driver

The server runs the same commands in the office tab opened last (a phone never counts). A tab still has to be open (a run of `office-run.mjs` in progress, say), so this complements the runner rather than replacing it:

```bash
curl -s -X POST http://127.0.0.1:4677/api/automation -H 'content-type: application/json' \
  -d '{"cmd":"goTo","args":["desk-3"],"timeout":30000}'
# 200 {"ok":true,"value":{…state…}} · 422 {"ok":false,"error":"…"} · 409 no tab open · 504 no answer in time
```

### Input the API doesn't cover

Some behaviour lives between `goTo` targets: walking into furniture, turning, jumping, the fire pole, the sidearm and its spells. To test those, call `rig()` in the steps file to load the movement rig from [`office-choreography`](../office-choreography/SKILL.md). Then script the input with `__walkTo`, `__look`, `__hold` and `__tap`, and assert on `state()` afterwards:

```js
export default async ({ rig, js, sleep, log }) => {
  await rig();
  await js(async () => { await window.office.goTo('elevator'); await window.__walkTo(8.3, -3); await window.__walkTo(6.8, -0.7); window.__tap('KeyE', 'e'); });
  await sleep(6000);
  log(JSON.stringify(await js(() => window.office.state().floor)));
};
```

For video proof of a fix (a PR, a bug repro), record the same steps with [`office-video-capture`](../office-video-capture/SKILL.md)'s `rec.sh`.

## 4. Pitfalls

- **A step waits on something slow** (a cloud worker's turn, a build). Use `waitFor(fn, arg, timeoutMs)` on `state()` and give the run a long enough command timeout. Wait for the change you caused (`working`, then `done`), not just the end state, which may already hold before it starts.
- **Walking from inside the elevator car gets stuck** ("Stuck on the way to …"). Teleport first (`goTo` without `walk`), then walk from there.
- **The player faces the wrong way, or the page looks stale after a rebuild.** Restart the test office and reload the tab. Do not debug it from the client.
- **The character picker is up.** The clone has no `local-storage.json` (clone-office.sh couldn't read the Mac app's storage). Re-clone, or pick a character in the steps.
- **A new feature does not show up.** A new ☰ menu entry or interactable kind appears in `commands()` or `list()` by itself. A new way to move the player needs a method on `AutomationHost` in `src/client/main.ts`.

## 5. Clean up

Stop everything you started, and only that. A floor's PTY host keeps running after the office stops while it still has live terminals.

```bash
kill <start.sh pid>
lsof -t "$T"/home/.droid-office/pty.sock "$T"/floors/*/.droid-office/pty.sock 2>/dev/null | xargs kill 2>/dev/null
rm -rf "$T"
```

Never kill a `droid-office-ptys` process whose socket is outside `$T`. Those hosts serve the owner's own office and its workers. Delete anything the check made in the owner's Factory account or on GitHub (see `office-clone`).
