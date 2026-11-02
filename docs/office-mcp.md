# The Office MCP

Status: in progress. The target is one MCP server, `droid-office`, replacing the three commands the office put on every agent's PATH (`office-workers`, `office-whiteboard`, `office-visit`) and the two skills it wrote into `~/.factory/skills` (`droid-office-subagents`, `droid-office-whiteboard`). What those commands' `help` text and the skills taught will live in the server's `instructions` and in each tool's description and parameter descriptions. Once migration is complete, there will be no other interface: the commands, the skills and their Settings toggles will be deleted.

The foundation is implemented: authenticated HTTP transport, caller filtering, `office_whoami`, Droid connection config, and the default-on `SubagentSettings.officeMcp` state. The other thirteen tools, UI and Android toggle, prompt migration and removal of the old commands/skills remain. Until that migration, the old interface still works.

## Decisions

- **Library.** [mcp-use](https://docs.mcp-use.com/llms.txt) **2.12.2**, pinned, with Zod **4.6.7**. Its `mcp:tools/list` middleware filters descriptors per request, and the office wrapper enforces the same predicate on calls. No FastMCP pivot was needed. SDK usage telemetry and automatic skill discovery are disabled: this embedded local server neither phones home nor discovers unrelated project skills.
- **Transport and mount.** Streamable HTTP, mounted on the office's hook server (`127.0.0.1:<hookPort>`) at `/office/mcp`, next to `/office/workers`, `/office/whiteboard` and `/office/visits`. The tools call the server-side code those endpoints call (`team.ts`, `whiteboard-agent.ts`, `visits.ts`) directly, not over HTTP.
- **Identity.** Every protocol request carries `Authorization: Bearer <DROID_OFFICE_HOOK_TOKEN>` and `x-droid-office-worker-id: <DROID_OFFICE_WORKER_ID>`. The token is resolved through `WorkerManager.authenticate`, exactly as the existing `/office/*` endpoints do. Missing, mismatched, revoked and non-agent identities are refused before protocol initialization; there are no anonymous tools.
- **How Droid connects.** The fallback shipped: one `droid-office` entry in `~/.factory/mcp.json`, with `oauth: false`, the loopback URL, and `${DROID_OFFICE_HOOK_TOKEN}` / `${DROID_OFFICE_WORKER_ID}` header references. Runtime `--settings` does **not** load `mcpServers` on tested Droid **1.1.0**. The office merges its entry atomically without clobbering other servers, refuses malformed files or a foreign entry with that name, and removes its own entry when Office MCP is off. Only local agents receive identity variables; shells, guests and cloud workers do not. A non-office session with those variables unset starts normally and gets no office tools or HTTP connection. The hook listener reuses its port across restarts, and startup refreshes the profile URL when needed. Tests and isolated copies can leave `Config.skillsDir` unset to avoid writing a Factory profile.
- **Hidden tools.** `tools/list` is filtered per caller: a subagent sees no hiring or visit tools, a worker that may not hire sees no team tools, visits off hides the visit tools. A hidden tool that's called anyway is refused with the reason.
- **No waiting.** `office-workers wait` is gone. Leads learn about their team from the office's wake notes; with ⚙️ Settings → Subagents & visits → "Wake the lead" off, they poll `team` with `action: "status"`. No tool blocks for long.
- **Non-blocking visits.** `visit_message` returns immediately with its `v-…` id and `delivered` or `queued` status, never waiting for a walk, permission prompt or answer. The normal walking delivery is initially queued: the visitor walks over, speaks and walks home, including for an ask (`walking` → `talking` → `returning`, with no waiting-for-answer pose). A question that cannot go in while the visitor is there remains queued, like a tell. `visit_look` reads a current terminal snapshot directly, without pretending the worker walked somewhere or waiting for an animation.
- **Ask lifetime and replies.** An undelivered ask expires 30 minutes after the visitor sets off; expiry removes its queued question so it cannot deliver late. Delivery starts a fresh **30-minute reply window**, independent of polling, the asker's turn, or the walk home. Only the addressed host may answer, once, with `visit_reply`. The answer is a new normal-priority delivery typed into the asker's session, like a tell: safe queues, permission dialogs and sleeping-worker resume still apply. It does not invent another walk. After expiry, `visit_reply` returns a clear “This ask expired” error and suggests `visit_message` for a tell or new ask. Worker departure, turning Visits off and office restart end open questions; nothing is persisted.
- **Files and images.** Whiteboard paths are resolved against the calling worker's working folder (its worktree or checkout), never the office's cwd. A PNG export comes back as MCP image content.
- **One toggle.** ⚙️ Settings gets one "Office MCP" switch (on by default) in place of the "Subagents skill installed" and "Whiteboard skill installed" toggles. Off: workers get no office tools. On startup the office deletes `~/.factory/skills/droid-office-subagents/SKILL.md` and `~/.factory/skills/droid-office-whiteboard/SKILL.md` only when they carry the office's mark (`SKILL_MARK` / `WHITEBOARD_SKILL_MARK`), and their folders when empty. The Android app follows (companion parity).
- **Prompts.** The system prompt's "Office commands" section and every notice that names a command (team update, lead/visit deliveries, Whiteboard ping, pipeline heal, cloud note) become short pointers to tool names. Detail lives in the server instructions and tool descriptions.
- **Out of scope.** Guests (droids started by hand) and Factory cloud workers get no office tools, as today.

## Foundation verification and extension

The spikes used the real installed `droid` **1.1.0**, a loopback HTTP MCP fixture and a fresh temporary `HOME` for each case. No model inference or changes to the owner's real Factory config were needed:

| Check (`droid exec --list-tools --output-format json -m glm-5.3-flash`) | Result |
| --- | --- |
| `--settings` containing `mcpServers`, literal or variable headers, `--only-tools MCP:office-spike` | Exit 1, unknown tool identifier, no HTTP request |
| Temporary `~/.factory/mcp.json`, variables set | Exit 0, `initialize` and `tools/list` received both expanded headers |
| Same profile, variables unset, ordinary tool listing | Exit 0, no MCP tools, no HTTP request |
| Shipped office wrapper and profile merger, `--only-tools MCP:droid-office` | Exit 0, `mcp_droid-office_office_whoami` allowed |

This matches [Droid's documented profile and header-expansion behavior](https://docs.factory.com/harness/mcp.md); URLs are literal, not variable-expanded. Real MCP HTTP clients also verified simultaneous callers, hidden direct-call refusals, live setting changes and revoked tokens. The installed-office clone rendered with all seven real floors, served `/` and `/dashboard`, refused anonymous `/office/mcp` calls, and removed/restored its profile entry when the setting changed.

An isolated `npm install mcp-use@2.12.2` added 54 packages and **69.4 MiB** on disk, including `@mcp-use/inspector` **20.3.27** (**1.8 MiB**) and `@mcp-use/cli` **4.5.5** (**0.8 MiB**). The existing checkout grew by about **59.1 MiB** after the pinned MCP/Zod install. This includes the framework's CLI/inspector and their peers; it is acceptable alongside the current app dependencies. mcp-use requires Node **22.22.2+**; CI and the packaged app use newer runtimes. Its optional React 19 peers coexist with the website's React 18; the website's Vite configuration deduplicates React to its workspace version so shared UI packages cannot bundle a second React identity.

Each module exports `instructions` and `register(server, deps)`. Register with `server.tool(definition, access, handler)`, where the definition contains its Zod object `inputSchema`. `access(caller)` returns `undefined` to allow or a readable refusal to hide and refuse the tool. Use `officeAccess.worker`, `.mayHire`, `.team`, `.subagent` or `.visits`. The handler receives `(args, caller)`; `caller` holds the authenticated `worker`, its `floor` (workers, team, visits, Whiteboard), live `settings` and absolute working `cwd`, including multi-repository workspaces. `OfficeMcpDeps` supplies the settings and worker-to-floor resolver. Return `officeResult(text, structuredContent)` or `officeError(text)`, or MCP image content. Never resolve file paths against the server's cwd.

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
