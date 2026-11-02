# The Office MCP

Status: implemented. One MCP server, `droid-office`, replaces the three commands the office used to put on every agent's PATH (`office-workers`, `office-whiteboard`, `office-visit`) and the two skills it wrote into `~/.factory/skills` (`droid-office-subagents`, `droid-office-whiteboard`). What those commands' `help` text and the skills taught lives in the server's `instructions` and in each tool's description and parameter descriptions. There is no other interface: the commands, their `/office/workers`, `/office/whiteboard` and `/office/visits` endpoints, the skills and their Settings toggles are deleted. On startup the office removes the old command folder (`.droid-office/bin/team`) from each floor.

## Decisions

- **External workers.** An opt-in, separate loopback listener behind Tailscale Serve provides the same worker permissions to external agents, without a dummy Droid or PTY. Per-worker credentials are revocable and separate from hook tokens. Their identities, teams, and inbox span floors: moving a desk does not strand subagents or conversations. See [External workers over Tailscale](guide/remote-workers.md) for provisioning, the network boundary, polling and persistence.

- **Library.** The official TypeScript SDK's server package, [`@modelcontextprotocol/server`](https://github.com/modelcontextprotocol/typescript-sdk) **2.3.1**, pinned, with Zod **4.6.7**. `createMcpHandler` serves stateless Streamable HTTP and builds a low-level `Server` per request for the authenticated caller, so its `tools/list` handler lists only the tools that caller may use and its `tools/call` handler applies the same predicate. Requests whose `Host` is not a loopback name are refused (`hostHeaderValidationResponse`), so a web page cannot reach the server by rebinding its own name. A small adapter (`node-http.ts`) turns the hook server's Node request into a web `Request` and streams the `Response` back. The SDK has no telemetry and discovers nothing on its own.
- **Transport and mount.** Streamable HTTP, mounted on the office's hook server (`127.0.0.1:<hookPort>`) at `/office/mcp`. The tools call the server-side code (`team.ts`, `whiteboard.ts` and `whiteboard-agent.ts`, `visits.ts`) directly, not over HTTP.
- **Identity.** Every protocol request carries `Authorization: Bearer <DROID_OFFICE_HOOK_TOKEN>` and `x-droid-office-worker-id: <DROID_OFFICE_WORKER_ID>`. The token is resolved through `WorkerManager.authenticate`, as the status hooks are. Missing, mismatched, revoked and non-agent identities are refused before protocol initialization; there are no anonymous tools.
- **How Droid connects.** The fallback shipped: one `droid-office` entry in `~/.factory/mcp.json`, with `oauth: false`, the loopback URL, and `${DROID_OFFICE_HOOK_TOKEN}` / `${DROID_OFFICE_WORKER_ID}` / `${DROID_OFFICE_HOOK_URL}` header references. Droid expands variables in headers but not in the URL, so offices on one machine share this entry: whichever office it points at relays a request whose `x-droid-office-url` names another loopback office to that office, so each worker always talks to its own. A live office that already holds a routing entry keeps it (checked with an `OPTIONS` probe); an office takes the entry over at startup and every 30 seconds once the holder stops answering, and removes it only while it points at itself. Runtime `--settings` does **not** load `mcpServers` on tested Droid **1.1.0**. The office merges its entry atomically without clobbering other servers, refuses malformed files or a foreign entry with that name, and removes its own entry when Office MCP is off. Office terminals, shells included, receive the variables for hooks and worktree setup reporting; the server accepts only local agents and refuses shells, guests and cloud workers. A non-office session with those variables unset starts normally and gets no office tools or HTTP connection. The hook listener reuses its port across restarts, and startup refreshes the profile URL when needed. Tests and isolated copies can leave `Config.skillsDir` unset to avoid writing a Factory profile.
- **Hidden tools.** `tools/list` is filtered per caller: a subagent sees no hiring or visit tools, a worker that may not hire sees no team tools, visits off hides the visit tools. A hidden tool that's called anyway is refused with the reason.
- **No waiting.** There is no wait tool. Leads learn about their team from the office's wake notes; with ⚙️ Settings → Subagents & visits → "Wake the lead" off, they poll `team` with `action: "status"`. No tool blocks for long.
- **Non-blocking visits.** `visit_message` returns immediately with its `v-…` id and `delivered` or `queued` status, never waiting for a walk, permission prompt or answer. The normal walking delivery is initially queued: the visitor walks over, speaks and walks home, including for an ask (`walking` → `talking` → `returning`, with no waiting-for-answer pose). A question that cannot go in while the visitor is there remains queued, like a tell. `visit_look` reads a current terminal snapshot directly, without pretending the worker walked somewhere or waiting for an animation.
- **Ask lifetime and replies.** An undelivered ask expires 30 minutes after the visitor sets off; expiry removes its queued question so it cannot deliver late. Delivery starts a fresh **30-minute reply window**, independent of polling, the asker's turn, or the walk home. Only the addressed host may answer, once, with `visit_reply`. The answer is a new normal-priority delivery typed into the asker's session, like a tell: safe queues, permission dialogs and sleeping-worker resume still apply. It does not invent another walk. After expiry, `visit_reply` returns a clear “This ask expired” error and suggests `visit_message` for a tell or new ask. Worker departure, turning Visits off and office restart end open questions; nothing is persisted.
- **Files and images.** Whiteboard paths are resolved against the calling worker's working folder (its worktree or checkout), never the office's cwd. A PNG export comes back as MCP image content.
- **One toggle.** ⚙️ Settings gets one "Office MCP" switch (on by default) in place of the "Subagents skill installed" and "Whiteboard skill installed" toggles. Off: workers get no office tools. On startup the office deletes `~/.factory/skills/droid-office-subagents/SKILL.md` and `~/.factory/skills/droid-office-whiteboard/SKILL.md` only when they carry the office's mark (`SKILL_MARK` / `WHITEBOARD_SKILL_MARK`), and their folders when empty. The Android app has never shown these settings, so it has nothing to follow.
- **Prompts.** The system prompt's "Office tools" section and every notice that used to name a command (team update, lead/visit deliveries, Whiteboard ping, pipeline heal, cloud note) are short pointers to tool names. Detail lives in the server instructions and tool descriptions.
- **Out of scope.** Guests (droids started by hand) and Factory cloud workers get no office tools, as today.

## How the connection was chosen, and adding a tool

The spikes used the real installed `droid` **1.1.0**, a loopback HTTP MCP fixture and a fresh temporary `HOME` for each case. No model inference or changes to the owner's real Factory config were needed:

| Check (`droid exec --list-tools --output-format json -m glm-5.3-flash`) | Result |
| --- | --- |
| `--settings` containing `mcpServers`, literal or variable headers, `--only-tools MCP:office-spike` | Exit 1, unknown tool identifier, no HTTP request |
| Temporary `~/.factory/mcp.json`, variables set | Exit 0, `initialize` and `tools/list` received both expanded headers |
| Same profile, variables unset, ordinary tool listing | Exit 0, no MCP tools, no HTTP request |
| Shipped office wrapper and profile merger, `--only-tools MCP:droid-office` | Exit 0, `mcp_droid-office_office_whoami` allowed |

This matches [Droid's documented profile and header-expansion behavior](https://docs.factory.com/harness/mcp.md); URLs are literal, not variable-expanded. Real MCP HTTP clients also verified simultaneous callers, hidden direct-call refusals, live setting changes and revoked tokens. The installed-office clone rendered with all seven real floors, served `/` and `/dashboard`, refused anonymous `/office/mcp` calls, and removed/restored its profile entry when the setting changed.

The office needs only an HTTP handler and per-caller tool lists, so it uses the SDK directly rather than a framework on top of it; mcp-use, tried first, also installed an inspector and CLI (about 69 MiB) and needed Node 22.22.2. An isolated `npm install @modelcontextprotocol/server@2.3.1` adds 3 packages: `server` and `core` (**7.7 MiB**) and Zod (**8.1 MiB**). Zod was only a transitive dependency before; the office now depends on it directly for the tool schemas. The SDK needs Node 20 or later, the office's existing floor. The tests' client is `@modelcontextprotocol/client` **2.3.1**, a dev dependency.

Each module exports `instructions` and `register(server, deps)`. Register with `server.tool(definition, access, handler)`, where the definition contains its Zod object `inputSchema`. `access(caller)` returns `undefined` to allow or a readable refusal to hide and refuse the tool. Use `officeAccess.worker`, `.mayHire`, `.team`, `.subagent` or `.visits`. The handler receives `(args, caller, signal)`; `signal` aborts when the caller cancels or disconnects, and a tool must not record that the caller saw a result after that (`whiteboard_read` then moves no read points); `caller` holds the authenticated `worker`, its `floor` (workers, team, visits, Whiteboard), live `settings` and absolute working `cwd`, including multi-repository workspaces. `OfficeMcpDeps` supplies the settings and worker-to-floor resolver. Return `officeResult(text, structuredContent)` or `officeError(text)`, or MCP image content. Never resolve file paths against the server's cwd.

## Tools

Fourteen local-worker tools, plus four external-worker tools. Names, inputs and who sees them are the contract between the modules; change them only by changing this table.

| Tool | Replaces | Input (all strings unless noted) | Who sees it |
| --- | --- | --- | --- |
| `office_whoami` | `office-workers whoami`, `office-visit whoami` | none | every office worker |
| `office_floors` | external worker floor discovery | none | external workers only |
| `office_move` | external worker desk/workspace selection | `floor` (id) | external workers only; preserves teams and inbox across floors |
| `office_inbox` | external worker delivery | `ack?` (exact message ids), `limit?` (1–100) | external workers only; no implicit acknowledgment |
| `office_status` | external worker self-reported activity | `status`: idle/working/done; `activity?` | external workers only |
| `team_models` | `office-workers models` | none | may hire |
| `team_hire` | `office-workers hire` | `title`, `brief`, `model?`, `effort?` (low/medium/high/xhigh/max), `from?` (ref), `worktree?` (boolean; omitted follows the owner's Subagents setting) | may hire |
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

For external workers, `team` additionally accepts `floor?`; without it, status
includes teams across all open floors. Names must be unambiguous, or use a worker
id. Remote status reads do not consume reports: acknowledge them through
`office_inbox`. Hiring and Whiteboard operations use the current floor;
`visit_reply` finds the original conversation even after the remote worker moves.
Local workers keep their existing floor scope and terminal delivery semantics.

## Code layout

- `src/server/office-mcp/index.ts`: the server, its `instructions`, auth, per-caller filtering, the mount on the hook server, and the Droid connection config.
- `src/server/office-mcp/team.ts`, `whiteboard.ts`, `visits.ts`: one module per area, each exporting a `register(server, deps)` function. Each owns its tools' descriptions and its slice of the instructions.
- Tests: `tests/office-mcp*.test.ts`, calling tools through a real MCP client against the mounted server.
