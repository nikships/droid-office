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

Every tool a remote bot sees in `tools/list` when every Setting allows it. Some depend on Settings → **Subagents & visits**: hiring (`team_models`, `team_hire`) needs subagents on and desk workers allowed to hire, and the `visit_*` tools need **Visits between workers** on. A tool that is off is not listed, and a direct call to it says why. `tests/remote-mcp.test.ts` checks that this list matches `tools/list`, with every argument, and prints the exact entry to add when a tool changes.

Whiteboard file paths and `cwd` values are on the **office machine**, not the bot's host.

### `office_whoami`

Read your office identity, desk, lead if you are a subagent, permission to hire and visit, team size, worktree default and wake-note setting. Use this to establish your role before coordinating work. It does not hire, message or wait.

No arguments.

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

### `team_models`

Read the models allowed for your subagents, including ids, providers, credit multipliers, efforts, owner notes, no-images limits, the default, and why any cannot run. Read this before choosing a model for each task. Hiring refuses blocked models, including the default, before taking a desk.

No arguments.

### `team_hire`

Hire one fresh subagent at the nearest free desk for an independent task. It gets your brief, its own terminal, and normally a fresh worktree. Read team_models first. Permission, capacity and model refusals explain what to do; no desk is taken for an unavailable model. Commit shared prerequisites before hiring.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `title` | string | yes | Short task title shown over the subagent. |
| `brief` | string | yes | Complete task ticket: goal, context and files, boundaries, checks, and how to finish and report. Quotes, dollar signs and backticks are preserved. |
| `model` | string | no | Id from team_models. Omit for the Subagents setting, else the office default, else Droid default. Pick by owner notes, task difficulty and credit multiplier. |
| `effort` | "low" \| "medium" \| "high" \| "xhigh" \| "max" | no | Reasoning effort; choose a value this model supports according to team_models. Omit to inherit its configured effort. |
| `from` | string | no | Branch, tag or commit for the fresh worktree, without spaces or a leading dash. Origin is fetched first. Omit to start on your branch at HEAD, refreshed if behind origin. Uncommitted changes do not follow. Requires worktree: true. |
| `worktree` | boolean | no | Omit to follow the owner's Subagents setting (office_whoami shows it). True: isolated git worktree. False: use the project main checkout without switching its branch, only for read-only work or when your uncommitted changes must be visible. Non-git floors require false. |

### `team`

Manage only your own subagents. Status returns one named subagent or all, with unread reports, questions, finished turns, terminal input requests, stops and departures since your last status call. News is drained per caller, even for a named snapshot; nothing waits. Message answers a question or follows up, best between turns. Dismiss only after review and integration when worker and worktree are no longer needed; worktrees with work are kept.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | "status" \| "message" \| "dismiss" | yes | What to do. |
| `floor` | string | no | External workers only: restrict team operations to this floor. Omit for all your teams across the building. |
| `name` | string | no | Subagent name or id, case-insensitive. Status: omit for all. Required for message and dismiss. |
| `lines` | integer | no | Status only: include this many recent terminal lines per selected subagent, at most 400. Omit to leave terminals out. |
| `text` | string | no | Message only: answer or follow-up to type into the subagent session. Cannot answer a permission prompt in its own terminal. |

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
