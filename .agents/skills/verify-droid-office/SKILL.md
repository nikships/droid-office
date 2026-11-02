---
name: verify-droid-office
description: Launch an isolated Droid Office, check it is healthy, drive one user-facing feature the way the owner does, and keep screenshots, transcripts and side-effect proof for a pull request. Covers the Mac app's office page (primary), the web companion, the Office MCP, the Android app and the marketing website. Use before you call a change to droid-office done, when a PR needs real evidence, or to reproduce a visual bug.
---

# Verify Droid Office

Proof that a change works comes from the running app, not from `npm test`. This skill starts an office that cannot touch the owner's, drives a mapped feature through `window.office` and Playwright, and files the evidence where cleanup cannot remove it. The feature recipes are in [features/README.md](features/README.md). Read the index, then the feature file, before you drive.

It builds on [office-clone](../office-clone/SKILL.md) (the clone, `start.sh` and `office-run.mjs`) and [office-3d-testing](../office-3d-testing/SKILL.md) (the `window.office` commands). It adds the launch, doctor, evidence and cleanup lifecycle around them.

## Isolation rules

- Never drive the owner's office on :4600 or their installed Mac app. Every helper refuses :4600, and `doctor.sh` fails when the port belongs to another process.
- Each run gets its own scratch folder `RUN=/tmp/verify-droid-office-XXXX`, with its own `HOME`, office data, floors and port (4677 or the next free one). Two runs can go side by side.
- Default mode clones the owner's installed office, as the repository's `AGENTS.md` requires for screenshots of the running office. A clone carries the owner's Factory key and real forge sign-in. Writes to Factory or GitHub from the clone are real (see office-clone section 4).
- `--fresh` is for a machine with no installed office, such as the Mac Mini CI runner. It starts a new office whose floor is a `git clone --local` of this checkout with its real `origin`, plus a test browser profile so the character picker is skipped. Say in the PR that the evidence came from a fresh office.
- If you cannot isolate a run (no free port, the clone fails, `doctor.sh` fails on ownership), stop and report it. Do not fall back to the owner's office.

## Launch

From the repository root, after `npm ci` (which builds) or `npm run build`:

```bash
.agents/skills/verify-droid-office/scripts/launch.sh            # clone of the owner's office
.agents/skills/verify-droid-office/scripts/launch.sh --fresh    # no installed office on this machine
# RUN=/tmp/verify-droid-office-RXe6
# EVIDENCE=/tmp/verify-droid-office-evidence/verify-droid-office-RXe6
# PORT=4677 PID=64358 MODE=fresh
```

`launch.sh` starts `$RUN/start.sh` in its own process group, waits until `/` and `/dashboard` answer 200, then runs one headless render check. Ready means that check reached `window.office` with the loading screen gone, and saved `$EVIDENCE/launch/office.png`. It prints `RUN` and `EVIDENCE`. Keep both for the later commands. A launch that fails removes what it started and keeps its log in `$EVIDENCE`.

Rebuild (`npm run build`) after every source change, then clean up and launch again. The office serves `dist/`, not `src/`.

## Doctor

Read-only. Run it after launch, before the first drive, and after any drive that failed or surprised you:

```bash
.agents/skills/verify-droid-office/scripts/doctor.sh "$RUN"
```

It checks the port is not :4600, the office process is alive, the listener belongs to this run's process group, `/` and `/dashboard` answer 200, and the Office MCP on the hook port refuses an anonymous call. It also checks that `dist/` is newer than `src/` at the served commit, and whether the native Mac app can run on this Mac. It reports whether the owner's :4600 office is up, so you know to leave it alone, and how many Android devices `adb` sees. Any `fail` line exits 1. Fix it or relaunch. Do not drive through it.

## Drive

```bash
.agents/skills/verify-droid-office/scripts/drive.sh "$RUN" <steps.mjs|-> <name> [--native]
.agents/skills/verify-droid-office/scripts/drive.sh "$RUN" .agents/skills/verify-droid-office/scripts/steps/hire-shell.mjs hire-shell
```

`drive.sh` wraps `office-run.mjs`. One browser run per drive opens the office as the owner, waits for it to be ready, runs the steps file, saves screenshots, and closes. A steps file exports one async function that gets `page`, `js`, `open`, `click`, `shot`, `waitFor`, `sleep`, `rig`, `reload`, `log`, `out` and `url` (see office-clone section 3). Inside steps, `process.env.VERIFY_OUT` is the drive's evidence folder.

- **Office page (primary).** This is the page the Mac app shows. Headless by default (Playwright's headless shell, Metal WebGL through ANGLE).
- **Native Mac app.** `--native` launches this checkout's Electron app on a fresh profile against the run's office. The app refuses base M-series chips, so `doctor.sh` warns on the Mac Mini (Apple M4). Do not set `DROID_OFFICE_ALLOW_ANY_CHIP` to get past it; it is for CI only. For native menus and sheets, see office-clone's [native desktop checks](../office-clone/references/native-desktop.md).
- **Web companion.** Open `new URL('/dashboard', url)` in a second page from the same steps file (`page.context().newPage()`), as `hire-shell.mjs` does.
- **Office MCP, Android, website.** These have their own drivers. See their feature files.

Handles to use, from the source:

| Surface | Handle |
| --- | --- |
| Scene | `window.office.goTo(desk)`, `.interact('B' \| 'P' \| 'E' \| 'X')`, `.state().workers`, `.state().terminal`, `.state().modals` |
| Office windows | `[role=dialog][aria-label="<title>"]`, `[role=alertdialog][aria-label="Send <name> home?"]`, `textarea[aria-label=Prompt]`, `button[type=submit]` |
| Terminal text | `.xterm-rows` |
| Web companion | `button.dash-row-open[data-worker="<worker id>"]` (its `aria-label` carries name, status and task) |
| Android | `resource-id` names from `android/app/src/main/java/ai/factory/droidoffice/core/Tags.kt`, read with `uiautomator dump` |
| Website | `section#top`, `#play`, `#tour`, `#agents`, `#pocket`, `#why`, `#workers`, `#install`, each with `#<id>-title` |

## Evidence

Everything goes under `$EVIDENCE` (default `/tmp/verify-droid-office-evidence/<run id>`, outside `$RUN`; set `VERIFY_EVIDENCE_ROOT` to move it). Each drive writes `$EVIDENCE/<name>/`, with its screenshots, `transcript.txt` (all runner output, including the page's console errors), `exit-code`, and whatever the steps file writes. Cleanup adds `office.log` with tokens removed.

Proof standards:

- Drive the user's path, meaning the keys, windows and buttons the owner uses. Do not call internal setters, send raw WebSocket messages or use test-only endpoints.
- Capture the action and the result, not only the final screen. Number the shots in order (`01-free-desk`, `02-shell-hired`, and so on).
- Check side effects next to the pixels: a file the worker wrote, the row in the web companion, the worker gone from `state()` after send-home. Write them to `proof.json` in the drive folder.
- Assert, do not eyeball. A steps file throws when a check fails. `drive.sh` then exits 1 and saves `failure.png`.
- No mocks. Use the owner's real data (a clone) or a fresh office on this checkout. Never invent or seed board data.
- Treat secrets as private. Never log or screenshot the Factory key, hook tokens, `DROID_OFFICE_HOOK_TOKEN`, the pairing link or a device token. In a worker shell, refer to them as `$VARIABLES`, never as values.
- For a PR, commit no evidence. Upload the screenshots to the PR or its comments, and quote `proof.json` lines in the body.

## Cleanup

```bash
.agents/skills/verify-droid-office/scripts/cleanup.sh "$RUN"
```

It stops the office's process group (SIGINT, then SIGKILL after 10 s), stops PTY hosts whose sockets are inside `$RUN`, saves a redacted `office.log`, and deletes `$RUN`. Then it checks that the port is free and lists the evidence it kept. It never kills by process name. Run it after every failed iteration too. Remove anything the drive made outside the office (a Factory session, a GitHub comment) yourself.

## Helpers

All are executable and run from the repository root.

| Helper | Invocation |
| --- | --- |
| `scripts/launch.sh` | `launch.sh [--fresh] [--office DIR] [--port N]` |
| `scripts/doctor.sh` | `doctor.sh "$RUN"` |
| `scripts/drive.sh` | `drive.sh "$RUN" <steps.mjs\|-> <name> [--native]` |
| `scripts/cleanup.sh` | `cleanup.sh "$RUN"` |
| `scripts/steps/hire-shell.mjs` | `drive.sh "$RUN" .agents/skills/verify-droid-office/scripts/steps/hire-shell.mjs hire-shell` |
| `scripts/steps/mcp-shell-refusal.mjs` | `drive.sh "$RUN" .agents/skills/verify-droid-office/scripts/steps/mcp-shell-refusal.mjs mcp-shell` |
| `scripts/website-sections.mjs` | `node .agents/skills/verify-droid-office/scripts/website-sections.mjs <url> <out-dir>` |

## Keeping it current

The map in `features/` rots as the app changes. Run `/maintain-verification-skill` on this skill to check every feature against source and the live app, and to ship corrections.
