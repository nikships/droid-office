# Shared

- Server, browser and React Native clients consume this directory. Use only ES2022 APIs: no `node:` imports, Node globals (`process`, `Buffer`), DOM globals (`window`, `document`) or I/O.
- Relative imports end in `.js`; the server build needs NodeNext resolution. The client imports these modules without an extension.
- Layout (`layout.ts`), navigation (`nav.ts`), status words (`status.ts`), prompts (`prompts.ts`), companion roster and workspace state live here so their consumers share one copy. Do not duplicate these models in the web or React Native UI.
- `protocol.ts` defines the WebSocket messages (`ClientMsg`, `ServerMsg`). A change to either updates the server handlers (`src/server/server.ts`, `src/server/floor.ts`) and the client (`src/client/net.ts`, `src/client/state.ts`, and the `src/client/ui/` windows that send or read the message) in the same change.
