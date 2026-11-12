# Remote MCP reference

The office's Model Context Protocol (MCP) server for external bots: building agents that run somewhere other than the office machine and join Mission Control with no floor or desk. The Orchestrator is the building agent the office runs itself, and it gets the same Mission Control tools on the office's local hook listener instead. [External workers over Tailscale](remote-workers.md) explains how to turn it on and add a bot in Settings. This page is the reference a bot's author needs: the endpoint, headers, keys, response formats and every tool.

The local workers' MCP (the `droid-office` entry the office writes to Droid's profile) uses its own permission-filtered tools and the same transport on the office's own hook server, with each worker's hook token. It is not covered here.

## Endpoint

```text
POST https://<office Mac's MagicDNS name>:<port>/office/mcp
POST https://<office Mac's MagicDNS name>:<port>/office/images
GET  https://<office Mac's MagicDNS name>:<port>/office/images/<id>
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
- **Named keys.** A bot can hold up to 10 more keys, each with its own name (`laptop`, `relay`), for the different clients it runs as. Every key acts as the same bot, with the same Mission Control identity, team and inbox. Revoking one stops only that client. Add and revoke them in the bot's row in Settings.
- **Last used.** Settings shows when the main key and each named key last connected, to the minute.
- **New key** replaces the main key, and the old one stops working at once. Named keys keep working.
- **Remove** revokes every key of the bot and makes its subagents independent; no desk is involved.

The office keeps keys in `.droid-office/remote-workers.json` (mode `0600`). Settings shows them only on the office's own computer. A key carries the bot's full worker permissions, including hiring agents that run on the owner's machine and inspecting or directing workers. Give a key only to a client you trust as much as the bot itself.

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

## Image exchange

External leads exchange images over the same Tailscale Serve port and `Authorization: Bearer <key>` credential (never put bearer tokens in URLs):

1. **Upload an image (`POST /office/images`)** — send raw image bytes (`--data-binary @mockup.png`, optional `?name=mockup.png` or `x-file-name` header), `multipart/form-data` (`-F file=@mockup.png`), or JSON (`{"data":"<base64>","name":"mockup.png"}`). Magic bytes are validated (`PNG`, `JPEG`, `GIF`, `WebP`, up to 25 MB), returning `{ id, url, name, mimeType, bytes, width, height }`.
2. **Send to workers** — pass `images: [id]` in `team_message`, `team_hire`, `office_worker_prompt`, or `office_worker_spawn`. Each recipient receives a local copy in its drops folder.
3. **Fetch worker & Whiteboard images (`GET /office/images/<id>`)** — images workers attach in `team_report` / `lead_notify`, put on a floor's Whiteboard (`whiteboard_read`, including `png: true` rendered card tiles), or view in `office_worker_thread` return `{ id, url, name, mimeType, bytes, width, height }` in tool results, `office_inbox`, and Grok Bot webhook payloads. Fetch `url` with `Authorization: Bearer $KEY`:

```bash
IMAGES_URL='https://office-mac.tailXXXX.ts.net:8443/office/images'

# Upload an image and capture its 16-hex id
UPLOAD=$(curl -sS -X POST "$IMAGES_URL?name=mockup.png" \
  -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: image/png' \
  --data-binary @mockup.png)

# Download an image returned in a report, webhook, or whiteboard_read
curl -sS -H "Authorization: Bearer $KEY" "$IMAGES_URL/<16-hex-id>" -o out.png
```

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
- Forward only `POST /office/mcp`, `POST /office/images` and `GET /office/images/<id>`. Do not forward `Origin`, and never forward `Tailscale-*` headers from the public side: Tailscale Serve sets these, and the office trusts them only on its own loopback listener.
- Keep TLS end to end, log requests on the relay, and rate limit it.
- A key on a public path can still do everything the bot can, including hiring agents that run commands on the owner's machine. Turn the relay off when the bot doesn't need it.

## Tools

Remote-bot `tools/list` returns the tools below; Linear tools appear only while the office is connected to Linear. The list is otherwise stable when local hiring or visit permissions change. Hiring and the worker-control tools do not depend on the local Subagents toggle or team-size limit; the Subagents model allowlist (**Settings → Subagents & visits → Models leads can pick**), office capacity, model availability and the owner's normal action checks apply identically to floor leads, the Orchestrator and external bots (existing workers keep their saved models when resumed or prompted). Turning off **Office MCP** or revoking a bot's key cuts off access.

**Choosing a tool:**
- Manage your own subagents with `team_*`, `worker_log`, `worker_diff`, `questions_list` and `question_answer`.
- Inspect the building with `office_roster`, `office_look` and `office_worker_thread`.
- Hire an independent worker with `office_worker_spawn`, direct one with `office_worker_prompt`, or control its current turn with `office_worker_interrupt` and `office_worker_answer`.

Worker-control tools have strict input schemas, including nested objects. Unknown fields are refused. Floor references accept an id, elevator number or name. Worker references accept an id or unambiguous name; an explicitly supplied floor must contain that worker. Worker operations follow the target worker's floor; spawning requires `floor`. Internal protocol fields and request ids are supplied by the server. Building agents in Mission Control are not controllable through these tools: `office_look` and `office_worker_thread` may read the Orchestrator, but nothing may prompt, interrupt, answer or send home a building agent.

Owner action results contain `status: done | pending | unconfirmed`, notes, and any bounded reply; refusals return `isError`. `pending` means no confirmed outcome within 30 seconds. `unconfirmed` means the handler neither confirmed nor refused it. Neither is a safe reason to retry a mutation. `office_send_home` keeps worktrees, branches and cloud sessions unless deletion is explicitly requested.

A bot's key still conveys owner-level worker control, including hiring agents that execute commands and answering terminal menus. Floor workers do not see these owner tools. All paths and `cwd` values refer to the **office machine**, not the bot's host.

Remote bots can read floor Whiteboards with `whiteboard_read` (including downloadable image URLs and ids), while Whiteboard mutation, visits, raw terminal input, floor-management, forge, pipeline, settings, connection, picture and jukebox tools stay internal. Internal workers retain `team`, `models_list`, `team_report`, `visit_roster`, `visit_look`, `whiteboard_guide`, `whiteboard_read`, `whiteboard_card`, `whiteboard_state`, `whiteboard_marks` and `whiteboard_apply`, subject to their existing permissions.

`tests/remote-mcp.test.ts` asserts exact set equality for an external-bot session and checks this reference against the live tool arguments.

### `office_whoami`

Read your office identity: desk (or Mission Control), lead if you are a subagent, permission to hire and visit, owner access, team size, worktree default and wake-note setting. Call it to learn your role before coordinating work.

No arguments.

For a building agent, the subagent count covers every open floor.

### `office_floors`

List open floors, with your teams and unread team updates on each floor.

No arguments.

### `office_inbox`

Read messages and team updates from all floors without consuming them. Acknowledge exact ids only after processing them, in a later call. In overlapping Grok Bot webhook runs, pass `ids` (for example `payload.ackIds`) or `deliveryId` (`payload.deliveryId`) to scope the view to that webhook delivery (already-acknowledged items still appear with `acked: true`) and prevent acknowledging another run's items. Returns at most `limit` messages and a `remaining` count of unacknowledged items.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `ack` | string[] | no, default `[]` | Exact message/ack ids (or a `whk-…` webhook `deliveryId`) to acknowledge, at most 500. Scoped to `ids`/`deliveryId` when supplied; out-of-scope ids are ignored and returned in `ignoredAck`. |
| `ids` | string[] | no | Filter returned messages to these exact event/message ids (e.g. a webhook payload’s ackIds); includes already-acked items with acked: true. |
| `deliveryId` | string | no | Webhook payload deliveryId (whk-…) to scope returned messages and acks to that webhook delivery. |
| `limit` | integer | no, default `50` | Messages to return, 1 to 100. |

### `office_status`

Set your self-reported office status and optional short activity. This does not launch, stop, or cancel your external process.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `status` | "idle" \| "working" \| "done" | yes | Shown in Mission Control. |
| `activity` | string | no | A short line of what you're doing, at most 140 characters. |

### `office_roster`

List every worker in the building, or on one floor: id, name, floor id and number (1-based, the elevator's order), desk, status, task, task-label provenance (`taskLabel`: whether the task text is a `generated` label vs `lead`/`prompt` assigned, its `updatedAt` ISO timestamp when generated, and `stale: true` when Worker labels are turned off), working directory, active branch/PR, checkout safety warnings (such as two live writers sharing one tree without isolated worktrees or sitting directly on `main`), model, lead, and whether it is you, your subagent or a watched worker. Includes owner-hired workers, subagents, shells and cloud workers. Mission Control's building agents have their own section, with no floor or desk: tools read them and never control them.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `floor` | string | no | Floor id, number (1 is the top of the elevator list) or name. |

### `office_look`

Read structured worker state (plan steps and progress, current or last tool call, hook age, queued messages, model retry or subscription cooldown with reset time, and PR/CI/Release runs) plus the end of any worker's terminal, on any floor, without typing anything. Pass `lines: 0` for structured worker state without raw terminal output. `"office-shell"` reads the floor's boss shell (`lines >= 1`). In Mission Control, it reads the Orchestrator; an external bot has no terminal on this machine. At most 48,000 characters, with a truncation marker if older text was omitted. A snapshot, not a transcript; for conversation history or a cloud worker's thread use `office_worker_thread`.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `worker` | string | one target | Worker id or name from office_roster (or `"office-shell"`). |
| `name` | string | alias | Alias for `worker`. |
| `workerId` | string | alias | Alias for `worker`. |
| `floor` | string | no | Floor id, number (1 is the top of the elevator list) or name. |
| `lines` | integer | no, default `80` | Latest terminal lines, default 80, at most 400 (`0` returns structured worker state only). |

### `office_send_home`

Send any floor worker home, exactly as the owner's SEND HOME does: an owner-hired worker or any lead's subagent, yours included. Building agents in Mission Control, you included, stay. cleanup keep (the default) leaves its worktree and branch; worktree deletes the worktree and keeps the branch; all deletes both, including commits no remote has. deleteSession true also deletes a cloud worker's Factory session, only when the owner asked. The reply preserves the target and pre-dismissal worktree report even when the outcome is uncertain. Its subagents stay, without a lead.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `worker` | string | one target | Worker id or name from office_roster. |
| `name` | string | alias | Alias for `worker`. |
| `workerId` | string | alias | Alias for `worker`. |
| `floor` | string | no | Floor id, number (1 is the top of the elevator list) or name. |
| `cleanup` | "keep" \| "worktree" \| "all" | no, default `"keep"` | What becomes of its worktree. Default keep. Use worktree or all only when the owner asked to delete it. |
| `deleteSession` | boolean | no, default `false` | Also delete a cloud worker’s Factory session, only when the owner asked. Otherwise it is kept. |

### `office_worker_spawn`

Hire an independent worker, shell or cloud worker on a floor. For a subagent that reports to you, use team_hire instead. Cloud hires can incur charges. A building agent has no floor of its own, so it always names one.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `floor` | string | yes | Floor id, elevator number or name from office_floors. |
| `deskId` | string | no, default `"auto"` | Seat id, or auto for the first free seat. |
| `prompt` | string | no |  |
| `worktree` | boolean | no | Use an isolated Git worktree for a local agent. |
| `kind` | "agent" \| "shell" \| "cloud" | no, default `"agent"` |  |
| `model` | string | no | Exact model id from team_models; must be available. |
| `effort` | "low" \| "medium" \| "high" \| "xhigh" \| "max" | no | Reasoning effort supported by the selected model. |
| `issue` | integer | no | Issue to assign to this worker on the floor’s forge. |
| `repos` | string[] | no | Additional open repository floor ids for a multi-repository worker. |
| `images` | string[] | no | Existing office-upload image ids, not paths or image bytes. |
| `cloud` | object | no | Required for kind cloud; choose a Factory computer or environment. |
| `cloud.computerId` | string | no | Existing Factory computer id. Choose this or environmentId, not both. |
| `cloud.environmentId` | string | no | Factory environment id; starts a computer for this worker, which may incur charges. |
| `cloud.cwd` | string | no | Working folder on that remote computer; omit for its home. |

### `office_worker_prompt`

Prompt or steer any floor worker as the owner, as a message in its session. Your own subagents take team_message. When `queue` is `false` (default), Droid steers during a running turn; `queue: true` queues behind the turn via Ctrl+Enter; `urgent: true` interrupts a running turn or blocking command via Escape and delivers immediately.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `worker` | string | one target | Worker id or unambiguous name from office_roster. May target any worker, not only your subagents. |
| `workerId` | string | alias | Alias for `worker`. |
| `name` | string | alias | Alias for `worker`. |
| `floor` | string | no | Floor id, elevator number or name. Required when the name exists on more than one floor; a building agent has no current floor. |
| `prompt` | string | one body | Prompt message (or pass `text`). |
| `text` | string | alias | Alias for `prompt`. |
| `issue` | integer | no |  |
| `images` | string[] | no | Existing office-upload image ids, not paths or image bytes. |
| `queue` | boolean | no, default `false` | Queue behind the current turn using Ctrl+Enter instead of steering during the turn. |
| `urgent` | boolean | no | Interrupt a running turn or blocking command via Escape and deliver immediately (not with `queue: true`). |

### `office_worker_answer`

Answer a worker’s currently displayed menu as the owner. Supply its exact menu snapshot; changed menus are refused. Unlike question_answer, this is owner-level terminal control.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `worker` | string | one target | Worker id or unambiguous name from office_roster. May target any worker, not only your subagents. |
| `workerId` | string | alias | Alias for `worker`. |
| `name` | string | alias | Alias for `worker`. |
| `floor` | string | no | Floor id, elevator number or name. Required when the name exists on more than one floor; a building agent has no current floor. |
| `menu` | object | yes | Exact menu snapshot from the worker’s screen. The server refuses an answer if the menu changed. |
| `menu.question` | string | no | Exact question currently shown. |
| `menu.choices` | object[] | yes | The currently displayed options, in order, with their original numbers and labels. |
| `menu.pointer` | integer | no | Currently focused zero-based option. |
| `menu.freeText` | boolean | yes | Whether the displayed menu accepts a typed answer. |
| `menu.multiSelect` | boolean | no | Whether the displayed menu has checkboxes. |
| `choice` | integer | no | One displayed option number; not with choices or text. |
| `choices` | integer[] | no | Complete set of checkbox option numbers; may accompany text. |
| `text` | string | no | Typed answer, optionally accompanying checkbox choices. |

### `office_worker_interrupt`

Interrupt any worker’s current turn without dismissing it. Sends Escape locally or interrupts its Factory session.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `worker` | string | one target | Worker id or unambiguous name from office_roster. May target any worker, not only your subagents. |
| `workerId` | string | alias | Alias for `worker`. |
| `name` | string | alias | Alias for `worker`. |
| `floor` | string | no | Floor id, elevator number or name. Required when the name exists on more than one floor; a building agent has no current floor. |

### `office_worker_thread`

Read one page of any local or cloud agent’s conversation, including the Orchestrator in Mission Control. Does not attach or type into its terminal. Returns a bounded snapshot and pagination information.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `worker` | string | one target | Worker id or unambiguous name from office_roster. May target any worker, not only your subagents. |
| `workerId` | string | alias | Alias for `worker`. |
| `name` | string | alias | Alias for `worker`. |
| `floor` | string | no | Floor id, elevator number or name. Required when the name exists on more than one floor; a building agent has no current floor. |
| `before` | integer | no | Exclusive entry sequence for older history; omit for the newest page. |

**Linear tools.**

When the office is connected to [Linear](../linear.md), building agents can use `linear_issues`, `linear_issue`, `linear_create_issue`, `linear_update_issue`, `linear_comment`, `linear_workspace` and `linear_graphql`. They have no current floor or linked ticket, so name a team or issue when the operation needs one. `linear_start` is available only to floor workers. The [Office MCP tool table](../office-mcp.md#tools) lists their inputs. `linear_graphql` permits arbitrary queries and mutations with the connected account's access.

### `team_models`

Read the models allowed for your subagents, led by a compact per-provider `Subscription quotas:` summary (5-hour and weekly remaining percentages, reset countdowns and ISO timestamps, runnable model counts, and active cooldowns), followed by model ids, providers, credit multipliers, efforts, owner notes, no-images limits, the default, and why any cannot run. Triggers a throttled DroidProxy `/models` recheck so newly exhausted windows surface promptly. Read it before choosing each task's model. Hiring refuses a blocked model, the default included, before taking a desk.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `only` | "all" \| "subscriptions" \| "available" \| "quotas" | no | Filter output to compact provider `quotas`, `subscriptions` models only, `available` runnable models only, or `all` (default). |

### `team_hire`

Hire one fresh subagent at the nearest free desk for an independent task. It gets your brief, its own terminal, and normally a fresh worktree on Git floors. Pass top-level `title` + `brief` for a simple hire, or `task` when adding branch, PR, or acceptance-criteria metadata. Read team_models first. Permission, capacity and model refusals explain what to do; no desk is taken for an unavailable model. Commit shared prerequisites before hiring. A building agent names the open floor it hires on, either with `floor` or in `task.repo`.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `title` | string | no | Short task title, required unless task supplies it. |
| `brief` | string | no | Complete task ticket, required unless task supplies it. Quotes, dollar signs and backticks are preserved. |
| `floor` | string | no | Building agents only: the open floor to hire on, by id, name or checkout path (or set `task.repo`). |
| `task` | object | no | Structured task ticket. Its title/brief take precedence; Fields: `title`, `brief`, optional `repo` (an open floor's id, name or path; omit to use your floor or top-level `floor`), optional `baseBranch`, `branch`, `prNumber` and `acceptanceCriteria`. Defaults to a fresh worktree on Git floors and shared folder on non-Git floors unless `worktree` overrides it. |
| `model` | string | no | Id from team_models. Omit for the Subagents setting, else the office default, else Droid default. Pick by owner notes, task difficulty and credit multiplier. |
| `effort` | "low" \| "medium" \| "high" \| "xhigh" \| "max" | no | Reasoning effort; choose a value this model supports according to team_models. Omit to inherit its configured effort. |
| `from` | string | no | Branch/tag/commit, worker:<name or id>, or a registered worktree's absolute path for the fresh worktree, without spaces or a leading dash. Origin is fetched first. Omit to start on your branch at HEAD, refreshed if behind origin. Only committed work follows. Requires worktree: true. |
| `images` | string[] | no | Uploaded image ids from POST /office/images to attach to the initial brief. |
| `worktree` | boolean | no | Omit to default to a fresh worktree for structured tasks on Git floors (false on non-Git floors) or follow the owner's Subagents setting. True: isolated git worktree. False: shared checkout without switching its branch (omit baseBranch/branch/from). |

### `team_watch`

Follow or unfollow independent floor workers without re-hiring or interrupting them. Watched workers remain independent (their system prompt, Stop hook and owner attention stay unchanged), appear in `team_status`, `team_wait` and `questions_list` with `watched: true`, and wake you on turn completion, terminal `AskUser` questions, stops, departures and pull-request updates (`pr`). `team_dismiss` refuses watched independent workers so owner sessions are never accidentally sent home.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `worker` | string | no | Independent worker name or id to watch or unwatch. |
| `workers` | string[] | no | Subset of worker names or ids (1–100). |
| `all` | true | no | Watch (or unwatch) every independent worker on the floor. |
| `watch` | boolean | no, default `true` | Default true to watch; false to stop watching. |
| `floor` | string | no | Building agents only (floor workers omit): floor id, name, or path. |

### `team_status`

Read your subagents, watched floor workers, other active workers on the floor (`floorWorkers`), and unread team news at once, without waiting; optionally one worker, with recent terminal lines. `structuredContent` has `workers` (one compact object each with `state`, `task`, `taskLabel` provenance/timestamp/staleness, `plan`, `currentTool`/`lastTool`, `lastActivityAt`/`silentForMs`, `queued`, `retryingModel`/`modelStatus` cooldowns, `prStatus`/`ci`/`releaseRun` from cached floor state, working directory, branch, and checkout warnings), optional `floorWorkers` (independent workers on the floor not yet in your team), `news` (typed events with ids and times) and a `cursor` to pass as `since`. `verbose: false` makes the text compact too. `team_report_get` reads a full report.

For an external worker, status news follows a cursor kept for that bot across reconnects and office restarts: the first status call sets a baseline without replaying old reports, later calls return only newer events that have not already been acknowledged in `office_inbox`, and each news line starts with its UTC time. `team` with action `status` reads the same cursor. Reading status does not acknowledge anything in `office_inbox`.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `worker` | string | no | Your subagent’s name or id, case-insensitive. Omit for all. |
| `floor` | string | no | Building agents only: just this open floor, by id, name or checkout path. Omit for all your teams across the building. |
| `lines` | integer | no | Include this many recent terminal lines per selected subagent, at most 400. Omit to leave terminals out. |
| `verbose` | boolean | no | false for one compact line per subagent and per event, with summaries instead of whole reports. Omit or true for the full text. |
| `since` | string | no | A cursor from an earlier status (cursor field) or one event id. News is everything after it, heard or not, instead of only unread news. |
| `kinds` | "question" \| "report" \| "pr" \| "needs_input" \| "stopped" \| "left" \| "sent_home" \| "done" \| "blocked"[] | no | Just these news kinds (blocked is needs_input). Other news stays unread, but the cursor moves past it: reuse a filtered cursor only with the same kinds. |

### `team_message`

Steer one subagent, a subset or all your teams. By default (`queue: false`), guidance steers during a running turn (at the next tool step through hooks, or via plain Enter in Droid's TUI). Set `queue: true` to queue behind the current turn via Ctrl+Enter, or `urgent: true` to cancel a running turn or blocking command via Escape and deliver immediately. Select exactly one of `worker`, `workers` or `all: true`. Responses give canonical worker ids, readable names, floors, blocking-command warnings, and per-recipient delivery (`next_step`, `queued_turn`, `interrupted`, `sent`, `resumed`) or errors. Names and ids resolving to the same worker deliver once. Empty teams and entirely failed broadcasts return tool errors; partial delivery keeps all recipient outcomes. A permission prompt still needs the person at its desk.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `worker` | string | one selector | Your subagent’s name or id, case-insensitive. |
| `workers` | string[] | one selector | Subset of subagent names or ids (1–100). |
| `all` | true | one selector | Broadcast to all your subagents on the selected floor, or across all floors. |
| `text` | string | yes | Guidance or follow-up for the selected subagents. |
| `images` | string[] | no | Uploaded image ids from POST /office/images to attach for the subagent. |
| `queue` | boolean | no, default `false` | Default `false` steers during the running turn; `true` queues behind the current turn using Ctrl+Enter. |
| `urgent` | boolean | no | Interrupt a running turn or blocking command via Escape and deliver immediately (not with `queue: true`). |
| `floor` | string | no | Building agents only: just this open floor, by id, name or checkout path. Omit for all your teams across the building. |

### `team_review`

Record a review verdict (approve, request_changes or comment) and concrete notes on your subagent's latest reported result, surfaced in team_status and team_report_get. Also works after the subagent has already been dismissed. By default, request_changes sends the notes to an active subagent to fix and re-report (or notes that a dismissed subagent was already sent home); approve and comment record the verdict without waking it.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `worker` | string | yes | Your subagent’s name or id, case-insensitive (including dismissed subagents). |
| `verdict` | "approve" \| "request_changes" \| "comment" | yes | approve when verified and ready to merge, request_changes when fixes are required before merging, or comment for non-blocking notes. |
| `notes` | string | yes | Concrete review findings, verified checks, or approval rationale. |
| `notify` | boolean | no | Send the review notes to the subagent as a follow-up message. Defaults to true for request_changes and false for approve or comment. |
| `floor` | string | no | Building agents only: just this open floor, by id, name or checkout path. Omit for all your teams across the building. |

### `team_dismiss`

Dismiss a reviewed subagent, keeping its worktree and branch by default. pruneWorktree: true removes its worktree once the worker finishes, and only a clean worktree the office made; the main checkout always stays. keepBranch: false, with pruneWorktree, asks Git for a safe local branch deletion, which Git may refuse. Git is never forced.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `worker` | string | yes | Your subagent’s name or id, case-insensitive. |
| `floor` | string | no | Building agents only: just this open floor, by id, name or checkout path. Omit for all your teams across the building. |
| `pruneWorktree` | boolean | no | Remove the subagent's worktree if it is clean and owned by the office. Default false. |
| `keepBranch` | boolean | no | Default true. False also deletes the local branch safely; needs `pruneWorktree: true`. |

### `team_merge`

Integrate a reviewed worker's committed branch into an existing local target, without switching another checkout. Default `merge` merges the whole branch. `cherry-pick` applies non-merge commits after its recorded base, oldest first, excluding commits on target; `commits` selects explicit ordered revisions instead. Returns a one-line summary, `status: ok` and artifact commits/files. Conflicts return `isError`, `status: blocked`, structured `conflicts` with paths and ours/theirs hunks, and `remaining` with the retained worktree and Git continue/abort commands. Run combined checks after landing.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `worker` | string | yes | Your subagent's name or id. |
| `floor` | string | no | Open floor id, name or checkout path, when needed to resolve the worker. |
| `target` | string | yes for building agents | Existing local target branch. |
| `mode` | "merge" \| "cherry-pick" | no | Default merge. |
| `commits` | string[] | no | With cherry-pick, explicit revisions in application order, at most 1000. |

### `team_pr`

Open an authorized PR/MR from an already-pushed worker branch through its floor's forge. Does not push or merge. Returns `status: ok`, summary and `artifacts.prUrl`/`prNumber`.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `worker` | string | yes | Your subagent's name or id. |
| `floor` | string | no | Open floor id, name or checkout path, when needed to resolve the worker. |
| `title` | string | yes | Pull request title. |
| `body` | string | no | Description and checks. |
| `base` | string | no | Target branch on the forge; omit for the worker's recorded starting branch, then the floor branch. No leading dash. |

### `worker_diff`

Read a size-capped Git diff and stat for your subagent (including dismissed subagents whose worktree or branch still exists). Defaults to its recorded base versus the tracked working tree (no untracked files), or `base..branch` when the worktree was pruned and the branch kept. `base` selects another revision. `commits` selects the last N commits through HEAD, excluding uncommitted changes. Uses Git's built-in diff only, with no external diff drivers or textconv.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `worker` | string | yes | Your subagent’s name or id, case-insensitive (including dismissed subagents). |
| `floor` | string | no | Building agents only: just this open floor, by id, name or checkout path. Omit for all your teams across the building. |
| `base` | string | no | Revision to diff against instead of the recorded base. Not with `commits`. |
| `commits` | integer | no | Diff only the last N commits through HEAD, 1 to 1000. Not with `base`. |

### `worker_log`

Read your subagent's structured runtime state (plan steps, current/last tool, hook age, queued messages, model retry or cooldown with reset time, PR/CI/Release runs) and recent terminal output, read-only. Pass `tail: 0` for structured state only; otherwise at most 400 lines and 48,000 characters.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `worker` | string | yes | Your subagent’s name or id, case-insensitive. |
| `floor` | string | no | Building agents only: just this open floor, by id, name or checkout path. Omit for all your teams across the building. |
| `tail` | integer | no, default `80` | Latest terminal lines to read, 0 to 400 (`0` returns structured worker state only). |

### `worker_queue`

Inspect, clear or promote pending messages on a worker (both office hook outbox notices and Droid's TUI queue), and see any active blocking command. Building agents with owner access may target any local floor worker; floor leads target their own subagents.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `worker` | string | yes | Worker name or id, case-insensitive. |
| `floor` | string | no | Building agents only: open floor id, name, elevator number or checkout path. |
| `action` | "list" \| "clear" \| "promote" | no, default `"list"` | `list` inspects pending items; `clear` cancels one item or all; `promote` pulls queued item(s) forward to steer now. |
| `index` | integer | no | 1-based queued message index from `list` (omit to clear all or promote the top queued item). |
| `all` | boolean | no | Apply `clear` or `promote` to all pending items (not with `index`). |
| `urgent` | boolean | no | For `promote` only: interrupt a running turn or blocking command via Escape and deliver immediately. |

### `team_wait`

Wait until one of your subagents reports, asks, gets blocked in its terminal or settles, then return with what happened: typed events with ids, waiting questions and a cursor. Matching news you have not heard (or news after since) returns at once. A terminal question counts when it appears during the wait, and idle when every watched subagent settles during it; questions already waiting are listed without ending the wait. Each call holds at most 90 s on the server so MCP clients do not abort with `-32001` request timeouts around 200–240 s; when nothing matches in that slice it returns `matched: false` (with `capped: true` when `timeoutSec > 90`) and a `cursor` to pass as `since` on the next wait. The cursor moves past news that until leaves out, so reuse it with the same until. Without since, a local lead hears the news it is shown, as with team_status. With a progress token it also reports progress every 15 s.

Without `since`, an external worker's wait starts from the news as it stands when the call arrives, and it consumes nothing in `office_inbox` or the status cursor.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `until` | "question" \| "report" \| "pr" \| "needs_input" \| "stopped" \| "left" \| "sent_home" \| "done" \| "blocked" \| "idle"[] | no | What to wait for. Event kinds, blocked (needs input in its own terminal), or idle (every watched subagent settles during the wait). Default report, question, pr, blocked, idle. |
| `workers` | string[] | no | Subagent names or ids to watch. Omit for your whole team. |
| `timeoutSec` | integer | no | Longest wait in seconds, default 30, at most 600 (each call holds at most 90 s and returns `matched: false` + `cursor` to continue). |
| `since` | string | no | A cursor from an earlier response (cursor field), or one event id: only events after it are considered, whether or not you have heard them. |
| `floor` | string | no | Building agents only: just this open floor, by id, name or checkout path. Omit for all your teams across the building. |
| `verbose` | boolean | no | Include each event full text, not just its summary. |

### `team_report_get`

Read one full report or question from your subagents, by its event id (lastReportId or a news id) or the latest from a named subagent, with that subagent's recent report history. Kept after the subagent leaves. Reading changes nothing.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `worker` | string | no | Subagent name or id: its latest report or question. A name hired again after a dismissal means the one on your team now. |
| `id` | string | no | An event id such as team:<floor>:<seq>. |
| `floor` | string | no | Building agents only: just this open floor, by id, name or checkout path. Omit for all your teams across the building. |

### `questions_list`

List questions waiting on you from your subagents, like the owner's Asks inbox: team_report questions, and AskUser questions in their own terminals with numbered options. Permission prompts are listed but only the person at that desk can answer them. Answer with question_answer using the id. Reading changes nothing.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `workers` | string[] | no | Subagent names or ids. Omit for your whole team. |
| `floor` | string | no | Building agents only: just this open floor, by id, name or checkout path. Omit for all your teams across the building. |

### `question_answer`

Answer one question from questions_list by its id: optionId picks a numbered option, optionIds the boxes of a multi-select question, text a typed answer (with optionIds, the typed extra). A team question gets your answer as a message, optionId and text together; a terminal question takes optionId or text, not both, and is answered in the subagent terminal only while it still shows the same question. Permission prompts are refused: only the person at the desk can approve.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `questionId` | string | yes | The id from questions_list. |
| `optionId` | string | no | One option id. |
| `optionIds` | string[] | no | Multi-select only: every option to have selected. |
| `text` | string | no | A typed answer. |

### `whiteboard_read`

Read a floor's Whiteboard cards (Markdown/HTML, state, marks, CHANGED pieces, and downloadable image ids/URLs). Building agents pass `floor` when more than one floor is open; floor workers omit `floor`. Each returned card's raster content images, picture marks, and `png: true` rendered PNG tiles include `{ id, url, name, mimeType, bytes, width, height }` downloadable via `GET /office/images/<id>` with your bearer key.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `floor` | string | no | Building agents only (floor workers omit): floor id, name, or path. |
| `cards` | string[] | no | Card ids; omit for whole board. |
| `onlyChanged` | boolean | no | Return only cards and removals with unread changes since your last read. |
| `peek` | boolean | no | Inspect without advancing your read points. |
| `json` | boolean | no | Format text output as JSON. |
| `png` | boolean | no | Include rendered PNG tiles with marks. |

## Grok Bot webhook push

When a bot is marked as a **Grok Bot** in Settings → **Phone & web** → **Tailscale MCP**, the office attaches a per-bot HTTPS JSON webhook URL and `Authorization: Bearer` token to that bot in mode-`0600` `.droid-office/remote-workers.json` (the token is never returned over `/api/remote-mcp` or WebSocket state). Named keys on that bot share its identity and webhook; other bots stay polling-only.

The office sends an HTTP `POST` (`Content-Type: application/json`, `Authorization: Bearer <token>`, redirects refused, 15 s timeout) whenever:

- A subagent finishes or asks via `team_report` (flushed immediately; `progress: true` reports do not wake the lead while a background job is still running).
- A subagent calls `lead_notify` (available only to subagents of a Grok Bot) for a mid-turn `update`, `question`, `blocker` or `test` ping without ending its turn.
- Floor hooks or board updates report that a subagent or `team_watch`-followed floor worker entered `needs_input` (including terminal `AskUser` choices and `questionId`, or a desk permission prompt), `pr` (opened, merged or closed pull request), `stopped`, `done` (when not already covered by a report), `left`, or `sent_home` (coalesced across bursts).
- A message is queued to the bot's inbox, or the owner clicks **Send test** in Settings (`test: true`).

Each payload has `{ source: "droid-office", version: 1, event, test?, deliveryId?, ackIds?, summary, sentAt, lead: { id, name }, items: [...] }`. Durable items carry an `ackId` (`team:<floor>:<seq>` or `msg-...`) that stays in `office_inbox` until acknowledged via `office_inbox({ ack: [ackId] })` (or `office_inbox({ deliveryId, ack: [ackId] })` in overlapping webhook runs), so a failed, retried, or concurrent webhook wake never loses or cross-acknowledges work.

