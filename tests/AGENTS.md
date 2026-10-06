# Tests

- Flat files named `tests/<name>.test.ts`. `npm test` is `node --import tsx --test tests/*.test.ts`. A file in a subdirectory never runs.
- `node:test` and `node:assert/strict`. Import the source by its `.js` path (`../src/server/workers.js`, `../src/client/world/gun.js`); tsx resolves it. A client module that touches `window`, `document` or WebGL at import time cannot be loaded this way.
- One file: `node --import tsx --test tests/<name>.test.ts`.
- `npm run test:coverage` (Node 22.8+) is what CI runs. The line and function floors are the `--test-coverage-lines` and `--test-coverage-functions` flags in the `package.json` script. `tests/**` is excluded from that denominator. When a change to `src/` or `bin/` drops either number, add coverage until the command passes. Lower a floor only to the number the suite actually holds, in the same change.
- `tests/env-example.test.ts` fails when a `process.env` read or a `DROID_OFFICE_*` name in `src/`, `bin/`, `install.sh` or `install.ps1` is missing from `.env.example`. The names that test skips are listed in it.
- Build fixtures under `os.tmpdir()` and remove them with `t.after`. A test that needs git, `gh` or a provider CLI stubs the binary. It does not call the network or write `.droid-office/` into this checkout.
