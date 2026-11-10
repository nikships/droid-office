# Droid Office

A 3D office in the browser where its owner hires droid workers at desks and works in their live PTYs. A Node server owns the workers, terminals, boards and state; a Vite/three.js client renders the office.

Read [docs/guide/how-it-works.md "How it works"](docs/guide/how-it-works.md) before changing how a subsystem behaves (status hooks, PTY host, worktrees, pipelines, floors, state files).

These designs are implemented and have written plans. Work in one of their areas follows its plan and keeps it current:

| Work | Plan |
| --- | --- |
| The single-owner shape (why there is no multiplayer, accounts, voice, chat or presence) | [docs/single-owner.md](docs/single-owner.md) |
| Factory: the API key connection, and the computers, sessions and credits, CI, AutoWiki and cloud workers built on it | [docs/factory.md](docs/factory.md) |
| The Whiteboard: the agent and owner board that replaced the Services board | [docs/whiteboard.md](docs/whiteboard.md) |
| Setup and Subscriptions: installing and signing in Droid, the welcome, DroidProxy and the subscriptions workers run on, and refusing models that can't run | [docs/subscriptions.md](docs/subscriptions.md) |
| The Office MCP: the one MCP server workers use for teams, visits and Whiteboards | [docs/office-mcp.md](docs/office-mcp.md) |
| Mission Control: the building's agents (the Orchestrator and external Tailscale bots), with no desk, on the external MCP surface | [docs/mission-control.md](docs/mission-control.md) |

## Repository map

| Path | Contents |
| --- | --- |
| `src/server/` | Node server: CLI and config, workers, PTY host, hooks, GitHub/GitLab boards and pipelines, floors |
| `src/server/office-mcp/` | Authenticated Office MCP tools for teams, visits and Whiteboards |
| `src/shared/` | Types and pure logic compiled into both server and client, including the WebSocket protocol (`protocol.ts`) and the prompts the office sends workers (`prompts.ts`) |
| `src/client/` | Vite root: HTML entry pages, `main.ts`, `ui/` (DOM windows and panels), `world/` (three.js scene) |
| `src/desktop/` | The Mac app's Electron main process: starts the office on Electron's Node, full-screen window, electron-updater (`tsconfig.desktop.json`, built to `dist/desktop`) |
| `native/` | The Mac app's native Metal presenter (`native/presenter`, Objective-C++ Node-API addon built by `npm run build:native`) and its build script |
| `electron-builder.yml`, `build/` | How the Mac app is packaged, signed and notarized; its icon and entitlements |
| `android/` | Droid Office for Android, the phone companion app (Kotlin, Compose; its own Gradle build) |
| `bin/droid-office.js` | Source checkout and Mac app CLI entry; loads the built `dist/server/server/cli.js` |
| `tests/` | `node:test` suites run through `tsx` |
| `deploy/` | `aws.sh` (EC2 lifecycle) and `provision.sh` (machine setup it runs) |
| `docs/` | `guide/` (chapters for every feature, setup and how each subsystem works) and the README pictures |
| `.agents/skills/` | Skills for checking the running office: `office-clone`, `verify-droid-office`, `office-3d-testing`, recording and performance |

## Commands

Run from the repository root. npm with `package-lock.json` is the only package manager.

| Task | Command |
| --- | --- |
| Clean install (`prepare` also installs the pre-commit hook and builds client and server) | `npm ci` |
| One test file | `node --import tsx --test tests/<name>.test.ts` |
| Run the built office against a project | `node bin/droid-office.js <project>` |

`npm run dev` serves Vite on :5173 and the server on :4600. `node bin/droid-office.js` runs `dist/`, so run `npm run build` after changing source. Android commands are in [android/AGENTS.md](android/AGENTS.md).

`.droid-office.json` at the root is what Droid Office runs in a fresh worktree of this repository: `npm ci`, after copying an untracked `android/local.properties` from the main checkout. Update it when a fresh clone needs another step or local file.

## Conventions

- `.droid-office/` is runtime state (config, workers, scrollback, worktrees). It stays out of git.
- The Mac app release is the only supported production install, and the npm package is private. Developers clone and run the source; installers, release tarballs and curl/PowerShell install commands are out of scope.
- The Mac app runs the office, its PTY host and the commands written for workers on the Electron binary (`process.execPath`) with `ELECTRON_RUN_AS_NODE=1`. A new script the office runs with `process.execPath` goes through `runAsNode` in `src/server/workers.ts`, and stays a file on disk (the app has no asar archive).
- `.env.example` lists every environment variable the office reads. Adding, renaming or removing one updates `.env.example` in the same change; `tests/env-example.test.ts` enforces it. `.env` files stay uncommitted.
- `version` in `package.json` changes only to start a new minor: `.github/workflows/release.yml` publishes every change on `main` as `v<major>.<minor>.<commit count on main>`.
- Commit subjects use a conventional prefix: `feat:`, `fix:`, `docs:` or `chore:`.
- `npm run lint` runs Oxlint (`.oxlintrc.json`) and Biome (`biome.jsonc`). Biome keeps its recommended rules and formatting policy until Oxlint reaches rule parity. Fix findings in the code; suppression comments and rule changes in either config are off the table.
- `npm run typecheck` uses the npm-locked Bun binary, not a global one. After `npm ci --ignore-scripts`, run `npm rebuild bun` first. `tests/typecheck-parity.test.ts` compares Bun with TypeScript on all five projects and injected type errors.
- The pre-commit hook (`.husky/pre-commit`) runs on every commit; fix what it reports rather than bypassing it with `--no-verify`.

## Companion parity

A change to the web companion gets the same fix or feature in Android when Android needs it, implemented and verified in the same work. Centralize shared behavior where practical so both clients have one source of truth; where platform boundaries prevent that, keep the behavior aligned and test it.

## Testing the running office

Scale the check to the risk. Focused tests settle a simple, bounded change; reach for the running office when the change shows there or the tests leave doubt.

A running-office check uses the owner's real data:

- **A clone of the owner's office** is the default: their floors and repositories, Factory account, decor, Whiteboards and browser settings, run from this checkout's build. The [`office-clone`](.agents/skills/office-clone/SKILL.md) skill makes it and drives it with `scripts/office-run.mjs`, one self-contained browser run per check. Screenshots and video for a pull request come from it.
- **The owner's own office** on :4600 and their real devices (an Android phone or tablet over adb) are fine to drive too, and are how you check a client change, such as the Android app or the web companion, against what they actually run.
- **End-to-end proof for a pull request** comes from the [`verify-droid-office`](.agents/skills/verify-droid-office/SKILL.md) skill: it launches an isolated clone (or a fresh office on a machine with none installed), drives a mapped feature, and keeps screenshots and transcripts.

When what you need to show isn't in the owner's account yet, make it for real (with their go-ahead for anything that costs money or writes outside the office) and remove it afterwards. Mocked, invented or seeded data and empty throwaway offices prove nothing about the owner's office. Unit tests stub the network only because CI has no keys; see [`tests/AGENTS.md`](tests/AGENTS.md).

Test the Mac app with a properly built, signed app or an isolated browser. A modified bundle, or a modified copy of one, breaks its signature and can raise a macOS "app is damaged" warning on the owner's desktop, so never modify or launch one. When neither option is available, report the limitation.

## Pushing and pull requests

**Push to and open pull requests (MRs) in `nikships/droid-office` only, never against the upstream `AgentSystemLabs/agent-office`.**

- `nikships/droid-office` is a fork, and `gh` picks the upstream parent as a fork's default base, so always name the repository: `gh pr create --repo nikships/droid-office --base main`.
- Push only to `origin` (`github.com/nikships/agent-office.git`, which redirects to `nikships/droid-office`). Never add or push to a remote that points at `AgentSystemLabs`.

## Validation before a PR

Run the checks CI runs (`.github/workflows/release.yml`, Node 26), in order, until all pass:

```bash
npm ci
npm run lint
npm run typecheck
npm run test:coverage
```

- CI also starts the built office from the checkout (step "Start the office from the checkout"). A change to server startup runs that smoke test locally, as the workflow writes it.
- PR checks run on GitHub-hosted runners: `ubuntu-latest` for Node, website and Android; `macos-26` for the native Mac presenter and Finder checks. They compile the presenter and run Android tests and lint, but set no release version, package nothing and upload nothing.
- Merges to `main` and the Mac and Android release builds (signing, notarizing, publishing) run on the owner's Mac Mini self-hosted runner ([docs/guide/development.md "CI on the Mac Mini"](docs/guide/development.md)). On main the Mac job also packages the app and starts the office on its own Electron; a change to packaging or app startup runs that smoke test locally before merging.
- CI runs on a pull request only when it touches a path in the workflow's `pull_request.paths` filter, and the `changes` job skips the `mac` and `android` jobs unless the PR touches their files. A new check is a step in `release.yml` in the same change, with its files in both `paths` filters, and a new path the `mac` or `android` job depends on goes into that job's pattern.
</coding_guidelines>
