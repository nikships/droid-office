# Droid Office verification map

This directory is the maintained source for verifying the user-facing behavior of Droid Office. Read this index before you drive the app, then use the matching feature file as the recipe.

## Baseline preconditions

- Build this checkout with `npm ci` or `npm run build`.
- Launch with `scripts/launch.sh` (clone of the owner's office) or `scripts/launch.sh --fresh` (no installed office on this machine). Keep the printed `RUN` and `EVIDENCE`.
- Run `scripts/doctor.sh "$RUN"` and require no `fail` lines.
- Drive only the office this run launched; the helpers refuse :4600.

## Driving conventions

- Start every recipe from the launched state, with no windows open (`window.office.closeAll()`).
- Use `window.office` for the scene and `aria-label`, `role` and `data-*` handles for windows; coordinates and tab order break between runs.
- Run office page drives through `scripts/drive.sh "$RUN" <steps.mjs> <name>`.
- Undo what a recipe makes: send hired workers home, and delete cards or comments the run created. Proof artifacts stay.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- UI proof includes numbered screenshots and the drive's `transcript.txt`.
- Mutation proof includes a second, read-only view, such as the web companion row or a file the worker wrote.
- Record the feature ID and entry point with every artifact (the drive name, `proof.json`).
- Report an unreachable path with the command you tried and the unmet precondition, as skipped: an entry point counts as verified only through its own path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with <harness>` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

## Features

| Feature | Surface | Last live proof |
| --- | --- | --- |
| [Airgapped setup](./airgapped.md) | Office page, web companion model API, Android picker | Browser on Linux, fresh credential-free office, welcome/settings at 1440×900 and 1024×700, missing-model blocking and HTTP guards, 2026-11-11; real BYOK turn and Android execution pending |
| [Hire a worker](./hire-worker.md) | Office page, web companion | All but `hire-droid-dialog` (`hire-shell.mjs`), Mac Mini, fresh office, 2026-11-02 |
| [Whiteboard](./whiteboard.md) | Office page, Android | Not yet driven |
| [Office MCP tool call](./office-mcp.md) | Office MCP over HTTP | `mcp-refuse-anon` and `mcp-refuse-shell` (`mcp-shell-refusal.mjs`), Mac Mini, fresh office, 2026-11-02 |
| [Mission Control](./mission-control.md) | Office page, web/Mac companion, Android, Office MCP | Entry, blocked companion, shared settings and floor continuity; browser and Electron scene/settings, owner clone, 2026-11-09; live team proof pending |
| [Android Workers list](./android-workers.md) | Android app (adb) | Pixel 9 Pro XL emulator, cloned owner office: Shell from Asks and past a pending Droid snackbar |
| [Website sections](./website.md) | Marketing site | `website-sections.mjs`, Mac Mini, 2026-11-02 |
