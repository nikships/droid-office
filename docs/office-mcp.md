# The Office MCP

Status: in progress. One MCP server, `droid-office`, replaces the three commands the office put on every agent's PATH (`office-workers`, `office-whiteboard`, `office-visit`) and the two skills it wrote into `~/.factory/skills` (`droid-office-subagents`, `droid-office-whiteboard`). What those commands' `help` text and the skills taught now lives in the server's `instructions` and in each tool's description and parameter descriptions. There is no other interface: the commands, the skills and their Settings toggles are deleted.

## Decisions

- **Library.** [mcp-use](https://docs.mcp-use.com/llms.txt) (TypeScript, v2, Hono, `server.fetch`). If it can't hide tools per caller, or its install footprint is unacceptable for the Mac app (no asar; `node_modules` ships), switch to [FastMCP](https://github.com/punkpeye/fastmcp) (`canAccess` per tool) and record why here.
- **Transport and mount.** Streamable HTTP, mounted on the office's hook server (`127.0.0.1:<hookPort>`) at `/office/mcp`, next to `/office/workers`, `/office/whiteboard` and `/office/visits`. The tools call the server-side code those endpoints call (`team.ts`, `whiteboard-agent.ts`, `visits.ts`) directly, not over HTTP.
- **Identity.** Every request carries `Authorization: Bearer <DROID_OFFICE_HOOK_TOKEN>` and the worker id (`DROID_OFFICE_WORKER_ID`). The token is resolved to its worker exactly as the existing `/office/*` endpoints do; a request without a valid token gets no tools.
- **How Droid connects.** Preferred: the per-worker `--settings` file the office already passes declares the server, if Droid honors `mcpServers` there (verify on the installed `droid`; Droid's docs only list `mcp.json` files). Otherwise the office writes one `droid-office` entry into `~/.factory/mcp.json` (merging, never clobbering the owner's other servers) with `headers` taken from `${DROID_OFFICE_HOOK_TOKEN}` / `${DROID_OFFICE_WORKER_ID}`, and removes it when Office MCP is off. Record which one shipped, and what a non-office droid session sees, here.
- **Hidden tools.** `tools/list` is filtered per caller: a subagent sees no hiring or visit tools, a worker that may not hire sees no team tools, visits off hides the visit tools. A hidden tool that's called anyway is refused with the reason.
- **No waiting.** `office-workers wait` is gone. Leads learn about their team from the office's wake notes; with ⚙️ Settings → Subagents & visits → "Wake the lead" off, they poll `team` with `action: "status"`. No tool blocks for long.
- **Non-blocking ask.** `visit_message` with `kind: "ask"` returns once the question is delivered. The answer (from `visit_reply`) arrives later as a delivery typed into the asker's session, like a tell.
- **Files and images.** Whiteboard paths are resolved against the calling worker's working folder (its worktree or checkout), never the office's cwd. A PNG export comes back as MCP image content.
- **One toggle.** ⚙️ Settings gets one "Office MCP" switch (on by default) in place of the "Subagents skill installed" and "Whiteboard skill installed" toggles. Off: workers get no office tools. On startup the office deletes `~/.factory/skills/droid-office-subagents/SKILL.md` and `~/.factory/skills/droid-office-whiteboard/SKILL.md` only when they carry the office's mark (`SKILL_MARK` / `WHITEBOARD_SKILL_MARK`), and their folders when empty. The Android app follows (companion parity).
- **Prompts.** The system prompt's "Office commands" section and every notice that names a command (team update, lead/visit deliveries, Whiteboard ping, pipeline heal, cloud note) become short pointers to tool names. Detail lives in the server instructions and tool descriptions.
- **Out of scope.** Guests (droids started by hand) and Factory cloud workers get no office tools, as today.

## Tools

Fourteen tools. Names, inputs and who sees them are the contract between the modules; change them only by changing this table.

| Tool | Replaces | Input (all strings unless noted) | Who sees it |
| --- | --- | --- | --- |
| `office_whoami` | `office-workers whoami`, `office-visit whoami` | none | every office worker |
| `team_models` | `office-workers models` | none | may hire |
| `team_hire` | `office-workers hire` | `title`, `brief`, `model?`, `effort?` (low/medium/high/xhigh/max), `from?` (ref), `worktree?` (boolean, default true) | may hire |
| `team` | `list`, `read`, `send`, `dismiss` | `action`: `status` \| `message` \| `dismiss`; `name?` (status: one subagent, else all); `lines?` (number, status: include that many terminal lines, max 400); `text?` (message) | has or may have subagents |
| `team_report` | `office-workers report [--question]` | `text`, `question?` (boolean) | subagents only |
| `visit_roster` | `office-visit roster` | none | independent worker, Visits on |
| `visit_look` | `office-visit look` | `name`, `lines?` (number) | same |
| `visit_message` | `tell`, `ask`, `handoff` | `name`, `kind`: `tell` \| `ask` \| `handoff`, `text`, `title?` (handoff), `urgent?` (boolean) | same |
| `visit_reply` | `office-visit reply` | `visit` (v-… id), `text` | same |
| `whiteboard_read` | `office-whiteboard read` | `cards?` (ids), `json?` (boolean), `png?` (boolean: image content per card) | every office worker |
| `whiteboard_card` | `push`, `update`, `link`, `unlink`, `rm`, `show` | `action`: `create` \| `update` \| `link` \| `unlink` \| `remove` \| `show`; `card?`; `title?`; `source?`: one of `{ html }`, `{ file }`, `{ dir, entry? }`, `{ image }`, `{ link, entry? }`, `{ canvas: true }`; `grid?` (boolean, show) | every office worker |
| `whiteboard_state` | `office-whiteboard state` | `card`, `op`: `get` \| `set` \| `merge` \| `del`, `path?` (dotted), `value?` (any JSON) | every office worker |
| `whiteboard_marks` | `comment`, `sticky`, `picture` | `card`, `kind`: `comment` \| `sticky` \| `picture`, `op`: `add` \| `reply` \| `edit` \| `resolve` \| `reopen` \| `move` \| `file` \| `reattach` \| `remove`, `id?` (thread/sticky/picture), `message?`, `text?`, `anchor?` (`{ on }` \| `{ selector, quote? }` \| `{ at: {x,y} }`, with `offset?`), `box?`, `color?`, `file?` | every office worker |
| `whiteboard_apply` | `office-whiteboard apply` | `ops` (array of the operations `apply` takes today) | every office worker |

Each tool returns a short readable `content` text and, where useful, `structuredContent`. Errors are `isError` results whose text says what to do next, never stack traces.

## Code layout

- `src/server/office-mcp/index.ts`: the server, its `instructions`, auth, per-caller filtering, the mount on the hook server, and the Droid connection config.
- `src/server/office-mcp/team.ts`, `whiteboard.ts`, `visits.ts`: one module per area, each exporting a `register(server, deps)` function. Each owns its tools' descriptions and its slice of the instructions.
- Tests: `tests/office-mcp*.test.ts`, calling tools through a real MCP client against the mounted server.
