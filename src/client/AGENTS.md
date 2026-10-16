# Client

- This directory is the Vite root; the config is the repository root's `vite.config.ts`. An HTML page ships only if it is listed in `build.rollupOptions.input` there. Static files live in `public/` and are served from `/`.
- `tsconfig.client.json` (Bundler resolution, DOM lib, no Node types) typechecks this directory. Relative imports have no extension, including imports from `src/shared`.
- Dependencies go in the repository root's `package.json` and `package-lock.json`.
- `ui/` and `world/` have their own `AGENTS.md`. This file is the Vite app and what those two share.
- WebSocket messages are `ClientMsg` and `ServerMsg`, sent through `net.ts`. A new message is a `src/shared` change: update the server handlers and every client reader in the same change.
- Keep modules that `tests/` imports (for example `world/office.ts`, `world/gun.ts` and `player.ts`) loadable in Node: no DOM or WebGL access at import time.
- Shaders are compiled while the loading screen is up (`shader-warmup.ts`), for the scenes, draw targets, point-light counts, probe-grid counts and hand tone maps a session can reach. A new material or lighting variant the warmup does not cover compiles on its first draw, and the warm-up line says Compiling shaders when that frame is slow.
- To check a change in the running office, drive it with `window.office` (`automation.ts`; commands in [docs/guide/development.md](../../docs/guide/development.md#automation-api-windowoffice)) instead of steering with keys. A new ☰ menu entry or interactable kind shows up there by itself; a new way to move you around goes through `AutomationHost` in `main.ts`.
- Source hot reload (Settings → Building, or Vite on :5173) replaces the page. It does not swap a live three.js module in place, and it does not reload the server. See [docs/guide/development.md](../../docs/guide/development.md#source-hot-reload-with-the-normal-local-launch).
