# bin

The checkout and packaged app entry. It stays a plain file on disk: the Mac app packs with `asar: false` and runs it on Electron's Node.

- `droid-office.js` is the `package.json` `bin`. It loads `dist/server/server/cli.js` and nothing else.
- Workers reach the office through the Office MCP (`src/server/office-mcp/`, [docs/office-mcp.md](../docs/office-mcp.md)). A new worker-facing capability is an Office MCP tool, not a command in this folder.
