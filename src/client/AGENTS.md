# Client

- This directory is the Vite root; the config is the repository root's `vite.config.ts`. An HTML page ships only if it is listed in `build.rollupOptions.input` there.
- `tsconfig.client.json` (Bundler resolution, DOM lib, no Node types) typechecks this directory. Relative imports have no extension.
- Dependencies go in the repository root's `package.json` and `package-lock.json`.
- Keep modules that `tests/` imports (for example `world/office.ts` and `player.ts`) loadable in Node: no DOM or WebGL access at import time.
