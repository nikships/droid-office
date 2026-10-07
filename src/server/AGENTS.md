# Server

- Compiled by `tsconfig.server.json` (NodeNext, Node types, no DOM) into `dist/server`. Relative imports end in `.js`.
- This process owns workers, PTYs, boards, the queue, meetings and floors. It does not import `src/client`.
- Office options (CLI flags and their `DROID_OFFICE_*` / `PORT` environment equivalents) are parsed by `loadConfig` in `config.ts` into `Config`. Add a new option there and document it in `HELP` in the same file.
- Two different `.droid-office/` directories exist. The office's own (next to where `droid-office` was started) holds `floors.json`, `jira.json`, `factory.json`, `prompts.json`, `leave-on-merge.json`, `subagents.json`, `devices.json` and `hot-reload.json`. Each floor's checkout has its own, with that floor's workers, scrollback, queue, decor, jukebox, meetings, team and guests. Write a key to the directory the guide names for it.
- A change to how status hooks, the PTY host, worktrees, meetings, the queue, floors or those state files behave starts from the matching bullet in [docs/guide.md](../../docs/guide.md#how-it-works). Update that bullet in the same change.

## PTY host

`ptyhost.ts` runs as a detached process that outlives server restarts and keeps running the code it started with. A newer server replaces the host only when the host reports a different `PTY_PROTOCOL` (`ptys.ts`).

Bump `PTY_PROTOCOL` in the same change whenever you edit code the host runs: `ptyhost.ts`, `screen.ts`, or what `ptyhost.ts` imports from `ptys.ts` (`SCROLLBACK`, `readMessages`, `SpawnOpts`, `ToHost`, `FromHost`). The rest of `ptys.ts` runs in the server and needs no bump. Without the bump, running offices keep the old host. With it, the next server ends the old host's terminals and the workers resume their sessions.
