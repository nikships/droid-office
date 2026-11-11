# bin

- `droid-office.js` is the `package.json` `bin` entry for source checkouts and the Mac app (`asar: false`, Electron Node). Keep it a plain file on disk that loads `dist/server/server/cli.js` and nothing else.
- Expose worker-facing capabilities as Office MCP tools (`src/server/office-mcp/`, [docs/office-mcp.md](../docs/office-mcp.md)) rather than CLI commands here.
