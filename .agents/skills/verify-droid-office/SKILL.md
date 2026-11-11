---
name: verify-droid-office
description: Verify user-facing Droid Office changes end-to-end in an isolated run (`launch.sh`, `doctor.sh`, `drive.sh`, `cleanup.sh`) across the 3D office, web companion, Office MCP, Android app and website, retaining PR screenshots, transcripts and `proof.json`.
---

# Verify Droid Office

Wraps [`office-clone`](../office-clone/SKILL.md) and [`office-3d-testing`](../office-3d-testing/SKILL.md) in an isolated launch, health-check, evidence and cleanup lifecycle, storing PR proof outside the scratch folder. Read [`features/README.md`](features/README.md) and the target feature file before driving.

## 1. Launch

Build first (`npm ci` or `npm run build`), then launch from the repository root:

```bash
.agents/skills/verify-droid-office/scripts/launch.sh            # default: clone of owner's office
.agents/skills/verify-droid-office/scripts/launch.sh --fresh    # machine with no installed office (note in PR)
# RUN=/tmp/verify-droid-office-RXe6
# EVIDENCE=/tmp/verify-droid-office-evidence/verify-droid-office-RXe6
# PORT=4677 PID=64358 MODE=fresh
```

- **Isolation:** each run allocates its own `RUN`, `HOME`, floors, process group and port (`>=4677`; helpers refuse `:4600`, and `VERIFY_EVIDENCE_ROOT` overrides `$EVIDENCE`, which cannot resolve inside `$RUN`). Owner clones carry live Factory and GitHub credentials—follow [`office-clone`](../office-clone/SKILL.md) section 4. Stop and report if isolation or port ownership fails; check against `:4600` directly only when following root `AGENTS.md` ("Testing the running office").
- **Rebuilds:** `start.sh` serves `dist/`; after any source edit, run `npm run build`, `cleanup.sh "$RUN"`, and a fresh `launch.sh`.

Ready when `launch.sh` prints `RUN` and `EVIDENCE` and writes `$EVIDENCE/launch/office.png`.

## 2. Doctor

Run read-only health checks after launch, before the first drive, and after any failed or unexpected drive:

```bash
.agents/skills/verify-droid-office/scripts/doctor.sh "$RUN"
```

Verifies port != `4600`, process-group listener ownership, HTTP `200` on `/` and `/dashboard`, anonymous Office MCP `401` refusal, `dist/` freshness vs `src/`, Mac chip eligibility, `:4600` status, and connected `adb` devices. Proceed to `drive.sh` only when `doctor.sh` exits `0` with zero `fail` lines.

## 3. Drive

```bash
.agents/skills/verify-droid-office/scripts/drive.sh "$RUN" <steps.mjs|-> <name> [--native]
.agents/skills/verify-droid-office/scripts/drive.sh "$RUN" .agents/skills/verify-droid-office/scripts/steps/hire-shell.mjs hire-shell
```

`drive.sh` runs `office-run.mjs` (`{ page, js, open, click, shot, waitFor, sleep, rig, reload, log, out, url }`, with `process.env.VERIFY_OUT` pointing to `$EVIDENCE/<name>`; see [`office-clone`](../office-clone/SKILL.md) section 3). Built-in drivers include `scripts/steps/{hire-shell,mcp-shell-refusal,mission-control,mission-control-native}.mjs` and `node .agents/skills/verify-droid-office/scripts/website-sections.mjs <url> <out-dir>`.

- **Office page (default):** headless GPU WebGL; pass `--native` for isolated Electron (base M-series Macs warn in `doctor.sh`—report the hardware limit rather than setting CI-only `DROID_OFFICE_ALLOW_ANY_CHIP`; use [`native-desktop.md`](../office-clone/references/native-desktop.md) for macOS menus/sheets).
- **Web companion:** open `new URL('/dashboard', url)` via `page.context().newPage()` inside the same steps file (`hire-shell.mjs`).
- **Office MCP, Android, website:** follow each surface's recipe in `features/*.md`.

| Surface | Canonical selectors |
| --- | --- |
| 3D scene | `window.office.goTo(desk)`, `.interact('B' \| 'P' \| 'E' \| 'X')`, `.state().workers`, `.state().terminal`, `.state().modals` |
| Office modals & terminal | `[role=dialog][aria-label="<title>"]`, `[role=alertdialog][aria-label="Send <name> home?"]`, `textarea[aria-label=Prompt]`, `button[type=submit]`, `.xterm-rows` |
| Web companion | `button.dash-row-open[data-worker="<worker id>"]` (`aria-label` carries name, status and task) |
| Android (`uiautomator dump`) | `resource-id` tags from `android/app/src/main/java/ai/factory/droidoffice/core/Tags.kt` |
| Marketing website | `section#top`, `#play`, `#tour`, `#agents`, `#pocket`, `#why`, `#workers`, `#install` + `#<id>-title` |

## 4. Audit evidence

Each drive writes `$EVIDENCE/<name>/` (`*.png`, `transcript.txt`, `exit-code`, `proof.json`):

- **User-path actions & assertions:** drive real keys, dialogs and buttons (never internal setters, raw WebSocket frames or test-only endpoints), and throw in code on failed checks so `drive.sh` exits `1` with `failure.png`.
- **Action + side-effect proof:** save ordered screenshots (`01-free-desk`, `02-shell-hired`, …) alongside read-only side-effect checks in `proof.json` (files written, companion rows, `state()` after dismissal).
- **Secret & git hygiene:** keep Factory keys, hook/device tokens and pairing links out of logs and screenshots (reference `$DROID_OFFICE_HOOK_TOKEN` unexpanded in shell probes), and keep `$EVIDENCE` uncommitted (attach shots and `proof.json` excerpts to the PR).

## 5. Clean up and update map

```bash
.agents/skills/verify-droid-office/scripts/cleanup.sh "$RUN"
```

Stops `$RUN`'s process group and socket-matched PTY hosts, writes redacted `$EVIDENCE/office.log`, deletes `$RUN`, and confirms the port is free (run after failed iterations too, and remove any external Factory or GitHub test items). Update `features/*.md` and the "Last live proof" table in [`features/README.md`](features/README.md) whenever selectors or verified coverage changed.

Verification is complete when `doctor.sh` and `drive.sh` exited `0`, `$EVIDENCE/<name>/` holds ordered screenshots, clean `transcript.txt` and `proof.json`, `cleanup.sh "$RUN"` freed the port and removed `$RUN`, and `features/` matches the live app.
