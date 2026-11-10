---
name: office-clone
description: Run this checkout's build of Droid Office against a copy of the owner's real installed office (floors and repositories, Factory and Jira connections, decor, Whiteboards, prompts, browser settings) without touching the office they use. Use for any check of the running office, screenshots or video for a pull request, and bug repros.
---

# Testing on a clone of the owner's office

The owner judges a change by how it looks and works in **their** office: their floors, their repositories on the boards, their Factory computers, Environments and sessions, their decor and profile. A clone is a copy of that install, run from this checkout's build, with nobody at the desks. It is the default target for every check of the running office and every screenshot or video for a pull request.

Show what is really there. When the thing to show isn't in the owner's account yet (no Environment, no failed build), make it for real through the product or its API, with the owner's go-ahead for anything that costs money or writes to the outside world, and clean it up afterwards. Invented data, mocked APIs, seeded demo content and empty `git init` folders prove nothing about the owner's office. Unit-test stubs follow [tests/AGENTS.md](../../../tests/AGENTS.md).

## 1. Clone

Build this checkout first with `npm ci` (which builds) or `npm run build`; the helper uses its `droid-office browser path` command to find the app's browser cache.

```bash
.agents/skills/office-clone/scripts/clone-office.sh          # prints the folder, e.g. /tmp/office-clone-Kk3x
```

It finds the owner's office (`--office DIR`, else `$DROID_OFFICE_HOME`, else the Mac app's `officeDir` in `~/Library/Application Support/com.nikships.droid-office/settings.json`, else `~/droid-office`) and copies, in about 15 seconds:

| Copied | From |
| --- | --- |
| The office folder: `factory.json` (the Factory key), `jira.json`, `floors.json`, prompts, subagent settings, theme, the credits ledger, paired devices | `<office>/.droid-office/` |
| Every project floor, as a local `git clone` with the real `origin` (so boards, CI, AutoWiki and Environments match the real repository) | each floor's checkout |
| Each floor's own state: decor, jukebox, Whiteboard, team | `<floor>/.droid-office/` |
| The Home floor's state | `~/.droid-office/` |
| The Mac app's browser settings: profile, graphics, per-desk models, the floor it was on | its `localStorage` (LevelDB, read with `uv`) |

It leaves out everything a started office would **act on**: `workers.json`, `cloud-workers.json` and `guests.json` (an office resumes every saved worker, so a copy would run the owner's real Droid sessions a second time), the terminals and hooks (`pty.sock`, `pty-host.*`, `hook-port`, `shell.*`), scrollback, worktrees, drops and AutoWiki runs. It keeps `orchestrator.json` settings but excludes the entire `orchestrator/` session folder, including its nested `.droid-office/` tokens, workers, hooks, terminal socket and conversation references. A clone never resumes the owner's Orchestrator. External bot identities, keys and Serve settings are excluded too.

On a machine with no installed office, `--fresh` prepares a new office with a local clone of this checkout and a test browser profile instead, with the same port selection, startup script and browser cache (`DROID_OFFICE_BROWSERS_PATH` overrides it). `--fresh` and `--office` exclude each other. Use the owner's clone for app screenshots whenever one is available.

## 2. Start it

```bash
T=/tmp/office-clone-Kk3x     # what clone-office.sh printed
npm run build                # start.sh runs this checkout's dist/
$T/start.sh                  # fireAndForget; prints the URL (port 4677, or the next free one)
```

- Start `start.sh` as a background job (fireAndForget). A process backgrounded with `&` inside a one-off shell dies with that shell.
- `start.sh` runs `node bin/droid-office.js --home $T/office --projects $T/floors` on `127.0.0.1` with `HOME=$T/home`, so the Home floor and every PTY host belong to the clone, never to the owner's folders.
- `gh` and `git` keep the owner's sign-in (`GH_CONFIG_DIR`, `GIT_CONFIG_GLOBAL`), so the boards read the real forge. The Whiteboard renders with the owner's Chromium, and the Factory features use the owner's real key from `factory.json`.
- After every source change, run `npm run build` again and restart `start.sh`. The clone's data stays as it is.

## 3. Drive it as the owner: `office-run.mjs`

Every check and screenshot goes through one command that owns its browser from start to finish:

```bash
node .agents/skills/office-clone/scripts/office-run.mjs $T steps.mjs --out /tmp/shots
```

It launches Playwright's headless shell (the one `node bin/droid-office.js browser install` puts in the office's browser cache) with GPU WebGL (Metal through ANGLE on macOS; SwiftShader on Linux). It writes the owner's `localStorage` from `$T/local-storage.json` before the first load, so their profile, settings and floor are there with no character picker. It waits until `window.office` is in, the loading screen is gone and the warm-up line (shaders, the light bake) is done, runs your steps, saves the screenshots, prints what the page logged as errors, and closes the browser. It reads the clone's port from `start.sh` and refuses :4600.

A steps file is one async function. The helpers wrap `window.office` (the commands are in [`office-3d-testing`](../office-3d-testing/SKILL.md)) and Playwright's `page`:

```js
// steps.mjs
export default async ({ page, js, open, click, shot, sleep, waitFor, rig, reload, log }) => {
  await open('computers');                                   // office.open(id), from the ☰ menu
  await click('.cmp-tabs button', /Environments/);           // first match whose text fits
  await shot('environments');                                // <out>/environments.png
  await js(() => window.office.goTo('desk-1'));              // anything in the page
  await js(() => window.office.interact('E'));
  await page.selectOption('#runs-on', { label: '⧉ droid-office-default (default)' });
  await page.fill('.modal textarea', 'Say hi');
  log(await js(() => document.querySelector('.modal')?.innerText));
};
```

- Without a steps file it saves `office.png`: a quick check that the clone renders.
- Exit code 1, with a `failure.png`, means the office never got ready, the page crashed or a step threw. Read the error and fix the step before running again.
- A native `confirm()` or `alert()` is accepted and printed, so it can't stall the run.
- `rig()` loads [`office-choreography`](../office-choreography/SKILL.md)'s movement rig (`__walkTo`, `__look`, `__hold`, `__tap`) for input `window.office` doesn't cover.
- One run per check, each about 15 to 40 seconds. State lives in the clone's server, not the browser, so the next run picks up where the last left off (a worker you hired is still at its desk).

**Why one run per check.** A browser session held open across commands (an `agent-browser` daemon, a headed window) dies when an office restart takes the processes of the terminal that started it. The next `agent-browser` command then quietly launches a headless Chrome for Testing, which under Playwright closes its pages about 30 seconds in: the `about:blank` page that looks like a WebGL failure. The headless shell has neither problem. Video capture still needs a headed session ([`office-video-capture`](../office-video-capture/SKILL.md)).

### Native Electron runs

- `--source /absolute/path/to/built-checkout` runs that checkout's Electron app on a fresh profile inside the output folder instead of the headless shell, for native-presenter checks and actual 120 FPS. The runner attaches to the app's clone page, uses the same steps and helpers, removes only that page's leave guard for controlled reloads, and kills only the app it launched. The clone server must already serve that checkout's build. Native output uses the real display size, not `--size`. A requested frame cap is not proof of drawn or presented FPS; measure those, and use [`office-thermals`](../office-thermals/SKILL.md) for before/after sensor measurements.
- `--desktop` with `--source` adds a `desktop` helper for **native** menus, sheets, alerts and OS window evidence. It needs `agent-desktop` on macOS with Accessibility granted, is scoped to the launched clone's PID and its own session, and seals and exports its trace during cleanup, including after a failed step. It never targets the owner's app by name, steals focus or falls back to physical input. Read [native desktop checks](references/native-desktop.md) before using it. Scene and DOM checks stay on `window.office` and Playwright.

## 4. What is real

- **Factory is the owner's real account.** Reads are free. A write (create or delete a computer or Environment, start a cloud session, rebuild, open a CI pull request, start a wiki run) changes their account and may cost credits: ask first unless they already said yes, note what you made, and delete it when you're done.
- **The boards are the owner's real repositories.** Opening, closing or commenting on an issue or a pull request from the clone does it on GitHub.
- **A local worker hired in the clone** runs Droid under the scratch `HOME`, without the owner's Droid sign-in. Test hire dialogs freely; finish a real local hire only when the owner asks.
- **An approved signed-in local-worker or Orchestrator check** may supply `FACTORY_API_KEY` from the clone's own `office/.droid-office/factory.json` when starting the clone. Read the key into the process environment without printing it. Keep `HOME=$T/home`; never point a clone at the real HOME, copy the whole real `.factory/` or edit the owner's Droid settings. Record the actual model (including quota fallback), and keep any no-push/no-PR limits in the brief.
- **A cloud worker hired in the clone** is a real Factory session on a real computer. Send it home, and delete what it made, when the check is done.

## 5. Clean up

Stop what you started, and only that. A floor's PTY host keeps running after the office stops while it still has live terminals, so stop the hosts whose sockets are inside `$T`:

```bash
kill <start.sh pid>
lsof -t "$T"/office/.droid-office/orchestrator/.droid-office/pty.sock "$T"/home/.droid-office/pty.sock "$T"/floors/*/.droid-office/pty.sock 2>/dev/null | xargs kill 2>/dev/null
rm -rf "$T"
```

A `droid-office-ptys` process whose socket is outside `$T` serves the owner's own office and its workers; leave it running. Delete anything the check made in the owner's Factory account or on GitHub. The clone is clean when its port is free, `$T` is gone and nothing you made remains in their accounts.
