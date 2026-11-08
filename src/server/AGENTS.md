# Server

- Compiled by `tsconfig.server.json` (NodeNext, Node types, no DOM) into `dist/server`. Relative imports end in `.js`.
- This process owns workers, PTYs, boards, pipelines and floors, and never imports `src/client`.
- Office options (CLI flags and their `DROID_OFFICE_*` / `PORT` environment equivalents) are parsed by `loadConfig` in `config.ts` into `Config`. A new option goes there and into `HELP` in the same file.
- There are two kinds of `.droid-office/` directory: the office's own (next to where `droid-office` was started) for office-wide settings, and one in each floor's checkout for that floor's workers, scrollback, decor, team and Whiteboard. The "State." bullet of [docs/guide/how-it-works.md](../../docs/guide/how-it-works.md) names the file each one holds; a new file goes in the directory that matches its scope, and into that bullet.
- A change to how status hooks, the PTY host, worktrees, pipelines, floors or those state files behave starts from the matching bullet in how-it-works.md and updates it in the same change.

## PTY host

`ptyhost.ts` runs as a detached process that outlives server restarts and keeps running the code it started with. A newer server replaces the host only when the host reports a different `PTY_PROTOCOL` (`ptys.ts`).

Bump `PTY_PROTOCOL` in the same change whenever you edit code the host runs: `ptyhost.ts`, `screen.ts`, or what `ptyhost.ts` imports from `ptys.ts` (`SCROLLBACK`, `readMessages`, `SpawnOpts`, `ToHost`, `FromHost`). The rest of `ptys.ts` runs in the server and needs no bump. Without the bump, running offices keep the old host. With it, the next server ends the old host's terminals and the workers resume their sessions.
