# Remote MCP reference

The office's Model Context Protocol (MCP) server for external workers: bots that run somewhere other than the office machine and join the office as a worker with a desk. [External workers over Tailscale](remote-workers.md) explains how to turn it on and add a bot in Settings. This page is the reference a bot's author needs: the endpoint, headers, keys, response formats and every tool.

The local workers' MCP (the `droid-office` entry the office writes to Droid's profile) uses the same tools and transport on the office's own hook server, with each worker's hook token. It is not covered here.

## Endpoint

```text
POST https://<office Mac's MagicDNS name>:<port>/office/mcp
```

Settings → **Phone & web** → **Tailscale MCP** shows the exact URL. The port is 8443 unless something else already serves it. It stays the same across restarts.

The endpoint is [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http), served **stateless**: there is no session id, and every request is independent. `GET` (a server-to-client stream) and `DELETE` (closing a session) answer `405`. The office implements protocol revisions `2025-06-18` and newer with the official MCP TypeScript SDK.

It answers only the owner's own Tailscale devices (a device signed in as the office Mac's Tailscale user, or a tagged device of the tailnet). It refuses browsers (any `Origin` header) and Funnel traffic. See [Reaching it from outside the tailnet](#reaching-it-from-outside-the-tailnet) for bots that are not on the tailnet.

## Headers

| Header | Required | Value |
| --- | --- | --- |
| `Authorization` | yes | `Bearer <key>`: the bot's main key or one of its named keys, from Settings. |
| `Content-Type` | yes | `application/json` |
| `Accept` | recommended | `application/json, text/event-stream` for the standard streamed answer, or `application/json` for one plain JSON body. See [Response formats](#response-formats). |
| `MCP-Protocol-Version` | after `initialize` | The version `initialize` returned, such as `2025-06-18`. |
| `x-droid-office-worker-id` | no | The bot's worker id (`remote-…`). Optional: the key already identifies the bot. If you send it, it must be the key's own bot, otherwise the request is refused. |

Every response that passed authentication carries `x-droid-office-worker-id` with the bot's worker id.

## Keys and the worker id

Each bot added in Settings gets a worker id and a **main key** (64 hex characters). The office issues both: the bot never makes up its own id.

- **The key alone is enough.** A client that sends only `Authorization: Bearer <key>` is the bot that key belongs to. `initialize` says so in its `instructions` ("You are Grok, worker id remote-…"), every response carries the id in the `x-droid-office-worker-id` header, and `office_whoami` returns it. Clients that already send the header keep working unchanged.
- **Named keys.** A bot can hold up to 10 more keys, each with its own name (`laptop`, `relay`), for the different clients it runs as. Every key acts as the same bot, with the same desk, team and inbox. Revoking one stops only that client. Add and revoke them in the bot's row in Settings.
- **Last used.** Settings shows when the main key and each named key last connected, to the minute.
- **New key** replaces the main key, and the old one stops working at once. Named keys keep working.
- **Remove** revokes every key of the bot and frees its desk.

The office keeps keys in `.droid-office/remote-workers.json` (mode `0600`). Settings shows them only on the office's own computer. A key carries the bot's full worker permissions, including hiring agents that run on the owner's machine and reading files through the Whiteboard tools. Give a key only to a client you trust as much as the bot itself.

Full MCP OAuth (a client that signs itself in) is not supported: a human copies a key from Settings into the client once.

## Response formats

- **`Accept: application/json, text/event-stream`** (what the MCP SDKs send): each answer is a short Server-Sent Events stream, one `event: message` with the JSON-RPC response in its `data:` line. This is unchanged from before.
- **`Accept: application/json`** (or `*/*`, or no `Accept` at all): one plain JSON-RPC response with `Content-Type: application/json`. Use this from curl or a plain HTTP client. Progress and log notifications sent during a call are dropped in this mode; the office's tools send none.
- Any other `Accept`, such as `text/html` alone, is refused with `406`.

Errors before MCP starts are plain JSON with an `error` string:

| Status | Meaning |
| --- | --- |
| `401` | The key is missing, wrong or revoked; the `x-droid-office-worker-id` sent is not the key's bot; or Office MCP is off in Settings → Subagents & visits. |
| `403` | Not one of the owner's Tailscale devices, a browser request, a Funnel request, or a wrong `Host`. |
| `503` | The office is not serving on the tailnet yet. |

## Example with curl

Set the URL and key from Settings:

```bash
URL='https://office-mac.tailXXXX.ts.net:8443/office/mcp'
KEY='<64 hex characters from Settings>'
```

Initialize, then call tools. With `Accept: application/json`, each answer is one JSON object:

```bash
curl -sS "$URL" \
  -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'

curl -sS "$URL" \
  -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  -H 'MCP-Protocol-Version: 2025-06-18' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"office_inbox","arguments":{"limit":20}}}'
```

The first answer's `result.instructions` names the bot's worker id, and `curl -i` shows it in the `x-droid-office-worker-id` response header. A tool's result has `content` (text for the model) and, for most tools, `structuredContent` (the same data as JSON). `isError: true` marks a refused or failed call.

## MCP client configuration

Most MCP clients take an `mcpServers` entry. **Copy config** in Settings gives exactly this, with the URL, key and worker id filled in:

```json
{
  "mcpServers": {
    "droid-office": {
      "type": "http",
      "url": "https://office-mac.tailXXXX.ts.net:8443/office/mcp",
      "headers": {
        "Authorization": "Bearer <key>",
        "x-droid-office-worker-id": "remote-<id>"
      }
    }
  }
}
```

The `x-droid-office-worker-id` line may be left out. The client must support Streamable HTTP and custom headers. It needs no session support and no push integration.

## Reaching it from outside the tailnet

The office never turns on [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) and refuses any request that comes through it: a public URL in front of a key that can hire agents on the owner's machine is too much exposure to be a default. Bots outside the tailnet have two options, both set up by the owner and outside the office.

**Put the bot's host on the tailnet (preferred).** Run Tailscale where the bot runs: on a server, in its container (for example the `tailscale/tailscale` image with `TS_USERSPACE=true`), or with userspace networking where the bot can't use a TUN device. Use a [tagged](https://tailscale.com/kb/1068/tags) auth key so the machine joins as a tagged device rather than as your user, and an [access control rule](https://tailscale.com/kb/1018/acls) that lets that tag reach only the office Mac's MCP port. The bot then calls the normal URL directly.

**Relay through a trusted machine.** A machine that is on the tailnet and that the bot can reach (a VPS or a home server) runs a small reverse proxy that forwards to the office's MCP URL. The office sees the relay as the requesting device, so the relay must be a tagged device or signed in as the owner. If the relay itself is published with Funnel or a public address, then:

- The relay is now the security boundary. Require its own credential (mutual TLS, an allowlist of the bot's IP addresses, or a separate secret) before forwarding anything. Never forward unauthenticated traffic and rely on the office key alone.
- Give the relay's bot a **named key** of its own, so revoking it in Settings cuts off the relay without touching the bot's other clients. Watch its **last used** time.
- Forward only `POST /office/mcp`. Do not forward `Origin`, and never forward `Tailscale-*` headers from the public side: Tailscale Serve sets these, and the office trusts them only on its own loopback listener.
- Keep TLS end to end, log requests on the relay, and rate limit it.
- A key on a public path can still do everything the bot can, including hiring agents that run commands on the owner's machine. Turn the relay off when the bot doesn't need it.

## Tools

Every tool a remote bot sees in `tools/list` when settings allow it. Visits need **Visits between workers** on. Hiring and the focused owner tools do not depend on the Subagents permission, model allowlist or team-size limit; office capacity, model availability and the owner's normal action checks still apply. Turning off **Office MCP** or revoking a bot's key cuts off access.

**Choosing a tool:**
- Manage your own subagents with `team_*`, `worker_log`, `worker_diff`, `questions_list` and `question_answer`.
- Coordinate with independent peers through `visit_*`. These are worker messages, not owner instructions.
- Inspect the whole building with `office_roster`, `office_look` and `office_worker_thread`.
- Direct another worker as the owner with `office_worker_prompt`; use `office_terminal_write` or `office_shell_write` only for literal terminal input.
- Use the named floor, forge, pipeline, configuration, connection, picture and jukebox tools below for other owner operations. There is no `office_owner` gateway and no untyped `args` object.

Every owner operation has a strict input schema, including nested objects. Unknown fields are refused. Floor references accept an id, elevator number or name. Worker references accept an id or unambiguous name; an explicitly supplied floor must contain that worker. Worker operations follow the target worker's floor, other floor operations default to the bot's current floor, and office-wide tools accept no floor. Internal protocol fields and request ids are supplied by the server.

Owner action results contain `status: done | pending | unconfirmed`, notes, and any bounded reply; refusals return `isError`. `pending` means no confirmed outcome within 30 seconds. `unconfirmed` means the handler neither confirmed nor refused it. Neither is a safe reason to retry a mutation. `office_send_home` keeps worktrees, branches and cloud sessions unless deletion is explicitly requested.

A bot's key still conveys owner-level authority, including terminal execution, remote writes and destructive actions. The split makes each operation explicit; it is not a permission reduction. Local workers do not see these owner tools. Whiteboard paths and `cwd` values refer to the **office machine**, not the bot's host.

`tests/remote-mcp.test.ts` checks this reference against the live MCP tool list and arguments. `tests/office-mcp-owner.test.ts` verifies every original owner action has a focused replacement.

### `office_whoami`

Read your office identity, desk, lead if you are a subagent, permission to hire and visit, owner access, team size, worktree default and wake-note setting. Use this to establish your role before coordinating work. It does not hire, message or wait.

No arguments.

For an external worker, the subagent count covers all open floors, including teams left behind after `office_move`.

### `office_floors`

List open floors, your current workspace, and your teams and unread team updates on each floor.

No arguments.

### `office_move`

Move your desk and active workspace to another floor. Existing subagents, messages and conversations stay accessible across floors. Refused only when the destination is unavailable or has no suitable free seat.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `floor` | string | yes | Exact floor id from office_floors |

### `office_inbox`

Read messages and team updates from all floors without consuming them. Acknowledge exact ids only after processing them, in a later call. Returns at most limit messages and a remaining count. No waiting, push delivery or automatic acknowledgment.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `ack` | string[] | no, default `[]` | Exact message ids from an earlier call to acknowledge, at most 500. |
| `limit` | integer | no, default `50` | Messages to return, 1 to 100. |

### `office_status`

Set your self-reported office status and optional short activity. This does not launch, stop, or cancel your external process.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `status` | "idle" \| "working" \| "done" | yes | Shown at your desk. |
| `activity` | string | no | A short line of what you're doing, at most 140 characters. |

### `office_roster`

List every worker in the building, or on one floor: id, name, floor id and number (1-based, the elevator's order), desk, status, task, model, lead, and whether it is you or your own subagent. Includes owner-hired workers, subagents, shells, cloud and external workers.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `floor` | string | no | Floor id, number (1 is the top of the elevator list) or name. |

### `office_look`

Read the end of any worker's terminal, on any floor, without typing anything. name "office-shell" reads the floor's boss shell. At most 48,000 characters, with a truncation marker if older text was omitted. A snapshot, not a transcript; for conversation history or a cloud worker use office_worker_thread.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | yes | Worker name or id, case-insensitive. Use office_roster to find it. |
| `floor` | string | no | Floor id, number (1 is the top of the elevator list) or name. |
| `lines` | integer | no, default `80` | Latest terminal lines, default 80, at most 400. |

### `office_send_home`

Send any worker home, on any floor, exactly as the owner's SEND HOME does: owner-hired workers, other leads' subagents, external workers, you or your lead. cleanup keep (the default) leaves its worktree and branch; worktree deletes the worktree and keeps the branch; all deletes both, including commits no remote has. deleteSession true also deletes a cloud worker's Factory session, only when the owner asked. The reply preserves the target and pre-dismissal worktree report even when the outcome is uncertain. Its subagents stay, without a lead.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | yes | Worker name or id, case-insensitive. Use office_roster to find it. |
| `floor` | string | no | Floor id, number (1 is the top of the elevator list) or name. |
| `cleanup` | "keep" \| "worktree" \| "all" | no, default `"keep"` | What becomes of its worktree. Default keep. Use worktree or all only when the owner asked to delete it. |
| `deleteSession` | boolean | no, default `false` | Also delete a cloud worker’s Factory session, only when the owner asked. Otherwise it is kept. |

### `office_floor_reorder`

Move a floor before another in elevator order, or to the end. Does not move its workers or files.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `floor` | string | yes | Floor id, elevator number or name. Omit for the target worker’s floor, otherwise your current floor. |
| `before` | string \| null | yes | Floor to place this one before; null puts it last. |

### `office_repositories_list`

List local checkouts eligible to become office floors. Does not clone or add them.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `refresh` | boolean | no | Rescan the workspace instead of using its cached list. |

### `office_folders_list`

List subfolders on the office machine, with checkout and eligibility information.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `dir` | string | no | Absolute folder path; omit for the workspace folder. |

### `office_floor_branches`

List the selected floor’s local/origin branches and its current and default base.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `floor` | string | no | Floor id, elevator number or name. Omit for the target worker’s floor, otherwise your current floor. |

### `office_floor_branch_set`

Safely change the selected floor’s worker base branch. Existing work or workers can prevent switching.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `floor` | string | no | Floor id, elevator number or name. Omit for the target worker’s floor, otherwise your current floor. |
| `branch` | string \| null | yes | Existing local or origin branch; null restores the repository default. |

### `office_floor_add`

Add an existing folder as a floor. Git checkouts must be in the workspace; plain folders may be elsewhere. Does not clone or move files.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `dir` | string | yes | Absolute existing folder on the office machine. |

### `office_floor_remove`

Remove a floor from the building. Its folder stays on disk and external desks are rehomed. Home cannot be removed.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `floor` | string | yes | Floor id, elevator number or name. Omit for the target worker’s floor, otherwise your current floor. |

### `office_workspace_set`

Change where the office searches for repositories. This is an office-wide setting.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `dir` | string | yes | Absolute workspace folder; empty string restores the default. |

### `office_worker_spawn`

Hire an independent worker, shell or cloud worker on a floor. For a subagent that reports to you, use team_hire instead. Cloud hires can incur charges.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `floor` | string | no | Floor id, elevator number or name. Omit for the target worker’s floor, otherwise your current floor. |
| `deskId` | string | no, default `"auto"` | Seat id, or auto for the first free seat. |
| `prompt` | string | no |  |
| `worktree` | boolean | no | Use an isolated Git worktree for a local agent. |
| `kind` | "agent" \| "shell" \| "cloud" | no, default `"agent"` |  |
| `model` | string | no | Exact model id from models_list; must be available. |
| `effort` | "low" \| "medium" \| "high" \| "xhigh" \| "max" | no | Reasoning effort supported by the selected model. |
| `issue` | integer | no | Issue to assign to this worker on the floor’s forge. |
| `repos` | string[] | no | Additional open repository floor ids for a multi-repository worker. |
| `images` | string[] | no | Existing office-upload image ids, not paths or image bytes. |
| `cloud` | object | no | Required for kind cloud; choose a Factory computer or environment. |
| `cloud.computerId` | string | no | Existing Factory computer id. Choose this or environmentId, not both. |
| `cloud.environmentId` | string | no | Factory environment id; starts a computer for this worker, which may incur charges. |
| `cloud.cwd` | string | no | Working folder on that remote computer; omit for its home. |

### `office_worker_fork`

Fork an idle or done worker’s conversation and work into a new worker. Git floors copy committed and uncommitted work into a new worktree; plain floors share files.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `workerId` | string | yes | Worker id or unambiguous name from office_roster. May target any worker, not only your subagents. |
| `floor` | string | no | Floor id, elevator number or name. Omit for the target worker’s floor, otherwise your current floor. |
| `prompt` | string | no |  |

### `office_worker_resume`

Resume an existing stopped or sleeping worker’s saved session.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `workerId` | string | yes | Worker id or unambiguous name from office_roster. May target any worker, not only your subagents. |
| `floor` | string | no | Floor id, elevator number or name. Omit for the target worker’s floor, otherwise your current floor. |

### `office_worker_shoot`

Apply the office’s shot effect to a worker. A fully charged superShot dismisses it and deletes owned worktrees and branches, including unpushed work. Prefer office_send_home with cleanup keep for ordinary dismissal.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `workerId` | string | yes | Worker id or unambiguous name from office_roster. May target any worker, not only your subagents. |
| `floor` | string | no | Floor id, elevator number or name. Omit for the target worker’s floor, otherwise your current floor. |
| `superShot` | boolean | no, default `false` | True requests destructive charged-shot dismissal. Use only when the owner explicitly requested it. |

### `office_worker_worktree`

Inspect any worker’s worktree, including uncommitted files and commits on no remote. Does not modify it.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `workerId` | string | yes | Worker id or unambiguous name from office_roster. May target any worker, not only your subagents. |
| `floor` | string | no | Floor id, elevator number or name. Omit for the target worker’s floor, otherwise your current floor. |

### `office_worker_rebuild`

Recreate a lost worker’s worktree and restart it from its recoverable branch.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `workerId` | string | yes | Worker id or unambiguous name from office_roster. May target any worker, not only your subagents. |
| `floor` | string | no | Floor id, elevator number or name. Omit for the target worker’s floor, otherwise your current floor. |
| `all` | boolean | no, default `false` | True rebuilds every lost worker on this worker’s floor, not just the named worker. |

### `office_worker_prompt`

Send a prompt to any worker as the owner. Use team_message for your own subagents and visit_message for peer coordination. This is not raw terminal input.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `workerId` | string | yes | Worker id or unambiguous name from office_roster. May target any worker, not only your subagents. |
| `floor` | string | no | Floor id, elevator number or name. Omit for the target worker’s floor, otherwise your current floor. |
| `prompt` | string | yes |  |
| `issue` | integer | no |  |
| `images` | string[] | no | Existing office-upload image ids, not paths or image bytes. |
| `queue` | boolean | no, default `false` | Queue behind the current turn using Ctrl+Enter instead of sending immediately. |

### `office_worker_answer`

Answer a worker’s currently displayed menu as the owner. Supply its exact menu snapshot; changed menus are refused. Unlike question_answer, this is owner-level terminal control.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `workerId` | string | yes | Worker id or unambiguous name from office_roster. May target any worker, not only your subagents. |
| `floor` | string | no | Floor id, elevator number or name. Omit for the target worker’s floor, otherwise your current floor. |
| `menu` | object | yes | Exact menu snapshot from the worker’s screen. The server refuses an answer if the menu changed. |
| `menu.question` | string | no | Exact question currently shown. |
| `menu.choices` | object[] | yes | The currently displayed options, in order, with their original numbers and labels. |
| `menu.pointer` | integer | no | Currently focused zero-based option. |
| `menu.freeText` | boolean | yes | Whether the displayed menu accepts a typed answer. |
| `menu.multiSelect` | boolean | no | Whether the displayed menu has checkboxes. |
| `choice` | integer | no | One displayed option number; not with choices or text. |
| `choices` | integer[] | no | Complete set of checkbox option numbers; may accompany text. |
| `text` | string | no | Typed answer, optionally accompanying checkbox choices. |

### `office_worker_pr_create`

Push a worker’s branch and create a pull/merge request drafted from its task. Publishes to the floor’s forge.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `workerId` | string | yes | Worker id or unambiguous name from office_roster. May target any worker, not only your subagents. |
| `floor` | string | no | Floor id, elevator number or name. Omit for the target worker’s floor, otherwise your current floor. |

### `office_worker_interrupt`

Interrupt any worker’s current turn without dismissing it. Sends Escape locally or interrupts its Factory session.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `workerId` | string | yes | Worker id or unambiguous name from office_roster. May target any worker, not only your subagents. |
| `floor` | string | no | Floor id, elevator number or name. Omit for the target worker’s floor, otherwise your current floor. |

### `office_worker_thread`

Read one page of any local or cloud agent’s conversation. Does not attach or type into its terminal. Returns a bounded snapshot and pagination information.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `workerId` | string | yes | Worker id or unambiguous name from office_roster. May target any worker, not only your subagents. |
| `floor` | string | no | Floor id, elevator number or name. Omit for the target worker’s floor, otherwise your current floor. |
| `before` | integer | no | Exclusive entry sequence for older history; omit for the newest page. |

### `office_terminal_write`

Send raw input to any worker’s terminal as the owner. Can run commands, interrupt work or approve prompts. Prefer office_worker_prompt for normal instructions.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `workerId` | string | yes | Worker id or unambiguous name from office_roster. May target any worker, not only your subagents. |
| `floor` | string | no | Floor id, elevator number or name. Omit for the target worker’s floor, otherwise your current floor. |
| `data` | string | yes | Literal terminal input, including control characters. Include \r to press Enter. This can execute commands or answer permission prompts. |

### `office_station_open`

Start or wake a floor’s board agent and return its worker id. Does not open a terminal stream for this bot.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `floor` | string | no | Floor id, elevator number or name. Omit for the target worker’s floor, otherwise your current floor. |
| `deskId` | string | yes | Board station id, such as station-lead, station-issues, station-pulls or station-actions. |

### `office_station_prompt`

Send a prompt to a board agent, hiring or waking it if needed. Model and effort only apply when hiring.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `floor` | string | no | Floor id, elevator number or name. Omit for the target worker’s floor, otherwise your current floor. |
| `deskId` | string | yes |  |
| `prompt` | string | yes |  |
| `model` | string | no | Exact model id from models_list; must be available. |
| `effort` | "low" \| "medium" \| "high" \| "xhigh" \| "max" | no | Reasoning effort supported by the selected model. |
| `images` | string[] | no | Existing office-upload image ids, not paths or image bytes. |

### `office_shell_write`

Send raw input to the selected floor’s boss shell as the owner. May execute arbitrary commands. Read it first with office_look name office-shell.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `floor` | string | no | Floor id, elevator number or name. Omit for the target worker’s floor, otherwise your current floor. |
| `data` | string | yes | Literal terminal input, including control characters. Include \r to press Enter. This can execute commands or answer permission prompts. |

### `office_forge_refresh`

Refresh the selected floor’s issue and pull/merge request boards from its forge.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `floor` | string | no | Floor id, elevator number or name. Omit for the target worker’s floor, otherwise your current floor. |

### `office_pull_merge`

Merge a pull/merge request on the selected floor’s forge, or enable automatic merging. This changes the remote repository.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `floor` | string | no | Floor id, elevator number or name. Omit for the target worker’s floor, otherwise your current floor. |
| `number` | integer | yes |  |
| `method` | "squash" \| "merge" \| "rebase" | yes |  |
| `deleteBranch` | boolean | no, default `false` | Delete the remote source branch after merging. |
| `auto` | boolean | no, default `false` | Enable automatic merge when required checks pass instead of merging immediately. |

### `office_forge_comment`

Post a comment on an issue or pull/merge request using the owner’s forge account.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `floor` | string | no | Floor id, elevator number or name. Omit for the target worker’s floor, otherwise your current floor. |
| `kind` | "issue" \| "pull" | yes | Issue or pull/merge request. |
| `number` | integer | yes |  |
| `body` | string | yes |  |

### `office_forge_close`

Close an issue or close a pull/merge request without merging it. Optional comment is posted publicly to that repository.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `floor` | string | no | Floor id, elevator number or name. Omit for the target worker’s floor, otherwise your current floor. |
| `kind` | "issue" \| "pull" | yes | Issue or pull/merge request. |
| `number` | integer | yes |  |
| `comment` | string | no |  |
| `reason` | "completed" \| "not planned" | no | Issue closing reason. |
| `deleteBranch` | boolean | no, default `false` | Also delete the pull/merge request’s remote source branch. |

### `office_forge_labels`

Add and remove labels on an issue or pull/merge request using the owner’s forge account.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `floor` | string | no | Floor id, elevator number or name. Omit for the target worker’s floor, otherwise your current floor. |
| `kind` | "issue" \| "pull" | yes | Issue or pull/merge request. |
| `number` | integer | yes |  |
| `add` | string[] | no, default `[]` |  |
| `remove` | string[] | no, default `[]` |  |

### `office_gong_ring`

Ring the gong on the selected floor.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `floor` | string | no | Floor id, elevator number or name. Omit for the target worker’s floor, otherwise your current floor. |

### `office_pipelines_refresh`

Refresh the floor’s GitHub Actions runs or GitLab pipelines.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `floor` | string | no | Floor id, elevator number or name. Omit for the target worker’s floor, otherwise your current floor. |

### `office_pipeline_detail`

Read a pipeline or workflow run’s jobs and steps.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `floor` | string | no | Floor id, elevator number or name. Omit for the target worker’s floor, otherwise your current floor. |
| `id` | integer | yes |  |

### `office_pipeline_rerun`

Rerun a completed workflow or pipeline. Can incur CI costs.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `floor` | string | no | Floor id, elevator number or name. Omit for the target worker’s floor, otherwise your current floor. |
| `id` | integer | yes |  |
| `failed` | boolean | yes | True reruns failed jobs only; false reruns the whole run. |

### `office_pipeline_cancel`

Cancel a queued or running workflow/pipeline.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `floor` | string | no | Floor id, elevator number or name. Omit for the target worker’s floor, otherwise your current floor. |
| `id` | integer | yes |  |

### `office_pipeline_run`

Start a workflow or pipeline on a Git ref. Can execute deployment workflows and incur CI costs.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `floor` | string | no | Floor id, elevator number or name. Omit for the target worker’s floor, otherwise your current floor. |
| `workflow` | string | yes | GitHub workflow id/name; use pipeline on GitLab. |
| `ref` | string | yes | Branch or tag to run. |
| `inputs` | object | no | Workflow inputs, or GitLab pipeline variables, as string values. |

### `office_leave_on_merge_set`

Set office-wide automatic dismissal after a worker’s PR merges. Enabled cleanup deletes its worktree and branch after it rests.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `on` | boolean | yes | True enables this setting; false disables it. |

### `office_fresh_main_set`

Set whether fresh workers start from the latest default branch or the checkout’s current branch.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `on` | boolean | yes | True enables this setting; false disables it. |

### `office_auto_heal_set`

Set whether a failed pipeline wakes this floor’s Pipeline agent to diagnose it and hire a fix worker.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `floor` | string | no | Floor id, elevator number or name. Omit for the target worker’s floor, otherwise your current floor. |
| `on` | boolean | yes | True enables this setting; false disables it. |

### `office_model_visibility_set`

Hide or show a model in every device’s picker. Does not block model use or alter workers.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string \| null | yes | Exact model id; null with hidden false shows all models. |
| `hidden` | boolean | yes |  |

### `office_worker_labels_set`

Replace the office-wide worker-label generation settings. Custom label scripts execute as the owner.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `settings` | object | yes | Complete replacement of worker-label settings. A custom executable runs with the owner’s permissions. |
| `settings.on` | boolean | yes |  |
| `settings.implementation` | "droid" \| "custom" | no | Custom runs an executable as the owner; omitted uses Droid. |
| `settings.command` | string | no | Absolute executable path on the office machine for custom labels. |
| `settings.args` | string[] | no | Literal executable arguments, not a shell command. |
| `settings.model` | string | yes | Exact model id from models_list; must be available. |
| `settings.effort` | "off" \| "none" \| "minimal" \| "low" \| "medium" \| "high" \| "xhigh" \| "max" | yes |  |
| `settings.intervalSeconds` | integer | yes | Seconds between label refreshes, 15 to 3600. |

### `office_subagents_set`

Replace the office-wide Subagents settings. Setting officeMcp false immediately cuts off this bot’s access. External bots retain owner-level hiring while MCP is enabled.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `settings` | object | yes | Complete replacement of the office-wide Subagents settings, not a patch. |
| `settings.officeMcp` | boolean | yes | False immediately disables this MCP connection as well as local workers’ access. |
| `settings.on` | boolean | yes | Allow local workers to hire subagents. |
| `settings.deskWorkers` | boolean | yes | Allow local desk workers, not just station leads, to hire. |
| `settings.agent` | object | no | Default subagent model and effort; omit to inherit the office default. |
| `settings.agent.model` | string | no | Exact model id from models_list; must be available. |
| `settings.agent.effort` | "low" \| "medium" \| "high" \| "xhigh" \| "max" | no | Reasoning effort supported by the selected model. |
| `settings.models` | object[] | no | Allowed local subagent models with routing notes; omit for unrestricted. |
| `settings.worktree` | boolean | yes | Default to isolated worktrees for subagents. |
| `settings.maxPerLead` | integer | yes | Local lead’s maximum team size. |
| `settings.wakeLead` | boolean | yes | Wake resting leads when their teams have news. |
| `settings.visits` | boolean | yes | Enable visits between independent workers. |
| `settings.denyTask` | boolean | yes | Direct local workers to Office hiring instead of the built-in Task tool. |

### `office_prompt_set`

Replace one office-authored prompt, or restore its default. Affects future uses of that prompt.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | "worker.system" \| "issue.work" \| "issue.ask" \| "pull.review" \| "pull.fixMerge" \| "pull.fixConflicts" \| "pull.ask" \| "changes.ship" \| "station.issues" \| "station.pulls" \| "station.actions" \| "pipeline.heal" \| "station.lead" \| "subagent.brief" \| "subagent.nudge" \| "subagent.report" \| "subagent.message" \| "visit.tell" \| "visit.ask" \| "visit.reply" \| "visit.handoff" \| "whiteboard.ping" \| "whiteboard.button" \| "cloud.context" \| "cloud.environment" \| "worker.repos" \| "worktree.setup" \| "wand.ship" \| "office.namer" | yes |  |
| `text` | string \| null | yes | Replacement prompt; null restores the default. |

### `office_default_agent_set`

Set the default model and effort for newly hired workers; null restores the office’s configured agent.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `choice` | object \| null | yes |  |
| `choice.model` | string | no | Exact model id from models_list; must be available. |
| `choice.effort` | "low" \| "medium" \| "high" \| "xhigh" \| "max" | no | Reasoning effort supported by the selected model. |

### `office_worktree_setup_get`

Read how new worktrees on the selected floor are prepared.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `floor` | string | no | Floor id, elevator number or name. Omit for the target worker’s floor, otherwise your current floor. |

### `office_worktree_setup_set`

Replace this floor’s worktree setup command and copied files. The command runs as the owner in future worktrees.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `floor` | string | no | Floor id, elevator number or name. Omit for the target worker’s floor, otherwise your current floor. |
| `setup` | object \| null | yes | Null restores repository-defined or detected setup. |
| `setup.setup` | string | yes | Shell setup command; empty means no command. |
| `setup.copy` | string[] | yes | Repository-relative ignored files or folders to copy into new worktrees. |

### `office_worker_limit_set`

Set the building-wide worker capacity. The startup ceiling still applies.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | integer \| null | yes | Maximum workers, or null to remove the user-set limit. |

### `office_jira_connect`

Replace the office’s Jira Cloud connection. Sends the provided credential to that Jira site.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `site` | string | yes | Jira Cloud site hostname or URL. |
| `email` | string | yes |  |
| `token` | string | yes | Owner-authorized Jira API token. |

### `office_jira_disconnect`

Forget the office’s Jira connection.

No arguments.

### `office_jira_epic_set`

Choose the Jira epic shown on this floor.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `floor` | string | no | Floor id, elevator number or name. Omit for the target worker’s floor, otherwise your current floor. |
| `key` | string | yes | Epic key; empty string removes the selected epic. |

### `office_jira_refresh`

Refresh the selected floor’s Jira tab.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `floor` | string | no | Floor id, elevator number or name. Omit for the target worker’s floor, otherwise your current floor. |

### `office_factory_connect`

Replace the office’s Factory connection with an owner-authorized API key.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `key` | string | yes | Factory API key. Do not put it in progress notes or artifacts. |

### `office_factory_disconnect`

Forget the office’s Factory key and the data read with it.

No arguments.

### `office_factory_refresh`

Refresh one Factory feature, or recheck the key and refresh all features.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `feature` | "computers" \| "environments" \| "sessions" \| "ci" \| "wiki" \| "cloud" | no |  |

### `office_setup_check`

Recheck Droid installation/sign-in and DroidProxy status.

No arguments.

### `office_droid_install`

Install or update Droid on the office machine. Downloads and runs the installer.

No arguments.

### `office_droid_sign_in`

Start Droid’s Factory sign-in on the office machine. The owner may need to complete browser/device-code authorization.

No arguments.

### `office_droid_sign_in_cancel`

Cancel a pending Droid sign-in.

No arguments.

### `office_onboarding_set`

Mark the welcome as completed, or request that it be shown again.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `done` | boolean | yes | True marks onboarding complete; false shows it again. |

### `office_proxy_install`

Install or update DroidProxy on the office machine.

No arguments.

### `office_proxy_start`

Start the installed DroidProxy service.

No arguments.

### `office_proxy_open`

Open DroidProxy’s own settings window on the office machine.

No arguments.

### `office_subscription_connect`

Start connecting a subscription account. Opens browser sign-in or device-code authorization for the owner.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `provider` | "claude" \| "codex" \| "antigravity" \| "kimi" \| "junie" \| "grok" \| "copilot" \| "meta" | yes | Subscription provider. |

### `office_subscription_connect_cancel`

Cancel a pending subscription-provider sign-in.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `provider` | "claude" \| "codex" \| "antigravity" \| "kimi" \| "junie" \| "grok" \| "copilot" \| "meta" | yes | Subscription provider. |

### `office_subscription_disconnect`

Forget one connected subscription account.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `provider` | "claude" \| "codex" \| "antigravity" \| "kimi" \| "junie" \| "grok" \| "copilot" \| "meta" | yes | Subscription provider. |
| `account` | string | yes | Exact account id from the subscription state. |

### `office_subscription_provider_set`

Enable or disable the models supplied by one subscription provider.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `provider` | "claude" \| "codex" \| "antigravity" \| "kimi" \| "junie" \| "grok" \| "copilot" \| "meta" | yes | Subscription provider. |
| `enabled` | boolean | yes |  |

### `office_subscription_models_sync`

Replace DroidProxy-managed model entries in Droid’s settings with the current catalogue.

No arguments.

### `office_subscriptions_refresh`

Recheck DroidProxy and subscription accounts.

No arguments.

### `office_changes_diff`

Read one changed file’s diff from any worker’s checkout. Unlike worker_diff, this is one file and may target workers outside your team.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `workerId` | string | yes | Worker id or unambiguous name from office_roster. May target any worker, not only your subagents. |
| `floor` | string | no | Floor id, elevator number or name. Omit for the target worker’s floor, otherwise your current floor. |
| `path` | string | yes | Repository-relative changed file path. |
| `repo` | string | no | Another repository of this worker’s multi-repository workspace; omit for its own. |

### `office_changes_commit`

Commit the changes in a worker’s checkout with the supplied message.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `workerId` | string | yes | Worker id or unambiguous name from office_roster. May target any worker, not only your subagents. |
| `floor` | string | no | Floor id, elevator number or name. Omit for the target worker’s floor, otherwise your current floor. |
| `message` | string | yes | Commit message. |
| `repo` | string | no | Another repository of this worker’s multi-repository workspace; omit for its own. |

### `office_changes_discard`

Permanently discard uncommitted changes in a worker’s checkout. Omit path only when the owner explicitly asked to discard all changes.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `workerId` | string | yes | Worker id or unambiguous name from office_roster. May target any worker, not only your subagents. |
| `floor` | string | no | Floor id, elevator number or name. Omit for the target worker’s floor, otherwise your current floor. |
| `path` | string | no | Repository-relative file; omit to discard every uncommitted change. |
| `repo` | string | no | Another repository of this worker’s multi-repository workspace; omit for its own. |

### `office_changes_pr_create`

Push a worker’s changes and open a pull/merge request with an explicit title and description.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `workerId` | string | yes | Worker id or unambiguous name from office_roster. May target any worker, not only your subagents. |
| `floor` | string | no | Floor id, elevator number or name. Omit for the target worker’s floor, otherwise your current floor. |
| `title` | string | yes |  |
| `body` | string | yes |  |
| `repo` | string | no | Another repository of this worker’s multi-repository workspace; omit for its own. |

### `office_upgrade_check`

Check for a source-office upgrade. Packaged Mac app updates use a separate mechanism.

No arguments.

### `office_upgrade_start`

Start an available source-office upgrade, build and restart. This can interrupt the office and this MCP connection.

No arguments.

### `office_picture_add`

Hang an image on a wall of the selected floor.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `floor` | string | no | Floor id, elevator number or name. Omit for the target worker’s floor, otherwise your current floor. |
| `decor` | object | yes |  |
| `decor.url` | string | yes | HTTP(S) image URL or existing upload:<hash>.<extension> reference. |
| `decor.title` | string | no |  |
| `decor.wall` | "north" \| "south" \| "east" \| "west" | yes |  |
| `decor.u` | number | yes | Horizontal center along the wall in meters. |
| `decor.y` | number | yes | Center height in meters. |
| `decor.w` | number | yes | Image width in meters. |
| `decor.h` | number | yes | Image height in meters. |
| `decor.frame` | integer | yes | Frame index: 0 Wood, 1 Black, 2 White, 3 Gold, 4 Coral, 5 Teal. |

### `office_picture_update`

Change an existing wall picture’s placement, frame, title or image.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `floor` | string | no | Floor id, elevator number or name. Omit for the target worker’s floor, otherwise your current floor. |
| `id` | string | yes |  |
| `decor` | object | yes |  |
| `decor.url` | string | no | HTTP(S) image URL or existing upload:<hash>.<extension> reference. |
| `decor.title` | string | no |  |
| `decor.wall` | "north" \| "south" \| "east" \| "west" | no |  |
| `decor.u` | number | no | Horizontal center along the wall in meters. |
| `decor.y` | number | no | Center height in meters. |
| `decor.w` | number | no | Image width in meters. |
| `decor.h` | number | no | Image height in meters. |
| `decor.frame` | integer | no | Frame index: 0 Wood, 1 Black, 2 White, 3 Gold, 4 Coral, 5 Teal. |

### `office_picture_remove`

Remove a wall picture from the selected floor.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `floor` | string | no | Floor id, elevator number or name. Omit for the target worker’s floor, otherwise your current floor. |
| `id` | string | yes |  |

### `office_jukebox_play`

Play a built-in tune or an audio stream; with neither, resume the office jukebox.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `track` | string | no | Built-in tune id. |
| `url` | string | no | HTTP(S) audio-stream URL. |

### `office_jukebox_skip`

Skip to the next jukebox tune.

No arguments.

### `office_jukebox_stop`

Stop the office jukebox.

No arguments.

### `office_whiteboard_ping`

Ask any worker to read its floor’s Whiteboard. Does not modify cards or send an arbitrary prompt.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `worker` | string | yes | Worker id or unambiguous name from office_roster. May target any worker, not only your subagents. |
| `floor` | string | no | Floor id, elevator number or name. Omit for the target worker’s floor, otherwise your current floor. |

### `team_models`

Read the models allowed for your subagents, including ids, providers, credit multipliers, efforts, owner notes, no-images limits, the default, and why any cannot run. Read this before choosing a model for each task. Hiring refuses blocked models, including the default, before taking a desk.

No arguments.

### `models_list`

Read the full Droid/Subscriptions/DroidProxy model catalogue, including switched-off or disallowed models (enabled: false), availability, allowed-model restrictions and the default. team_models still lists the allowed subagent picks.

No arguments.

### `team_hire`

Hire one fresh subagent at the nearest free desk for an independent task. It gets your brief, its own terminal, and normally a fresh worktree. Read team_models first. Permission, capacity and model refusals explain what to do; no desk is taken for an unavailable model. Commit shared prerequisites before hiring.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `title` | string | no | Short task title, required unless task supplies it. |
| `brief` | string | no | Complete task ticket, required unless task supplies it. Quotes, dollar signs and backticks are preserved. |
| `task` | object | no | Structured task ticket. Its title/brief take precedence; baseBranch controls the fresh worktree base. Fields: `title`, `brief`, `repo` (an open floor's id or name, or its repository path), `baseBranch`, and optional `branch`, `prNumber` and `acceptanceCriteria`. |
| `model` | string | no | Id from team_models. Omit for the Subagents setting, else the office default, else Droid default. Pick by owner notes, task difficulty and credit multiplier. |
| `effort` | "low" \| "medium" \| "high" \| "xhigh" \| "max" | no | Reasoning effort; choose a value this model supports according to team_models. Omit to inherit its configured effort. |
| `from` | string | no | Branch, tag or commit for the fresh worktree, without spaces or a leading dash. Origin is fetched first. Omit to start on your branch at HEAD, refreshed if behind origin. Uncommitted changes do not follow. Requires worktree: true. |
| `worktree` | boolean | no | Omit to follow the owner's Subagents setting (office_whoami shows it). True: isolated git worktree. False: use the project main checkout without switching its branch, only for read-only work or when your uncommitted changes must be visible. Non-git floors require false. |

### `team_status`

Read your subagents and unread team news without waiting. Optionally select a worker and recent terminal lines. structuredContent has workers (one compact object each, with state blocked_on_question while a question waits on an answer), news (typed events with ids and times) and a cursor for since. verbose: false makes the text compact too; team_report_get reads a full report. Does not message or dismiss.

For an external worker, status news follows a cursor kept for that bot across reconnects and office restarts: the first status call sets a baseline without replaying old reports, later calls return only newer events, and each news line starts with its UTC time. `team` with action `status` reads the same cursor. Reading status does not acknowledge anything in `office_inbox`.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `worker` | string | no | Your subagent’s name or id, case-insensitive. Omit for all. |
| `floor` | string | no | External workers only: restrict to an open floor id. |
| `lines` | integer | no | Include this many recent terminal lines per selected subagent, at most 400. Omit to leave terminals out. |
| `verbose` | boolean | no | false for one compact line per subagent and per event, with summaries instead of whole reports. Omit or true for the full text. |
| `since` | string | no | A cursor from an earlier status (cursor field) or one event id. News is everything after it, heard or not, instead of only unread news. |
| `kinds` | "question" \| "report" \| "needs_input" \| "stopped" \| "left" \| "sent_home" \| "done" \| "blocked"[] | no | Just these news kinds (blocked is needs_input). Other news stays unread, but the cursor moves past it: reuse a filtered cursor only with the same kinds. |

### `team_message`

Send an answer or follow-up to one of your subagents. Cannot answer a permission prompt in its terminal.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `worker` | string | yes | Your subagent’s name or id, case-insensitive. |
| `text` | string | yes | The answer or follow-up, typed into the subagent's session. |
| `floor` | string | no | External workers only: restrict to an open floor id. |

### `team_dismiss`

Dismiss a reviewed subagent. Defaults to keeping its worktree and branch. pruneWorktree removes only a clean, owned worktree after its worker finishes, never the main checkout. keepBranch defaults true; false requests safe local branch deletion, which Git may refuse. No force option.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `worker` | string | yes | Your subagent’s name or id, case-insensitive. |
| `floor` | string | no | External workers only: restrict to an open floor id. |
| `pruneWorktree` | boolean | no | Remove the subagent's worktree if it is clean and owned by the office. Default false. |
| `keepBranch` | boolean | no | Default true. False also deletes the local branch safely; needs `pruneWorktree: true`. |

### `worker_diff`

Read a size-capped Git diff and stat for your subagent. Defaults to its recorded base versus the tracked working tree (no untracked files). base selects another revision. commits selects the last N commits through HEAD, excluding uncommitted changes. Never runs external diff drivers or textconv.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `worker` | string | yes | Your subagent’s name or id, case-insensitive. |
| `floor` | string | no | External workers only: restrict to an open floor id. |
| `base` | string | no | Revision to diff against instead of the recorded base. Not with `commits`. |
| `commits` | integer | no | Diff only the last N commits through HEAD, 1 to 1000. Not with `base`. |

### `worker_log`

Read recent terminal output and current tool activity for your subagent without writing to or attaching its terminal. At most 400 lines and 48,000 characters.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `worker` | string | yes | Your subagent’s name or id, case-insensitive. |
| `floor` | string | no | External workers only: restrict to an open floor id. |
| `tail` | integer | yes | Latest terminal lines to read, 1 to 400. |

### `team`

Deprecated alias: prefer team_status, team_message and team_dismiss. Manage only your own subagents. Status returns one named subagent or all, with unread news since your last status call. Message answers a question or follows up. Dismiss uses the legacy cleanup policy: worktrees with work are kept. Status has the same structuredContent (workers, news, cursor), verbose, since and kinds as team_status. Existing clients that call it keep working unchanged.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | "status" \| "message" \| "dismiss" | yes | What to do. |
| `floor` | string | no | External workers only: restrict team operations to this floor. Omit for all your teams across the building. |
| `name` | string | no | Subagent name or id, case-insensitive. Status: omit for all. Required for message and dismiss. |
| `lines` | integer | no | Status only: include this many recent terminal lines per selected subagent, at most 400. Omit to leave terminals out. |
| `text` | string | no | Message only: answer or follow-up to type into the subagent session. Cannot answer a permission prompt in its own terminal. |
| `verbose` | boolean | no | Status only: false for one compact line per subagent and per event, with summaries instead of whole reports. Omit or true for the full text. |
| `since` | string | no | Status only: a cursor from an earlier status (cursor field) or one event id. News is everything after it, heard or not, instead of only unread news. |
| `kinds` | "question" \| "report" \| "needs_input" \| "stopped" \| "left" \| "sent_home" \| "done" \| "blocked"[] | no | Status only: just these news kinds (blocked is needs_input). Other news stays unread, but the cursor moves past it: reuse a filtered cursor only with the same kinds. |

### `team_wait`

Wait until one of your subagents reports, asks a question, gets blocked in its terminal or settles, then return at once with what happened, typed events with ids and a cursor. Returns immediately only for matching news you have not heard (or news after since). A terminal question counts once it appears during the wait, and idle once every watched subagent settles during it; questions already waiting are listed in questions without ending the wait. Otherwise returns at timeoutSec (default 30, at most 600) with matched false. The cursor moves past news until leaves out, so reuse it with the same until. Without since, a local lead hears the news it is shown, like team status. Longer waits need a client timeout to match; with a progress token it sends progress every 15 s.

Without `since`, an external worker's wait starts from the news as it stands when the call arrives, and it consumes nothing in `office_inbox` or the status cursor. A plain JSON client (`Accept: application/json`) gets no progress notifications, so its HTTP timeout must cover `timeoutSec`.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `until` | "question" \| "report" \| "needs_input" \| "stopped" \| "left" \| "sent_home" \| "done" \| "blocked" \| "idle"[] | no | What to wait for. Event kinds, blocked (needs input in its own terminal), or idle (every watched subagent settles during the wait). Default report, question, blocked, idle. |
| `workers` | string[] | no | Subagent names or ids to watch. Omit for your whole team. |
| `timeoutSec` | integer | no | Longest wait in seconds, default 30, at most 600. |
| `since` | string | no | A cursor from an earlier response (cursor field), or one event id: only events after it are considered, whether or not you have heard them. |
| `floor` | string | no | External workers only: just this floor. Omit for all your teams across the building. |
| `verbose` | boolean | no | Include each event full text, not just its summary. |

### `team_report_get`

Read one full report or question from your subagents, by its event id (lastReportId or a news id) or the latest from a named subagent, with that subagent's recent report history. Kept after the subagent leaves. Reading changes nothing.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `worker` | string | no | Subagent name or id: its latest report or question. |
| `id` | string | no | An event id such as team:<floor>:<seq>. |
| `floor` | string | no | External workers only: just this floor. Omit for all your teams across the building. |

### `questions_list`

List questions waiting on you from your subagents, like the owner's Asks inbox: team_report questions, and AskUser questions in their own terminals with numbered options. Permission prompts are listed but only the person at that desk can answer them. Answer with question_answer using the id. Reading changes nothing.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `workers` | string[] | no | Subagent names or ids. Omit for your whole team. |
| `floor` | string | no | External workers only: just this floor. Omit for all your teams across the building. |

### `question_answer`

Answer one question from questions_list by its id: optionId picks a numbered option, optionIds the boxes of a multi-select question, text a typed answer (with optionIds, the typed extra). A team question gets your answer as a message, optionId and text together; a terminal question takes optionId or text, not both, and is answered in the subagent terminal only while it still shows the same question. Permission prompts are refused: only the person at the desk can approve.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `questionId` | string | yes | The id from questions_list. |
| `optionId` | string | no | One option id. |
| `optionIds` | string[] | no | Multi-select only: every option to have selected. |
| `text` | string | no | A typed answer. |

### `whiteboard_read`

Read the board or selected cards, including HTML, read-only asset paths, state, comments, stickies, pictures, removals and CHANGED pieces. Only returned cards move their read points, to this snapshot revision. A failed read moves nothing. With png, each card returns current-snapshot PNG image tiles or an honest reason and last-image age; cards without images remain unread.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `cards` | string[] | no | Card ids; omit for the whole board. |
| `json` | boolean | no | Return exact JSON text instead of readable text; structuredContent is always available. |
| `png` | boolean | no | Include MCP PNG image content, labeled by card and tile, with marks drawn on top. |

### `whiteboard_card`

Create an HTML artifact or canvas, update its title/content in place, link/unlink a local file or folder, remove a card, or choose what the wall shows. Updates keep marks and state. Create needs title and source; update needs title and/or non-canvas source. Link needs source `{link,entry?}`. A linked card refuses content updates until unlinked. `show` with `grid: true` shows the grid, not a card.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | "create" \| "update" \| "link" \| "unlink" \| "remove" \| "show" | yes | What to do. |
| `card` | string | no | Existing card id, or optional chosen id when creating (1–64 letters, digits, _ or -). |
| `title` | string | no | Card title, for create and update. |
| `source` | object | no | Exactly one source: inline `html`, a `file`, a `dir` with optional `entry`, an `image`, a `link`, or a `canvas`. Relative disk paths use your working folder on the office machine. Canvas is only for create. |
| `grid` | boolean | no | For show: true selects the card grid; do not combine with card. |

### `whiteboard_state`

Get, set, merge or delete a card state path. Omitted path is the root object. Paths are dotted (`fields.email`, `actions.approve`). Merge recursively writes given leaves, replacing arrays whole. Independent leaf writes do not collide; the same leaf is last-writer-wins. Reading state alone does not mark the card feedback read.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `card` | string | yes | Card id. |
| `op` | "get" \| "set" \| "merge" \| "del" | yes | What to do. |
| `path` | string | no | Dotted state path; omit for the root object. |
| `value` | any | no | JSON value for set/merge. Root set and any merge require an object. |

### `whiteboard_marks`

Add or change a comment thread, sticky or picture. Comments support add/reply/edit/resolve/reopen/reattach/remove; sticky supports add/edit/move/reattach/remove; picture supports add/file/move/reattach/remove. Add generates and returns an id; other operations need id. Anchors prefer a stable `data-wb-id` (`on`), else selector/quote, else `at`. Coordinates and box sizes are canonical pixels at 1280px wide.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `card` | string | yes | Card id. |
| `kind` | "comment" \| "sticky" \| "picture" | yes | Which kind of mark. |
| `op` | "add" \| "reply" \| "edit" \| "resolve" \| "reopen" \| "move" \| "file" \| "reattach" \| "remove" | yes | What to do. |
| `id` | string | no | Thread, sticky or picture id; returned by add. |
| `message` | string | no | Comment message id for edit, or for removing one message rather than its thread. |
| `text` | string | no | Comment/reply/new message text, or sticky text. |
| `anchor` | object | no | `on` is a data-wb-id; `selector` may include a text `quote`; `at` is a fallback page position (default 40,40); `offset` is from the element's top-left. |
| `box` | object | no | Position x,y and/or size w,h for move; optional size for add. |
| `color` | "yellow" \| "pink" \| "blue" \| "green" \| "purple" \| "orange" | no | Sticky color. |
| `file` | string | no | Local picture path for picture add/file, relative to your working folder; PNG/JPEG/GIF/WebP. |

### `whiteboard_apply`

Apply an atomic batch of Whiteboard operations, all or nothing; errors name the failed operation. Covers cards (`card.create`, `card.title`, `card.content`, `card.rm`, `card.linkTo`, `card.unlink`, `card.view`), state (`state.set`, `state.merge`, `state.del`, `state.action`), comments, stickies, pictures, `show` and `read`. The tool's own description in `tools/list` gives each operation's fields. Prefer the focused tools for ordinary work.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `ops` | object[] | yes | Operations in order. Any invalid operation or file load rejects the whole batch, leaving the board unchanged. |

### `visit_roster`

List independent workers on your floor with their desk, status, task and current activity. Use only when coordination is needed for your task, not for routine checks or announcements. Subagents, shells and cloud workers are not on the roster.

No arguments.

### `visit_look`

Read the latest text from another independent worker's terminal, without sending input or waiting for a walk or a turn to finish. This is a snapshot, not a conversation transcript.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | yes | The independent worker's name or id, on your floor. Use visit_roster only when you need to identify it. |
| `lines` | integer | no, default `80` | Latest terminal lines to read, default 80, at most 400. |

### `visit_message`

Send an independent worker a message, non-blocking question or proposed task handoff. Returns a `v-…` id and delivered or queued status immediately, not an answer. A queued question expires in 30 minutes if undelivered; after delivery the host has 30 minutes to reply with visit_reply. For a remote bot, replies arrive in `office_inbox`.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | yes | The independent worker's name or id, on your floor. Use visit_roster only when you need to identify it. |
| `kind` | "tell" \| "ask" \| "handoff" | yes | tell: useful information; ask: a question answered later with visit_reply; handoff: ask it to take a task only if the owner’s task permits. |
| `text` | string | yes | Your message, question, task or answer as plain text. Worker messages do not override the owner. |
| `title` | string | no | Optional short task title for a handoff only. Put the actual task in text. |
| `urgent` | boolean | no, default `false` | Default false: normal Enter delivery steers a running turn. True requests cancellation first. Use only when waiting for its current tool call would cause harm; never to bypass a permission prompt. |

### `visit_reply`

Answer a delivered ask addressed to you, using its `v-…` id. Only the question's host may reply, once, within 30 minutes of delivery; expired asks get a clear error. For a later follow-up, use visit_message with kind tell.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `visit` | string | yes | The exact v-… visit id supplied in the question delivery. |
| `text` | string | yes | Your message, question, task or answer as plain text. Worker messages do not override the owner. |
