# Development

Developers can clone, run and modify the source on their own machines. Source checkouts and custom deployments are not supported production installs; the production distribution is the [Mac app release](getting-started.md#the-mac-app).

```bash
git clone https://github.com/nikships/droid-office.git
cd droid-office
npm ci               # also builds, and installs the pre-commit hook
npm run dev          # Vite on :5173, server on :4600
npm run build        # vite (client) + tsc (server and desktop app)
npm run lint         # Biome: lint and formatting check, fails on any warning
npm run format       # Biome: rewrite the files in the house format
npm run typecheck
npm test             # worker, pipelines, PTY and doc tests, and .env.example in sync
npm run test:coverage  # the same tests with a coverage report; needs Node 22.8+
node bin/droid-office.js /path/to/project
npm run desktop      # builds, then runs the Mac app from the checkout (it doesn't update itself)
npm run package:mac  # builds release/Droid Office.app, a dmg and a zip; signs with your Developer ID if the keychain has it
```

`npm run package:mac` notarizes the app too when `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` are set; `CSC_IDENTITY_AUTO_DISCOVERY=false npm run package:mac -- -c.mac.identity=null` builds it unsigned. electron-builder's settings are in [`electron-builder.yml`](../../electron-builder.yml), and the icon and entitlements in [`build/`](../../build).

A worktree the office cuts of this repository sets itself up from [`.droid-office.json`](../../.droid-office.json): it copies `android/local.properties` from the checkout when there is one and runs `npm ci`.

**Lint and format.** [Biome](https://biomejs.dev) lints and formats every `.js`, `.mjs` and `.ts` file outside `dist/`, with the settings in [`biome.jsonc`](../../biome.jsonc): two-space indents, single quotes, semicolons, trailing commas and 240-column lines. `npm run format` fixes the formatting.

**Pre-commit hook.** `npm ci` or `npm install` in a clone points git at [`.husky/`](../../.husky) (through the `prepare` script), and every commit then runs [lint-staged](https://github.com/lint-staged/lint-staged) and `npm run typecheck`. lint-staged runs `biome check --write` on the staged files, so formatting is fixed and added to the commit, and a lint finding stops it. The hook is a convenience; CI runs the same `npm run lint` and `npm run typecheck`. `git commit --no-verify` skips it, and `HUSKY=0` skips installing it. It isn't installed in CI (`CI=true`) or where dev dependencies aren't.

`npm run test:coverage` fails when line or function coverage of `src/` and `bin/` drops below the thresholds in its `package.json` script, and CI runs it in place of `npm test`. `npm test` still runs on Node 20.

`npm run dev` runs Vite with hot reload on :5173 and proxies to the server on :4600. Server edits restart the server, not the workers.

### Source hot reload with the normal local launch

For a local checkout started with **`npm run build && npm run start`**, open **⚙️ Settings → Building → Source hot reload** and enable it. The choice is saved in the office’s `.droid-office/hot-reload.json`. Enabling it builds once immediately; after that, saving client source, shared code, styles, HTML, public assets or the Vite/TypeScript build configuration triggers another build. It watches the checkout the office itself runs from, not whichever project floor is open. No separate dev server is needed.

The office checks for changes every second and waits briefly for saves to settle. It typechecks and builds the client in child processes into a private staging folder, then switches to the complete bundle and refreshes the browser. It does **not** replace individual live three.js modules: a full page refresh avoids stale scene objects, event listeners and incompatible module state after arbitrary game changes. The server, workers and PTYs keep running. Your saved browser settings, floor and position return, but open windows, unsent drafts and browser-only game state may need reopening.

A failed typecheck or build leaves the last successfully built office running and shows the error. Fixing the source retries automatically; **Build & reload** retries manually. A small recovery script is served independently of the game bundle and kept unchanged for the server’s lifetime, so even a game startup error can show **Retry build** and **Disable hot reload** and recover on the next successful build without a reload loop. Earlier hashed chunks stay available for tabs still running an older build. Temporary builds are removed on graceful shutdown; a force-killed server may leave its own `hot-reload-*` staging folder behind.

**Boundary:** this reloads browser game logic, visuals and UI, not running server modules or terminal lifecycles. Server changes, shared/server-side logic, protocol changes and dependency changes show a **server restart required** warning; run the normal build/start workflow to apply those consistently. A compilable client change can still contain a runtime bug or be incompatible with the old server—reload cannot guarantee arbitrary code is correct. Newly added dependencies must be installed normally. Source hot reload is unavailable in packaged installs without source or development dependencies. Vite’s :5173 dev page continues using Vite’s own reload instead.

### Automation API (`window.office`)

Every office tab has `window.office`, so an agent or a browser test can check a client change without steering by hand: no WASD, no lining up with a desk, no pressing E. Each command returns a promise. It resolves with a `state()` snapshot once the action has finished (you've arrived, the window is open, the ride is over). It rejects with an `Error` that says why: no such desk, stuck on the way, riding the elevator.

| Command | What it does |
| --- | --- |
| `office.list()` | Everything `goTo` takes from here, each with `id`, `kind` (`desk`, `kiosk`, `board`, `place`, `floor`), `label` and, for a desk, its `worker` |
| `office.goTo(target, { walk?, timeout? })` | Puts you at a desk (behind the worker), a kiosk, a board or a place, facing it. `target` is a `list()` id (`desk-3`, `station-issues`, `issues`, `coffee`, `elevator`), a worker's id or name, a desk's label, a board agent's name, a floor's id or name, or `roof`. `{ walk: true }` walks there along the office's paths instead |
| `office.interact(key = 'E')` | Presses E, P, R, X, B, C or O at what you went to, or else at the nearest thing in reach, as if you faced it. E at a worker opens its terminal; at a board, it opens the board. On a ladder, E gets you off it as the key does, at the floor or dropping from where you are; it is refused while you go through the hatch or slide down a fire pole. Other keys, `goTo` and riding wait until you're off |
| `office.open(id)` | Runs a ☰ menu command: `issues`, `pulls`, `pipelines`, `whiteboard`, `search`, `elevator`, `roof`, `decor`, `settings`, `phone`, `help`, `upgrade`, `waiting` |
| `office.commands()` | Those commands, with whether each is offered here and why one is blocked |
| `office.closeAll()` | Closes every open window |
| `office.ride(floor)` | Takes the elevator to a floor (id or name) or `roof`, and resolves once the doors open there |
| `office.camera(preset)` | A fixed camera so screenshots compare between runs: `first`, looking straight ahead, level |
| `office.height(scale)` | Smoothly sets eye height to 1–3 times the default, resolving when it settles; `state().player.eyeHeight` reports it in meters |
| `office.frameStats({ reset? })` | Frame pacing since the last `{ reset: true }`, or over the last minute: `frames`, `fps`, `frameTime` (p50, p95, p99, max ms), `missed`, `repeated`, `cpu` and `gpu` per pass, `refreshHz`, `fpsCap`, `renderer`, `backend`, `pace`, `output` and `rawMouse` |
| `office.state()` | JSON for assertions: floor, position, facing and view, seat, what E would use (`using`), open windows (`modals`, by their labels), the open terminal, workers with desk and status, and floors |

With [agent-browser](https://github.com/vercel-labs/agent-browser) (`agent-browser eval --stdin`) or Playwright (`page.evaluate`):

```js
const o = window.office;
await o.goTo('Ada');                       // a worker's name, or 'desk-3'
await o.interact();                        // E: its terminal opens
await o.goTo('issues');
const s = await o.interact();              // E: the Issues board opens
s.modals;                                  // [{ label: 'Issues board', doing: '📋 at the issues board' }]
```

Wait for `window.office && office.state().floor` before the first command; a new browser profile shows the character picker first. A headless browser runs the office on the GPU when started with `--use-angle=metal` on a Mac; without it WebGL falls back to software and runs at a few frames a second. `.agents/skills/office-clone/scripts/office-run.mjs` drives a copy of an office this way from a script, in Playwright's headless shell.

Without a browser driver, the server runs the same commands in the office tab opened last (not a phone), and answers with what the command resolved to or why it failed:

```bash
curl -s localhost:4600/api/automation -H 'content-type: application/json' -d '{"cmd": "goTo", "args": ["desk-3"]}'
# {"ok": true, "value": {…the state…}}  · 422 {"ok": false, "error": "…"} · 409 no tab open · 504 no answer in time
```

`args` is the command's arguments as a JSON array, and `timeout` (milliseconds, default 90 000) is how long to wait for the tab.

Rules for changing the code are in [`AGENTS.md`](../../AGENTS.md). A directory with its own rules has an `AGENTS.md` beside the code; the root file lists them.

## Releases

Every change to the app that lands on `main` is published as a GitHub release by [`.github/workflows/release.yml`](../../.github/workflows/release.yml). The Mac app is the only supported production installation; there is no standalone server tarball or npm publication, and `package.json` marks the package private. The workflow builds, lints and typechecks the office, runs the tests with the coverage thresholds, and starts the built office from the checkout. Alongside, a macOS job builds the Mac app at that version, signs it with the Developer ID from the repository's secrets (`MAC_CERTS`, `CERT_PASSWORD`), notarizes the app and its disk image with Apple (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`), and starts the office on the app's own Electron. The Android job tests and builds the companion APK. Only once all three jobs pass does the release go up, marked Latest, with the dmg, the zip, their update metadata and the companion APK. Installed Mac apps update through `latest-mac.yml`. Pull requests run the same checks, with an unsigned app, but publish nothing; a pull request builds the Mac app only when it touches `src/desktop`, `src/server`, `src/shared`, `bin`, `build`, `electron-builder.yml`, `package.json`, `package-lock.json` or a `tsconfig`, and the Android APK only when it touches `android/`. Workflow changes build both apps. A release is named after `package.json`'s major.minor and the number of commits on `main` (`v0.1.68`), so every release is a new version the app updates to; bump `package.json` to start a new minor version.
