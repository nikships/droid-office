# Shared

- Compiled by both `tsconfig.server.json` (Node, no DOM) and `tsconfig.client.json` (DOM, no Node): stick strictly to pure ES2022 with no `node:` modules, `process`, `Buffer`, `window`, `document` or I/O. End relative imports within `src/shared/` in `.js` for NodeNext (client callers omit extensions).
- Keep shared domain logic (`layout.ts`, `nav.ts`, `status.ts`, `prompts.ts`, `thread-presentation.ts`, `team.ts`, `whiteboard*.ts`) single-sourced here rather than duplicating across server and client.
- `protocol.ts` defines `ClientMsg` and `ServerMsg`. Update server handlers (`src/server/server.ts`, `src/server/floor.ts`), web client (`src/client/net.ts`, `src/client/state.ts`, `src/client/ui/`), and Android (`android/.../core/Protocol.kt` when mobile reads the field) in the same change.
