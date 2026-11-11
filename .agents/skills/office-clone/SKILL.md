---
name: office-clone
description: Clone the owner's installed Droid Office and drive this checkout's build against it (`office-run.mjs`, headless WebGL or isolated native Electron/AX) without touching `:4600`. Use for running-office checks, bug repros, and PR screenshots.
---

# Testing on a clone of the owner's office

A clone copies the owner's installed office (floors, repositories, Factory and Jira connections, decor, Whiteboards and browser settings) into a scratch directory with empty desks, served by this checkout's `dist/`. Use it as the default target for running-office checks, bug repros, and PR screenshots or video.

## 1. Clone

Build this checkout first (`npm ci` or `npm run build`); `clone-office.sh` invokes `droid-office browser path` from `dist/`.

```bash
.agents/skills/office-clone/scripts/clone-office.sh          # prints $T, e.g. /tmp/office-clone-Kk3x
```

Source resolution order: `--office DIR`, `$DROID_OFFICE_HOME`, `officeDir` in `~/Library/Application Support/com.nikships.droid-office/settings.json`, then `~/droid-office`.

| Copied | Source |
| --- | --- |
| Office config (`factory.json`, `jira.json`, `floors.json`, `orchestrator.json` settings, prompts, subagent settings, theme, credits ledger, paired devices) | `<office>/.droid-office/` |
| Project floors as local `git clone`s keeping the real `origin` | each floor's checkout |
| Per-floor state (decor, jukebox, Whiteboard, team) and Home floor state | `<floor>/.droid-office/`, `~/.droid-office/` |
| Mac app browser settings (profile, graphics, per-desk models, active floor) | `localStorage` LevelDB (`uv`) |

**Excluded so starting the clone cannot resume live sessions:** `workers.json`, `cloud-workers.json`, `guests.json`, the entire `/orchestrator/` session directory, `remote-workers.json`, `remote-mcp.json`, PTY/hook sockets (`pty.sock`, `pty-host.*`, `hook-port`, `shell.*`), `scrollback/`, `worktrees/`, `drops/` and `wiki-run*`.

**No installed office (`--fresh`):** mutually exclusive with `--office`; creates a local clone of this checkout plus a test `Verifier` profile (`DROID_OFFICE_BROWSERS_PATH` overrides the browser cache). Prefer a real owner clone whenever one exists.

Done when `clone-office.sh` exits `0` and prints `$T` containing `start.sh` and `local-storage.json`.

## 2. Start

```bash
T=/tmp/office-clone-Kk3x     # path printed by clone-office.sh
npm run build                # start.sh serves this checkout's dist/
$T/start.sh                  # run with fireAndForget; prints URL (port 4677 or next free)
```

- Launch `$T/start.sh` with `fireAndForget` (a `&` job inside a one-off shell dies when that shell exits).
- `start.sh` binds `127.0.0.1` with `--home $T/office --projects $T/floors` and `HOME=$T/home`, isolating Home-floor state and PTY hosts inside `$T` while preserving `GH_CONFIG_DIR`, `GIT_CONFIG_GLOBAL`, `factory.json` and Whiteboard Chromium.
- After any source edit, rerun `npm run build` and restart `$T/start.sh`; clone state persists across restarts.

## 3. Drive: `office-run.mjs`

Run one self-contained browser session per check (holding an `agent-browser` daemon across office restarts drops to a 30s-closing headless Chrome; video capture uses [`office-video-capture`](../office-video-capture/SKILL.md) instead):

```bash
node .agents/skills/office-clone/scripts/office-run.mjs "$T" steps.mjs --out /tmp/shots
```

`office-run.mjs` reads the port from `$T/start.sh` (refusing `:4600`), launches Playwright's cached headless shell with GPU WebGL (ANGLE Metal on macOS, SwiftShader on Linux), seeds `localStorage` from `$T/local-storage.json`, waits for `window.office` and shader/light-bake warm-up to finish, runs `steps.mjs` (or saves `<out>/office.png` if omitted), auto-accepts native `alert()`/`confirm()`, prints page errors, and closes the browser. Exit `1` writes `failure.png`. Server state persists across runs.

Steps export one default async function using [`office-3d-testing`](../office-3d-testing/SKILL.md) commands and Playwright's `page` (`rig()` loads [`office-choreography`](../office-choreography/SKILL.md) helpers):

```js
// steps.mjs
export default async ({ page, js, open, click, shot, sleep, waitFor, rig, reload, log }) => {
  await open('computers');
  await click('.cmp-tabs button', /Environments/);
  await shot('environments');                                // <out>/environments.png
  await js(() => window.office.goTo('desk-1'));
  await js(() => window.office.interact('E'));
  await page.selectOption('#runs-on', { label: '⧉ droid-office-default (default)' });
  await page.fill('.modal textarea', 'Say hi');
  log(await js(() => document.querySelector('.modal')?.innerText));
};
```

### Native Electron runs

- **`--source /absolute/path/to/built-checkout`**: launches that checkout's Electron app on an isolated profile inside `--out` (the clone server must serve the matching build) for Metal presenter and 120 FPS checks. Attaches only to the clone page, uses native display geometry instead of `--size`, and kills only the app it launched. Verify actual drawn and presented FPS rather than trusting a requested cap; use [`office-thermals`](../office-thermals/SKILL.md) for sensor comparisons.
- **`--desktop` (with `--source`)**: adds the PID-scoped `desktop` AX helper (`agent-desktop` on macOS with Accessibility granted) for native menus, sheets, alerts and window stills, exporting its trace on cleanup without touching the owner's app or stealing focus. Read [`references/native-desktop.md`](references/native-desktop.md) first; keep scene and DOM checks on `window.office` and Playwright.

## 4. Real-account boundaries

Use real account state (unit-test stubs follow [tests/AGENTS.md](../../../tests/AGENTS.md)). When an item to verify is absent from the owner's account, create it through the product or API after getting owner approval for paid or external writes, and delete it during cleanup; never substitute mocked APIs, seeded data or empty `git init` repos.

- **Factory & GitHub**: reads are free; creating/deleting computers or Environments, starting cloud sessions, rebuilding, starting wiki runs, or opening/commenting on issues and PRs mutates the real account or repository. Ask first unless already authorized, track every created resource, and delete it afterwards.
- **Local workers & Orchestrator**: scratch `HOME=$T/home` has no Droid sign-in, so hire dialogs are safe to exercise, while completing a live hire requires owner approval. For an approved signed-in check, pass `FACTORY_API_KEY` read silently from `$T/office/.droid-office/factory.json` into the process env while keeping `HOME=$T/home` (never point a clone at the real `HOME`, copy `~/.factory/`, or edit owner Droid settings). Record the actual model used and honor any no-push/no-PR limits.
- **Cloud workers**: launch real Factory sessions; send them home and delete their artifacts when finished.

## 5. Clean up

Stop the clone server and only the detached `droid-office-ptys` hosts whose sockets live inside `$T` (sockets outside `$T` belong to the owner's live office):

```bash
kill <start.sh pid>
lsof -t "$T"/office/.droid-office/orchestrator/.droid-office/pty.sock "$T"/home/.droid-office/pty.sock "$T"/floors/*/.droid-office/pty.sock 2>/dev/null | xargs kill 2>/dev/null
rm -rf "$T"
```

Cleanup is complete when the clone's port is free, no socket under `$T` remains open, `$T` is deleted, and every Factory or GitHub resource created for the check is removed.
