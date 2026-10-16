# Droid Office

A 3D office in the browser where its owner hires droid workers at desks and works in their live PTYs. A Node server owns the workers, terminals, boards and state; a Vite/three.js client renders the office.

Read [docs/guide/how-it-works.md "How it works"](docs/guide/how-it-works.md) before changing how a subsystem behaves (status hooks, PTY host, worktrees, pipelines, floors, state files).

Planned work has written plans; follow them and keep them current when doing that work:

| Work | Plan |
| --- | --- |
| The single-owner shape (why there is no multiplayer, accounts, voice, chat or presence) | [docs/single-owner.md](docs/single-owner.md) (implemented) |
| Factory: the API key connection, and the computers, sessions and credits, CI, AutoWiki and cloud workers built on it | [docs/factory.md](docs/factory.md) (implemented) |
| The Whiteboard: the agent and owner board that replaces the Services board, and removing Services | [docs/whiteboard.md](docs/whiteboard.md) (implemented) |

## Repository map

| Path | Contents |
| --- | --- |
| `src/server/` | Node server: CLI and config, workers, PTY host, hooks, GitHub/GitLab boards and pipelines, floors |
| `src/shared/` | Types and pure logic compiled into both server and client, including the WebSocket protocol (`protocol.ts`) |
| `src/client/` | Vite root: HTML entry pages, `main.ts`, `ui/` (DOM windows and panels), `world/` (three.js scene) |
| `src/desktop/` | The Mac app's Electron main process: starts the office on Electron's Node, full-screen window, electron-updater (`tsconfig.desktop.json`, built to `dist/desktop`) |
| `electron-builder.yml`, `build/` | How the Mac app is packaged, signed and notarized; its icon and entitlements |
| `android/` | Droid Office for Android, the phone companion app (Kotlin, Compose; its own Gradle build) |
| `bin/droid-office.js` | Source checkout and Mac app CLI entry; loads the built `dist/server/server/cli.js` |
| `bin/office-workers.js` | Plain-Node `office-workers` command that agents use to hire and run subagents (`src/server/team.ts`) |
| `tests/` | `node:test` suites run through `tsx` |
| `deploy/` | `aws.sh` (EC2 lifecycle) and `provision.sh` (machine setup it runs) |
| `docs/` | `guide/` (chapters for every feature, setup and how each subsystem works) and the README pictures |

## Nested instructions

This file is the layer that applies everywhere. Each directory below has its own `AGENTS.md` for rules that apply only there. Harnesses that walk the tree load this file first, then each `AGENTS.md` from here down to the file you are editing. The closer file wins when two disagree. Read the nearest one before editing that tree. Put a new rule in the closest directory it applies to, so it is not loaded for unrelated work.

| Path | Read it before you |
| --- | --- |
| [`src/server/AGENTS.md`](src/server/AGENTS.md) | change the Node server, workers, PTYs, boards, pipelines or floors |
| [`src/shared/AGENTS.md`](src/shared/AGENTS.md) | change a type or helper compiled into both server and client |
| [`src/client/AGENTS.md`](src/client/AGENTS.md) | change the Vite app, or anything `ui/` and `world/` share |
| [`src/client/ui/AGENTS.md`](src/client/ui/AGENTS.md) | change a DOM window or panel |
| [`src/client/world/AGENTS.md`](src/client/world/AGENTS.md) | change the three.js scene, movement, camera or a mesh |
| [`src/desktop/AGENTS.md`](src/desktop/AGENTS.md) | change the Mac app |
| [`android/AGENTS.md`](android/AGENTS.md) | change the Android app |
| [`tests/AGENTS.md`](tests/AGENTS.md) | add or change a test (`tests/*.test.ts` only; a file in a subdirectory never runs) |
| [`bin/AGENTS.md`](bin/AGENTS.md) | change a checkout, packaged app or worker-facing command |
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

`.droid-office.json` at the root is what Droid Office runs in a fresh worktree of this repository: `npm ci`, after copying an untracked `android/local.properties` from the main checkout. Update it when a fresh clone needs another step or local file.

## Conventions

- `.droid-office/` is runtime state (config, workers, scrollback, worktrees). Never commit it.
- The Mac app release is the only supported production install. Developers can clone and run the source; do not add standalone installers, release tarballs or curl/PowerShell install commands. The npm package is private.
- The Mac app runs the office, its PTY host and the commands written for workers on the Electron binary (`process.execPath`) with `ELECTRON_RUN_AS_NODE=1`. A new script the office runs with `process.execPath` goes through `runAsNode` in `src/server/workers.ts`, and must stay a file on disk (the app has no asar archive).
- `.env.example` lists every environment variable the office reads. Adding, renaming or removing one updates `.env.example` in the same change; `tests/env-example.test.ts` fails otherwise. Never commit a `.env` file.
- Do not change the `version` in `package.json` except to start a new minor. `.github/workflows/release.yml` publishes every change on `main` as `v<major>.<minor>.<commit count on main>`.
- Commit subjects use a conventional prefix: `feat:`, `fix:`, `docs:` or `chore:`.
- Fix what `npm run lint` reports in code. Never add `biome-ignore` or other suppression comments, and do not turn off rules in `biome.jsonc` to pass a check.
- Do not bypass the pre-commit hook (`.husky/pre-commit`) with `--no-verify`; fix what it reports.

## Testing the running office

Check every change to what the office shows or does in a clone of the owner's real installed office, made with the [`office-clone`](.agents/skills/office-clone/SKILL.md) skill: their floors and repositories, Factory account, decor, Whiteboards and browser settings, run from this checkout's build. Drive it with that skill's `scripts/office-run.mjs`, one self-contained browser run per check, rather than a browser session held open across commands. Screenshots and video for a pull request come from that clone too. Never test on mocked, invented or seeded data or an empty throwaway office, and never drive the owner's own office on :4600. When what you need to show isn't in the owner's account yet, make it for real (with their go-ahead for anything that costs money or writes outside the office) and remove it afterwards. Unit tests in `tests/` stub the network only because CI has no keys; see [`tests/AGENTS.md`](tests/AGENTS.md).

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

CI then sets the release version and starts the built office from the checkout (step "Start the office from the checkout"). When changing server startup, also run that smoke test locally as the workflow writes it. The Mac job packages the app and starts the office on the app's own Electron; when changing app packaging or startup, also run that smoke test.

CI runs on a pull request only when it touches a path in the workflow's `pull_request.paths` filter. A new check goes into `release.yml` as a step in the same change, and its files go into both `paths` filters. Within a pull request, the `changes` job also skips the `mac` and `android` jobs unless the PR touches their files. A new path one of them depends on goes into that job's pattern too.

## Cursor Cloud specific instructions

- `npm ci` sets `ELECTRON_SKIP_BINARY_DOWNLOAD=1`. The Mac app's Electron binary is not used on Linux. Node 22 is already on the image.
- Whiteboard tests use the Chromium from `node bin/droid-office.js browser install`, kept in `~/.cache/droid-office/browsers`, plus Playwright's system libraries.
- Android unit tests and lint use the SDK at `/opt/android-sdk` (platform `android-37.0`, build-tools 36). JDK 21 is already installed. `android/local.properties` is gitignored and points `sdk.dir` at that SDK. From `android/`: `./gradlew testDebugUnitTest lintDebug`.
- Checks of the running office go through `.agents/skills/office-clone/scripts/office-run.mjs` (Playwright's headless shell from `node bin/droid-office.js browser install`; SwiftShader WebGL on Linux). `agent-browser` is on `PATH` for video capture, which needs a headed session.
- Boot runs `npm run dev`: Vite at http://127.0.0.1:5173 and the office on port 4600. A check that must not share that office runs on a clone of the owner's office on another port, as the `office-clone` skill describes.
- Git rewrites `github.com` remotes to credentialed https URLs. `normalizeRepo` drops that userinfo. A test stub that reads `git remote get-url` has to allow an optional `user:token@` as well.
