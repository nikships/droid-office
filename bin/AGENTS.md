# bin

Checkout, packaged app and worker-facing commands. They stay plain files on disk: the Mac app packs with `asar: false` and runs them on Electron's Node.

- `droid-office.js` is the `package.json` `bin`. It loads `dist/server/server/cli.js` and nothing else. A source change is invisible to `node bin/droid-office.js` until `npm run build`.
- `office-workers.js` has no build step and no npm imports. The office copies it onto every agent's `PATH`. It calls the loopback hook server with `DROID_OFFICE_HOOK_URL`, `DROID_OFFICE_WORKER_ID` and `DROID_OFFICE_HOOK_TOKEN`. Behavior lives in `src/server/team.ts`; keep the command and that handler in agreement.
- `office-whiteboard.js` follows the same rules and the same three variables, against the hook server's `/office/whiteboard`. Behavior lives in `src/server/whiteboard-agent.ts` and `src/server/whiteboard.ts`; keep its `help` guide and the `droid-office-whiteboard` skill (`src/server/whiteboard-skill.ts`) in agreement with them.
- `office-visit.js` follows the same rules and the same three variables, against the hook server's `/office/visits`. Behavior lives in `src/server/visits.ts`; keep its `help` guide, the `visit.*` prompts and `WORKER_VISITS` (`src/shared/prompts.ts`) in agreement with it.
- Tests import these files directly. Adding a compile step or a dependency breaks that, and breaks a worker whose machine has no `node_modules`.
