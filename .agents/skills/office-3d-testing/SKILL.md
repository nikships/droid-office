---
name: office-3d-testing
description: Drive and assert on the Droid Office 3D scene via `window.office` (`goTo`, `interact`, `open`, `ride`, `camera`, `state`) and `/api/automation`. Use when verifying `src/client/` or protocol changes, reproducing scene bugs, or capturing deterministic 3D screenshots.
---

# Testing the 3D office

Every office tab exposes `window.office` (`src/client/automation.ts`; full spec in [docs/guide/development.md](../../../docs/guide/development.md#automation-api-windowoffice)). Use `window.office` for deterministic scene navigation and state assertions, and Playwright for HTML controls.

## 1. Pick the office

- **Clone (default)**: build, clone and start via [`office-clone`](../office-clone/SKILL.md) (sections 1–2), then drive with `office-run.mjs` (section 3, including `--source` and `--desktop` for native Electron/AX).
- **Owner's live office (`:4600`)**: drive via `/api/automation` or their open tab when asked (`office-run.mjs` refuses `:4600`; commands move the owner's live camera and modals).

## 2. Drive and assert

Action methods (`goTo`, `interact`, `open`, `closeAll`, `ride`, `teleport`, `camera`, `height`) and `presenterStats()` return promises; `await` every one (`closeAll()` included). Inspection methods (`state()`, `list()`, `commands()`, `visits()`, `frameStats()`) are synchronous. Assert on `state()` JSON, and pair visual checks with `await js(() => window.office.camera('first'))` before `shot()`:

```js
// steps.mjs
export default async ({ js, shot, log }) => {
  await js(() => window.office.goTo('issues'));
  const s = await js(() => window.office.interact());    // E opens the Issues board
  if (s.modals[0]?.label !== 'Issues board') throw new Error(JSON.stringify(s.modals));
  await shot('issues');
  await js(() => window.office.closeAll());
  await js(() => window.office.ride('Home'));            // resolves once doors open on Home
  log(JSON.stringify(await js(() => window.office.state().floor)));
};
```

| Command | Behavior |
| --- | --- |
| `office.list()` | Live `goTo` targets on the current floor: `{id, kind, label, deskId?, worker?, here?}` |
| `office.goTo(target, {walk?, timeout?})` | Moves to a `list()` id (`desk-3`, `issues`, `pulls`, `actions`, `ci`, `whiteboard`, `computers`, `elevator`, `gong`, `jukebox`, `bookshelf`, `ladder`, `orchestrator`, or a bot id), worker id/name, desk label, floor id/name, or `roof` (`{walk: true}` pathfinds instead of teleporting) |
| `office.interact(key = 'E')` | Presses `E`, `P`, `R`, `X`, `B`, `C` or `O` at the `goTo` target or nearest spot (`E`: worker terminal, board, Orchestrator prompt, bot card, ladder dismount; `O`: Orchestrator terminal; `X`: Stop/dismiss) |
| `office.open(id)` / `office.commands()` | Runs or lists ☰ menu commands (`issues`, `pulls`, `pipelines`, `ci`, `whiteboard`, `computers`, `environments`, `search`, `autowiki`, `elevator`, `roof`, `decor`, `settings`, `welcome`, `phone`, `companion`, `help`, `upgrade`, `orchestrator`, `waiting`) with availability reasons |
| `office.closeAll()` | Closes all open windows |
| `office.ride(floor)` / `office.teleport(floor)` | Elevator ride (including `roof`) vs instant floor switch keeping pose (numbered floors only) |
| `office.camera('first')` / `office.height(scale)` | Level straight-ahead camera preset for repeatable shots; smooth eye-height scale (`1`–`3`) |
| `office.state()` / `office.visits()` | Scene snapshot (`floor`, `player`, `using`, `modals`, `terminal`, `workers`, `floors`, `agents`) and active worker visit steps/poses |
| `office.frameStats({reset?})` / `office.presenterStats({reset?, samples?})` | Drawn pacing and CPU/GPU pass times; Mac Metal presenter counters (`null` in browser) |

### Over HTTP

Relay commands to the most recently opened non-phone office tab:

```bash
curl -s -X POST http://127.0.0.1:4677/api/automation -H 'content-type: application/json' \
  -d '{"cmd":"goTo","args":["desk-3"],"timeout":30000}'
# 200 {"ok":true,"value":{…}} · 422 {"ok":false,"error":"…"} · 409 no tab · 504 timeout
```

### Input between targets

For collisions, turns, jumping, climbing or sidearm/wand input between `goTo` spots, load [`office-choreography`](../office-choreography/SKILL.md) via `await rig()`, drive with `__walkTo`, `__look`, `__hold` and `__tap`, then assert on `state()` (record video proof with [`office-video-capture`](../office-video-capture/SKILL.md)'s `rec.sh`):

```js
export default async ({ rig, js, sleep, log }) => {
  await rig();
  await js(async () => { await window.office.goTo('ladder'); window.__tap('KeyE', 'e'); await window.__hold(['KeyW'], 1000); });
  await sleep(500);
  log(JSON.stringify(await js(() => window.office.state())));
};
```

## 3. Pitfalls

- **Slow async transitions** (cloud turns, builds): use `waitFor(fn, arg, timeoutMs)` on `state()` and observe the transition (`working` then `done`) rather than asserting only the end state, which may already hold beforehand.
- **Elevator exits**: teleport out of the car (`goTo` without `walk`) before calling `{walk: true}` to avoid `"Stuck on the way to …"`.
- **Stale pose or bundle**: rebuild, restart `start.sh`, and reload the tab before debugging client state.
- **Character picker blocking load**: `$T/local-storage.json` was missing; re-clone or submit the picker in steps.
- **Extensibility**: new ☰ menu items and interactables surface in `commands()` and `list()` automatically; wire new player movement modes onto `AutomationHost` in `src/client/main.ts`.

## 4. Clean up

Run [`office-clone`](../office-clone/SKILL.md) section 5 cleanup. The check is complete when `state()` assertions pass, `camera('first')` screenshots match any visual change, the clone and its PTY hosts are stopped, `$T` is removed, and any external test artifacts are deleted.
