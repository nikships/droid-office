# Client

- This directory is the Vite root; the config is the repository root's `vite.config.ts`. An HTML page ships only if it is listed in `build.rollupOptions.input` there. Static files live in `public/` and are served from `/`.
- `tsconfig.client.json` (Bundler resolution, DOM lib, no Node types) typechecks this directory. Relative imports have no extension, including imports from `src/shared`.
- Dependencies go in the repository root's `package.json` and `package-lock.json`.
- `ui/` and `world/` have their own `AGENTS.md`. This file is the Vite app and what those two share.
- WebSocket messages are `ClientMsg` and `ServerMsg`, sent through `net.ts`. A new message is a `src/shared` change: update the server handlers and every client reader in the same change.
- Keep modules that `tests/` imports (for example `world/office.ts`, `world/gun.ts` and `player.ts`) loadable in Node: no DOM or WebGL access at import time.
- Source hot reload (Settings → Building, or Vite on :5173) replaces the page. It does not swap a live three.js module in place, and it does not reload the server. See [docs/guide.md](../../docs/guide.md#source-hot-reload-with-the-normal-local-launch).
