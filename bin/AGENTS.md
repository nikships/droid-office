# bin

Published and worker-facing commands. They stay plain files on disk: the Mac app packs with `asar: false` and runs them on Electron's Node.

- `droid-office.js` is the `package.json` `bin`. It loads `dist/server/server/cli.js` and nothing else. A source change is invisible to `node bin/droid-office.js` until `npm run build`.
- `office-queue.js` and `office-workers.js` have no build step and no npm imports. The office copies them onto a droid's `PATH`. They call the loopback hook server with `DROID_OFFICE_HOOK_URL`, `DROID_OFFICE_WORKER_ID` and `DROID_OFFICE_HOOK_TOKEN`. Behavior lives in `src/server/stations.ts` (queue) and `src/server/team.ts` (droids); keep the command and that handler in agreement.
- Tests import these files directly. Adding a compile step or a dependency breaks that, and breaks a droid whose machine has no `node_modules`.
