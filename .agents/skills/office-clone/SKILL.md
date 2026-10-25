---
name: office-clone
description: Run a build of Droid Office against a copy of the owner's real installed office — their Factory and Jira connections, floors and repositories, decor, Whiteboards, prompts, credits and browser settings — without touching the office they use. Use for every check of the running office (UI, boards, Factory features, the 3D scene), for screenshots and video for a pull request, and for bug repros. Never test against invented, mocked or seeded data, or an empty throwaway office.
---

# Testing on a clone of the owner's office

The owner judges a change by how it looks and works in **their** office: their floors, their repositories on the boards, their Factory computers, Environments and sessions, their decor and profile. So every check of the running office, and every screenshot or video for a pull request, runs on a copy of the owner's real install. Don't invent data, mock an API, seed demo content or test in an empty `git init` folder. When the thing to show isn't in the owner's account yet (no Environment, no failed build), make it for real through the product or its API, with the owner's go-ahead for anything that costs money or writes to the outside world, and clean it up afterwards.

Unit tests are the one exception: CI has no keys or sign-ins, so `tests/` stubs the network. Even there, build every stubbed answer from a real one read from the owner's account, never from the docs' examples or guesswork.

## 1. Clone

```bash
.agents/skills/office-clone/scripts/clone-office.sh          # prints the folder, e.g. /tmp/office-clone-Kk3x
```

It finds the owner's office (`--office DIR`, else `$DROID_OFFICE_HOME`, else the Mac app's `officeDir` in `~/Library/Application Support/com.nikships.droid-office/settings.json`, else `~/droid-office`) and copies, in about 15 seconds:

| Copied | From |
| --- | --- |
| The office folder: `factory.json` (the Factory key), `jira.json`, `floors.json`, prompts, subagent settings, theme, the credits ledger, paired devices | `<office>/.droid-office/` |
| Every project floor, as a local `git clone` with the real `origin` (so boards, CI, AutoWiki and Environments match the real repository) | each floor's checkout |
| Each floor's own state: decor, jukebox, Whiteboard, team, meetings | `<floor>/.droid-office/` |
| The Home floor's state | `~/.droid-office/` |
| The Mac app's browser settings: profile, graphics, per-desk models, the floor it was on | its `localStorage` (LevelDB, read with `uv`) |

It leaves out what a started office would **act on**: `workers.json`, `cloud-workers.json` and `guests.json` (an office resumes every saved worker, so a copy would run the owner's real Droid sessions a second time), the terminals and hooks (`pty.sock`, `pty-host.*`, `hook-port`, `shell.*`), scrollback, worktrees, drops and AutoWiki runs. The clone has the owner's floors and data with nobody at the desks.

## 2. Start it

```bash
T=/tmp/office-clone-Kk3x     # what clone-office.sh printed
npm run build                # start.sh runs this checkout's dist/
$T/start.sh                  # fireAndForget; prints the URL (port 4677, or the next free one)
```

`start.sh` runs this checkout's `node bin/droid-office.js --home $T/office --projects $T/floors` on `127.0.0.1` with `HOME=$T/home`, so the Home floor and every PTY host are the clone's. `gh` and `git` keep the owner's sign-in (`GH_CONFIG_DIR`, `GIT_CONFIG_GLOBAL`), so the boards read the real forge, and the Whiteboard renders with the owner's Chromium. The Factory features use the owner's real key from `factory.json`.

Run `npm run build` again after every source change, then restart `start.sh`. The clone's data stays as it is.

## 3. Drive it as the owner: `office-run.mjs`

Every check and screenshot goes through one command that owns its browser from start to finish:

```bash
node .agents/skills/office-clone/scripts/office-run.mjs $T steps.mjs --out /tmp/shots
```

It launches Playwright's headless shell (the one `node bin/droid-office.js browser install` puts in the office's browser cache) with GPU WebGL (Metal through ANGLE on macOS; SwiftShader on Linux). It writes the owner's `localStorage` from `$T/local-storage.json` before the first load, so the owner's profile, settings and floor are there with no character picker and no reload. It waits until `window.office` is in, the loading screen is gone and the warm-up line (shaders, the light bake) is done. Then it runs your steps, saves the screenshots, prints what the page logged as errors, and closes the browser. It reads the clone's port from `start.sh` and refuses :4600.

For a native Electron check, including actual 120 FPS, pass `--source /absolute/path/to/built-checkout`. The runner launches that checkout's Electron app on a fresh profile inside the output folder, attaches to its actual clone page, uses the same steps/helpers, removes only that page's leave guard for controlled reloads, and kills only the app it launched when done. The clone server must already serve that checkout's build. Native output uses the real display size, not `--size`; default headless mode remains unchanged. Do not treat a requested cap as proof of drawn/presented FPS. For before/after sensor measurements use [office-thermals](../office-thermals/SKILL.md).

A steps file is one async function. The helpers wrap `window.office` ([`office-3d-testing`](../office-3d-testing/SKILL.md) has the commands) and Playwright's `page`:

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
- Exit code 1, with a `failure.png`, when the office never got ready, the page crashed or a step threw. Read the error and fix the step; don't retry blind.
- A native `confirm()` or `alert()` is accepted and printed, so it can't stall the run.
- `rig()` loads [`office-choreography`](../office-choreography/SKILL.md)'s movement rig (`__walkTo`, `__look`, `__hold`, `__tap`) for input `window.office` doesn't cover.
- One run per check, each about 15 to 40 seconds. State lives in the clone's server, not the browser, so the next run picks up where the last left off (a worker you hired is at its desk).

Don't keep a browser session open across commands (an `agent-browser` daemon, a headed window) for checks. When that session dies (an office restart takes the processes of the terminal that started it), the next `agent-browser` command quietly launches a new **headless Chrome for Testing**, and Chrome for Testing under Playwright closes its pages about 30 seconds in. That is the `about:blank` page earlier skills blamed on WebGL. The headless shell has neither problem. Video capture still needs a headed session ([`office-video-capture`](../office-video-capture/SKILL.md)).

## 4. What is real, and what that means

- **Factory is the owner's real account.** Reads are free. A write (create or delete a computer or Environment, start a cloud session, rebuild, open a CI pull request, start a wiki run) changes their account and may cost credits: ask first unless they already said yes, note what you made, and delete it when you're done.
- **The boards are the owner's real repositories.** Opening, closing or commenting on an issue or a pull request from the clone does it on GitHub.
- **Hiring a local worker** in the clone runs Droid under the scratch `HOME`, without the owner's Droid sign-in. Test hire dialogs freely; finish a real local hire only if the owner asks.
- **A cloud worker hired in the clone** is a real Factory session on a real computer. Send it home (and delete what it made) when the check is done.

## 5. Clean up

```bash
kill <start.sh pid>
lsof -t $T/home/.droid-office/pty.sock $T/floors/*/.droid-office/pty.sock 2>/dev/null | xargs kill 2>/dev/null
rm -rf $T
```

Never kill a `droid-office-ptys` process whose socket is outside `$T`: those serve the owner's own office. Delete anything you made in the owner's Factory account or on GitHub.
