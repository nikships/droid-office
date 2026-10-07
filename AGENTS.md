# Droid Office

A 3D office in the browser where its owner hires droid workers at desks and works in their live PTYs. A Node server owns the workers, terminals, boards and state; a Vite/three.js client renders the office.

Read [docs/guide.md "How it works"](docs/guide.md#how-it-works) before changing how a subsystem behaves (status hooks, PTY host, worktrees, meetings, queue, floors, state files).

Planned work has written plans; follow them and keep them current when doing that work:

| Work | Plan |
| --- | --- |
| The single-owner shape (why there is no multiplayer, accounts, voice, chat or presence) | [docs/single-owner.md](docs/single-owner.md) (implemented) |
| Factory: the API key connection, and the computers, sessions and credits, CI, AutoWiki and cloud workers built on it | [docs/factory.md](docs/factory.md) (in progress) |

## Repository map

| Path | Contents |
| --- | --- |
| `src/server/` | Node server: CLI and config, workers, PTY host, hooks, GitHub/GitLab boards, queue, meetings, floors |
| `src/shared/` | Types and pure logic compiled into both server and client, including the WebSocket protocol (`protocol.ts`) |
| `src/client/` | Vite root: HTML entry pages, `main.ts`, `ui/` (DOM windows and panels), `world/` (three.js scene) |
| `src/desktop/` | The Mac app's Electron main process: starts the office on Electron's Node, full-screen window, electron-updater (`tsconfig.desktop.json`, built to `dist/desktop`) |
| `electron-builder.yml`, `build/` | How the Mac app is packaged, signed and notarized; its icon and entitlements |
| `android/` | Droid Office for Android, the phone companion app (Kotlin, Compose; its own Gradle build) |
| `bin/droid-office.js` | Published CLI entry; loads the built `dist/server/server/cli.js` |
| `bin/office-queue.js` | Plain-Node `office-queue` command that board agents use to reach the task queue |
| `bin/office-workers.js` | Plain-Node `office-workers` command that agents use to hire and run subagents (`src/server/team.ts`) |
| `tests/` | `node:test` suites run through `tsx` |
| `deploy/` | `aws.sh` (EC2 lifecycle) and `provision.sh` (machine setup it runs) |
| `install.sh`, `install.ps1` | Release installers for macOS/Linux and Windows |
| `docs/` | `guide.md` (every feature, setup and how each subsystem works) and the README pictures |

## Nested instructions

This file is the layer that applies everywhere. Each directory below has its own `AGENTS.md` for rules that apply only there. Harnesses that walk the tree load this file first, then each `AGENTS.md` from here down to the file you are editing. The closer file wins when two disagree. Read the nearest one before editing that tree. Put a new rule in the closest directory it applies to, so it is not loaded for unrelated work.

| Path | Read it before you |
| --- | --- |
| [`src/server/AGENTS.md`](src/server/AGENTS.md) | change the Node server, workers, PTYs, boards, queue, meetings or floors |
| [`src/shared/AGENTS.md`](src/shared/AGENTS.md) | change a type or helper compiled into both server and client |
| [`src/client/AGENTS.md`](src/client/AGENTS.md) | change the Vite app, or anything `ui/` and `world/` share |
| [`src/client/ui/AGENTS.md`](src/client/ui/AGENTS.md) | change a DOM window or panel |
| [`src/client/world/AGENTS.md`](src/client/world/AGENTS.md) | change the three.js scene, movement, camera or a mesh |
| [`src/desktop/AGENTS.md`](src/desktop/AGENTS.md) | change the Mac app |
| [`android/AGENTS.md`](android/AGENTS.md) | change the Android app |
| [`tests/AGENTS.md`](tests/AGENTS.md) | add or change a test (`tests/*.test.ts` only; a file in a subdirectory never runs) |
| [`bin/AGENTS.md`](bin/AGENTS.md) | change a published command |
| [`deploy/AGENTS.md`](deploy/AGENTS.md) | change AWS or VPS provisioning |
| [`docs/AGENTS.md`](docs/AGENTS.md) | change the guide or another doc |
| [`tools/AGENTS.md`](tools/AGENTS.md) | change a generator under `tools/` |

## Commands

Run from the repository root. npm with `package-lock.json` is the only package manager; do not add another lockfile.

| Task | Command |
| --- | --- |
| Clean install (`prepare` also installs the pre-commit hook and builds client and server) | `npm ci` |
| Add or change a dependency (updates `package-lock.json`; commit both files) | `npm install <pkg>` |
| Dev: Vite with hot reload on :5173, server on :4600 | `npm run dev` |
| Build `dist/public` (client) and `dist/server` (server) | `npm run build` |
| Lint and format check with Biome (`biome.jsonc`); any warning fails | `npm run lint` |
| Rewrite files in the Biome format | `npm run format` |
| Typecheck server and client | `npm run typecheck` |
| All tests | `npm test` |
| All tests with the coverage thresholds in its script (Node 22.8+) | `npm run test:coverage` |
| One test file | `node --import tsx --test tests/<name>.test.ts` |
| Run the built office against a project | `node bin/droid-office.js <project>` |
| Run the Mac app from the checkout | `npm run desktop` |
| Package the Mac app into `release/` (signed when the keychain has the Developer ID) | `npm run package:mac` |
| Android app tests, lint and release APK (JDK 17+, Android SDK) | `cd android && ./gradlew testDebugUnitTest lintDebug assembleRelease` |

`node bin/droid-office.js` runs `dist/`, so run `npm run build` after changing source.

## Conventions

- `.droid-office/` is runtime state (config, workers, scrollback, queue, worktrees). Never commit it.
- The Mac app runs the office, its PTY host and the commands written for workers on the Electron binary (`process.execPath`) with `ELECTRON_RUN_AS_NODE=1`. A new script the office runs with `process.execPath` goes through `runAsNode` in `src/server/workers.ts`, and must stay a file on disk (the app has no asar archive).
- `.env.example` lists every environment variable the office and the installers read. Adding, renaming or removing one updates `.env.example` in the same change; `tests/env-example.test.ts` fails otherwise. Never commit a `.env` file.
- Do not change the `version` in `package.json` except to start a new minor. `.github/workflows/release.yml` publishes every change on `main` as `v<major>.<minor>.<commit count on main>`.
- Commit subjects use a conventional prefix: `feat:`, `fix:`, `docs:` or `chore:`.
- Fix what `npm run lint` reports in code. Never add `biome-ignore` or other suppression comments, and do not turn off rules in `biome.jsonc` to pass a check.
- Do not bypass the pre-commit hook (`.husky/pre-commit`) with `--no-verify`; fix what it reports.

## Pushing and pull requests

**Always push to and open pull requests (MRs) in `nikships/droid-office`. Never push to or open a pull request against the upstream `AgentSystemLabs/agent-office`.**

- `nikships/droid-office` is a fork of `AgentSystemLabs/agent-office`. `gh` picks the upstream parent as the base for a fork by default, so always pass the repository explicitly: `gh pr create --repo nikships/droid-office --base main`.
- Push only to `origin` (`github.com/nikships/agent-office.git`, which redirects to `nikships/droid-office`). Never add or push to a remote that points at `AgentSystemLabs`.

## Validation before a PR

Run the checks CI runs (`.github/workflows/release.yml`, Node 22), in order, and fix any failure:

```bash
npm ci
npm run lint
npm run typecheck
npm run test:coverage
```

CI then packs the release and starts it through `install.sh` (steps "Pack the release" and "Install it with install.sh and start it"). When changing `install.sh`, the `files` or `bin` fields of `package.json`, or server startup, also run those steps locally as the workflow writes them.

CI runs on a pull request only when it touches a path in the workflow's `pull_request.paths` filter. A new check goes into `release.yml` as a step in the same change, and its files go into both `paths` filters.
