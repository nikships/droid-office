# bin

The checkout and packaged app entry. It stays a plain file on disk: the Mac app packs with `asar: false` and runs it on Electron's Node.

- `droid-office.js` is the `package.json` `bin`. It loads `dist/server/server/cli.js` and nothing else.
- Agents reach the office through the Office MCP (`src/server/office-mcp/`, [docs/office-mcp.md](../docs/office-mcp.md)), not through commands here. Don't add worker-facing commands to this folder.
