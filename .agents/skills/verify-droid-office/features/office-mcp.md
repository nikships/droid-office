# Office MCP tool call

Every local Droid worker gets the `droid-office` MCP server, which has tools for its team, its visits and the Whiteboard. The server is Streamable HTTP at `/office/mcp` on the office's loopback hook port. Each request needs `Authorization: Bearer <hook token>` and `x-droid-office-worker-id: <worker id>`. The tools a caller sees depend on who it is.

## Sub-features

- `mcp-refuse-anon` refuses a request with no credentials, before protocol initialization.
- `mcp-refuse-shell` refuses a Shell worker's credentials (only local agents may call).
- `mcp-whoami` answers `office_whoami` for a Droid worker.
- `mcp-filtered-list` lists only the tools the caller may use (`tools/list`).

## How to get to it (user POV)

- A Droid worker calls the tools from its session. The owner sees the effect: a hired subagent, a visit, a Whiteboard card.
- ⚙️ Settings → **Office MCP** turns it on or off.

## Driving it with curl and a worker shell

Preconditions:

- `doctor.sh "$RUN"` passes. Its Office MCP line names the hook port.
- For `mcp-whoami`, a Droid worker that is signed in. A clone or fresh office has no Droid sign-in under its scratch `HOME`, so this needs the owner's go-ahead.

- **Anonymous refusal.** `doctor.sh` posts `tools/list` with no credentials to `http://127.0.0.1:<hook port>/office/mcp`. The answer is `401`.
- **Shell refusal.** Run `.agents/skills/verify-droid-office/scripts/drive.sh "$RUN" .agents/skills/verify-droid-office/scripts/steps/mcp-shell-refusal.mjs mcp-shell`. It hires a Shell and runs, through its P window, a `curl` that posts `tools/list` to `$DROID_OFFICE_HOOK_URL/office/mcp` with the Shell's own `$DROID_OFFICE_HOOK_TOKEN` and `$DROID_OFFICE_WORKER_ID`. Exit code `0`. `mcp-shell-status.txt` holds `401`, and `01-shell-mcp-call.png` shows the command with the variables unexpanded. The Shell is then sent home.
- **Tool call.** In a signed-in Droid worker, ask it to call `office_whoami`. Its terminal shows the tool call, and the answer names the worker and its floor.

## Gotchas

- `mcp-whoami` and `mcp-filtered-list` are not yet driven: they need a signed-in Droid worker.
- The MCP is on the hook port, not the office port. The office port answers `/office/mcp` with `404`, which proves nothing about the MCP.
- Keep the token in `$DROID_OFFICE_HOOK_TOKEN`. Never echo it, write it to evidence, or paste it into a PR.
- A request whose `Host` is not a loopback name is refused. Use `127.0.0.1` or `localhost`.
