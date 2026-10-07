# Desktop

Electron's main process for the Mac app. The office the window shows is the Vite client, not this directory.

- `tsconfig.desktop.json` typechecks this directory (Node types, no DOM) and emits `dist/desktop`. Relative imports end in `.js`. `package.json` `"main"` is `dist/desktop/main.js`.
- The window loads the office page with `sandbox: true` and `contextIsolation: true`. Office UI stays in `src/client`.
- `app.setPath('userData', …/com.nikships.droid-office)`. The default `Droid Office` folder belongs to the Unity office.
- `office.ts` starts `bin/droid-office.js` on Electron's Helper binary (`runtime.ts`) with `ELECTRON_RUN_AS_NODE=1`, in the login shell's environment (`shell-path.ts`), not just its `PATH`. Quitting sends that process SIGTERM, which keeps workers and PTYs. A script the office itself runs with `process.execPath` still goes through `runAsNode` in `src/server/workers.ts`.
- `updates.ts` installs the zip named by this repository's public `latest-mac.yml` (electron-updater, Squirrel.Mac). The update has to be signed by the same Developer ID.
- Packaging is `electron-builder.yml`: `asar: false`, `npmRebuild: false`, arm64, hardened runtime, entitlements in `build/`. `npm run desktop` runs the checkout. `npm run package:mac` writes `release/`. Notarizing needs `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`.
