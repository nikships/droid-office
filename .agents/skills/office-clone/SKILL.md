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

## 3. Open it as the owner

Use a headed agent-browser session of its own (headless WebGL drops to `about:blank`):

```bash
export AGENT_BROWSER_SESSION=office-clone
agent-browser --headed open http://127.0.0.1:4677/
agent-browser set viewport 1440 900
agent-browser eval --stdin < $T/load-settings.js     # the owner's profile and settings, then a reload
agent-browser wait --fn "window.office && office.state().floor && getComputedStyle(document.getElementById('loading')).display === 'none'" --timeout 120000
```

Drive it with `window.office` as [`office-3d-testing`](../office-3d-testing/SKILL.md) describes. Wait for `#loading` to be hidden before a screenshot: the office compiles its shaders behind the loading screen.

## 4. What is real, and what that means

- **Factory is the owner's real account.** Reads are free. A write (create or delete a computer or Environment, start a cloud session, rebuild, open a CI pull request, start a wiki run) changes their account and may cost credits: ask first unless they already said yes, note what you made, and delete it when you're done.
- **The boards are the owner's real repositories.** Opening, closing or commenting on an issue or a pull request from the clone does it on GitHub.
- **Hiring a local worker** in the clone runs Droid under the scratch `HOME`, without the owner's Droid sign-in. Test hire dialogs freely; finish a real local hire only if the owner asks.
- **A cloud worker hired in the clone** is a real Factory session on a real computer. Send it home (and delete what it made) when the check is done.

## 5. Clean up

```bash
agent-browser --session office-clone close
kill <start.sh pid>
lsof -t $T/home/.droid-office/pty.sock $T/floors/*/.droid-office/pty.sock 2>/dev/null | xargs kill 2>/dev/null
rm -rf $T
```

Never kill a `droid-office-ptys` process whose socket is outside `$T`: those serve the owner's own office. Delete anything you made in the owner's Factory account or on GitHub.
