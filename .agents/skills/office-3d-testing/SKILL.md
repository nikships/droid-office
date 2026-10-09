---
name: office-3d-testing
description: Test, verify or screenshot the Droid Office 3D UI (the three.js office in the browser) through its `window.office` automation API instead of steering with WASD and E. Use whenever a change to `src/client/` (world, ui, main.ts, automation.ts), the WebSocket protocol, or anything the office page shows needs checking in the running office, or when asked to QA, reproduce a bug, test acceptance criteria or capture screenshots in the 3D office.
---

# Testing the 3D office

Every office tab exposes `window.office`. It walks or teleports you to desks, boards and places, presses keys at them, opens ☰ menu windows, rides the elevator, sets the camera and returns JSON state for assertions. Use it for every check in the 3D UI; never steer by hand with keys or mouse drags.

The full command reference lives in [docs/guide.md, "Automation API"](../../../docs/guide.md#automation-api-windowoffice) and the code in `src/client/automation.ts`.

## 1. Build and start an isolated test office

`node bin/droid-office.js` serves `dist/`, so build after every source change. Never test against the owner's own office (the Mac app or `npm run dev` on :4600): commands move their player and open windows on their screen.

```bash
npm run build
T=$(mktemp -d /tmp/office-test-XXXX)
mkdir -p "$T/proj" "$T/home" && git -C "$T/proj" init -q
HOME="$T/home" node bin/droid-office.js "$T/proj" --port 4677 --host 127.0.0.1 --projects "$T" --weather clear
```

- Start the last command as a background process (fireAndForget). A process backgrounded with `&` inside a one-off shell dies when that shell exits.
- `HOME="$T/home"` is required. The office always adds a Home floor at the home directory, and that floor's `.droid-office/` holds the owner's real workers. Without the override the test office resumes their real sessions in a new PTY host that outlives the test.
- Pick a free port (`lsof -nP -iTCP:4677 -sTCP:LISTEN` prints nothing). `--host 127.0.0.1` keeps it off the LAN. `--weather clear` keeps screenshots comparable.
- The office has two floors, `proj` and `Home`. Boards are empty because the temp repository has no GitHub remote. Hired workers would run under the temp HOME without the owner's droid login, so test with UI, boards, places and floors, not real agent work.

## 2. Open it in a browser session

Use agent-browser in its own named session, **headed**. Headless Chromium uses software WebGL and drops the page to `about:blank` after about 20 seconds.

```bash
export AGENT_BROWSER_SESSION=office-test
agent-browser --headed open http://127.0.0.1:4677/
# A new profile shows the character picker first; save a profile and reload to skip it.
agent-browser eval "localStorage.setItem('droid-office.profile', JSON.stringify({name:'Tester',color:'#4f86f7',look:{}})); location.reload(); 'ok'"
agent-browser wait --fn "window.office && office.state().floor && office.state().player.controls"
```

Playwright works the same way: `page.evaluate(() => window.office.goTo('issues'))`.

## 3. Drive it

Every command except `state()`, `list()` and `commands()` returns a promise. It resolves with a `state()` snapshot once the action has finished, and rejects with an `Error` that says why. `await` every command, including `closeAll()`. Run async scripts through `eval --stdin`:

```bash
cat <<'EOF' | agent-browser eval --stdin
(async () => {
  const o = window.office;
  await o.goTo('issues');               // teleport in front of the Issues board, facing it
  const s = await o.interact();         // E: the board opens
  if (s.modals[0]?.label !== 'Issues board') throw new Error(JSON.stringify(s.modals));
  await o.closeAll();
  await o.ride('Home');                 // resolves when the doors open on Home
  return JSON.stringify(o.state().floor);
})()
EOF
```

| Command | Use |
| --- | --- |
| `office.list()` | Every target `goTo` accepts here: `{id, kind, label, worker?}` |
| `office.goTo(target, {walk?, timeout?})` | Desk id (`desk-3`), `station-*`, worker id or name, desk label, board agent name, board or place kind (`issues`, `pulls`, `queue`, `services`, `coffee`, `elevator`, `meeting`, `gong`, `jukebox`, `cabinet`, `bookshelf`, `tv`, `smoke`, `ladder`, `bar`, `dj`), floor id or name, `roof`. `{walk: true}` walks the office paths instead of teleporting |
| `office.interact(key = 'E')` | Presses E, P, R, X, B, C or O at the `goTo` target, or else at the nearest thing in reach. E at a worker opens its terminal |
| `office.open(id)` | Runs a ☰ menu command (`issues`, `pulls`, `queue`, `services`, `meeting`, `search`, `elevator`, `roof`, `decor`, `settings`, `phone`, `help`, `upgrade`, `waiting`) |
| `office.commands()` | Those commands, with whether each is offered here and why one is blocked |
| `office.closeAll()` | Closes every open window |
| `office.ride(floor)` | Elevator to a floor id or name, or `roof` |
| `office.camera(preset)` | `first`, a fixed level pose looking straight ahead, so screenshots compare between runs |
| `office.state()` | Floor, position, facing, seat, `using` (what E would use), `modals` (open windows by label), `terminal`, `workers`, `floors` |

Assert on `state()` JSON. Use screenshots for what JSON cannot show (a mesh, a layout, a color):

```bash
agent-browser eval "office.camera('first').then(() => 'ok')"
agent-browser screenshot /tmp/office-first.png
```

### Without a browser driver

The server runs the same commands in the office tab opened last (a phone never counts). A tab still has to be open, so this complements the browser session rather than replacing it:

```bash
curl -s -X POST http://127.0.0.1:4677/api/automation -H 'content-type: application/json' \
  -d '{"cmd":"goTo","args":["desk-3"],"timeout":30000}'
# 200 {"ok":true,"value":{…state…}} · 422 {"ok":false,"error":"…"} · 409 no tab open · 504 no answer in time
```

## 4. Pitfalls

- **A long eval drops the connection.** Keep each `eval` short (a few commands, not a whole tour), or start the work and poll `office.state()` from later evals.
- **Walking from inside the elevator car gets stuck** ("Stuck on the way to …"). Teleport first (`goTo` without `walk`), then walk from there.
- **The player faces the wrong way, or the page looks stale after a rebuild.** Restart the test office and reload the tab. Do not debug it from the client.
- **The character picker or a loading screen is still up.** `state().floor` is null until you are in. Wait for it as in step 2.
- **A new feature does not show up.** A new ☰ menu entry or interactable kind appears in `commands()` or `list()` by itself. A new way to move the player needs a method on `AutomationHost` in `src/client/main.ts`.

## 5. Clean up

Stop everything you started, and only that. A floor's PTY host keeps running after the office stops while it still has live terminals.

```bash
agent-browser --session office-test close
kill <office pid>
lsof -t "$T/proj/.droid-office/pty.sock" "$T/home/.droid-office/pty.sock" 2>/dev/null | xargs kill 2>/dev/null
rm -rf "$T"
```

Never kill a `droid-office-ptys` process whose socket is outside `$T`. Those hosts serve the owner's own office and its workers.
