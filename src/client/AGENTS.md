# Client

- This directory is the Vite root; the config is the repository root's `vite.config.ts`. An HTML page ships only if it is listed in `build.rollupOptions.input` there; unlisted pages such as `vr-preview.html` exist only under the dev server.
- `tsconfig.client.json` (Bundler resolution, DOM lib, no Node types) typechecks this directory. Relative imports have no extension.
- `package.json` and `vite.config.mjs` here are detection shims for the IWSDK CLI. Never run `npm install` here or add dependencies to them; dependencies go in the root `package.json`.
- Keep modules that `tests/` imports (for example `vr/math.ts`, `world/office.ts`, `player.ts`) loadable in Node: no DOM or WebGL access at import time.

## WebXR and the IWSDK runtime

Read [docs/vr-webxr.md](../../docs/vr-webxr.md) before changing `vr/` or VR hooks in `main.ts`.

`npm run dev:runtime` (from the repository root) serves the office with an emulated Quest 3 and a headless managed browser at `https://127.0.0.1:5173`. It proxies `/api` and `/ws` to an office on `https://localhost:4600`, so start one over HTTPS first, e.g. `node bin/agent-office.js <project> --password dev --self-signed`. The emulator test hooks load with `?vrtest=1` (`window.__vrtest`).

`iwsdk-scripts/*.mjs` are Playwright scripts for that browser, each exporting a default `run({ frame, page, ... })`. With the runtime up, run one from the repository root:

```bash
npx --no-install @iwsdk/cli browser run src/client/iwsdk-scripts/<script>.mjs --workspace src/client
```

Stop it with `npx --no-install @iwsdk/cli dev down --workspace src/client` or by ending the `npm run dev:runtime` process.
