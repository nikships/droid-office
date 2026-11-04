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

Every tool a remote bot sees in `tools/list` when every Setting allows it. The `visit_*` tools need Settings → **Subagents & visits** → **Visits between workers** on. Hiring does not depend on the Subagents setting: a bot has the owner's access. A tool that is off is not listed, and a direct call to it says why. `office_roster`, `office_look`, `office_send_home` and `office_owner` give a bot the owner's access to the whole building; no Setting turns them off, so give a key only to a bot you would trust with the office. `tests/remote-mcp.test.ts` checks that this list matches `tools/list`, with every argument, and prints the exact entry to add when a tool changes.

Whiteboard file paths and `cwd` values are on the **office machine**, not the bot's host.

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

Read the end of any worker's terminal, on any floor, without typing anything. name "office-shell" reads the floor's boss shell. At most 48,000 characters, with a truncation marker if older text was omitted. A snapshot, not a transcript; for a cloud worker use office_owner with thread.read.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | yes | Worker name or id, case-insensitive. Use office_roster to find it. |
| `floor` | string | no | Floor id, number (1 is the top of the elevator list) or name. |
| `lines` | integer | no, default `80` | Latest terminal lines, default 80, at most 400. |

### `office_send_home`

Send any worker home, on any floor, exactly as the owner's SEND HOME does: owner-hired workers, other leads' subagents, external workers, you or your lead. cleanup keep (the default) leaves its worktree and branch; worktree deletes the worktree and keeps the branch; all deletes both, including commits no remote has. The reply says what the worktree held. Its subagents stay, without a lead.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | yes | Worker name or id, case-insensitive. Use office_roster to find it. |
| `floor` | string | no | Floor id, number (1 is the top of the elevator list) or name. |
| `cleanup` | "keep" \| "worktree" \| "all" | no, default `"keep"` | What becomes of its worktree. Default keep. Use worktree or all only when the owner asked to delete it. |

### `office_owner`

Send one action the owner's office window sends, with the same effect and toast, attributed to you. args are that action's fields from the office protocol (src/shared/protocol.ts ClientMsg), for example worker.spawn {deskId: "auto", prompt, worktree, model, effort}, worker.prompt {workerId, prompt}, worker.answer {workerId, menu, choice}, gh.merge {number, method, deleteBranch}, subagents.set {settings}. Floor-scoped actions run on floor (default: the worker's floor for worker actions, else your desk's). Returns the outcome, toasts and any reply. Actions: floor.reorder, floor.repos, floor.folders, floor.branches, floor.branch, floor.add, floor.remove, floor.projectsDir, worker.spawn, worker.fork, worker.resume, worker.shoot, worker.kill, worker.worktree, worker.rebuild, worker.prompt, worker.answer, worker.pr, worker.interrupt, thread.read, term.input, station.open, station.prompt, shell.input, gh.refresh, gh.merge, gh.comment, gh.close, gh.labels, gong, pipelines.refresh, pipelines.detail, pipelines.rerun, pipelines.cancel, pipelines.run, leaveOnMerge.set, freshMain.set, autoHeal.set, models.hide, workerLabels.set, subagents.set, prompts.set, prompts.agent, worktreeSetup.get, worktreeSetup.set, machine.limit, jira.connect, jira.disconnect, jira.epic, jira.refresh, factory.connect, factory.disconnect, factory.refresh, setup.check, setup.droid.install, setup.droid.signIn, setup.droid.signInCancel, setup.onboarded, subscriptions.proxy, subscriptions.connect, subscriptions.connectCancel, subscriptions.disconnect, subscriptions.provider, subscriptions.models, subscriptions.refresh, changes.diff, changes.commit, changes.discard, changes.pr, upgrade.check, upgrade.start, decor.add, decor.update, decor.remove, jukebox.play, jukebox.skip, jukebox.stop, whiteboard.ping.

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | "floor.reorder" \| "floor.repos" \| "floor.folders" \| "floor.branches" \| "floor.branch" \| "floor.add" \| "floor.remove" \| "floor.projectsDir" \| "worker.spawn" \| "worker.fork" \| "worker.resume" \| "worker.shoot" \| "worker.kill" \| "worker.worktree" \| "worker.rebuild" \| "worker.prompt" \| "worker.answer" \| "worker.pr" \| "worker.interrupt" \| "thread.read" \| "term.input" \| "station.open" \| "station.prompt" \| "shell.input" \| "gh.refresh" \| "gh.merge" \| "gh.comment" \| "gh.close" \| "gh.labels" \| "gong" \| "pipelines.refresh" \| "pipelines.detail" \| "pipelines.rerun" \| "pipelines.cancel" \| "pipelines.run" \| "leaveOnMerge.set" \| "freshMain.set" \| "autoHeal.set" \| "models.hide" \| "workerLabels.set" \| "subagents.set" \| "prompts.set" \| "prompts.agent" \| "worktreeSetup.get" \| "worktreeSetup.set" \| "machine.limit" \| "jira.connect" \| "jira.disconnect" \| "jira.epic" \| "jira.refresh" \| "factory.connect" \| "factory.disconnect" \| "factory.refresh" \| "setup.check" \| "setup.droid.install" \| "setup.droid.signIn" \| "setup.droid.signInCancel" \| "setup.onboarded" \| "subscriptions.proxy" \| "subscriptions.connect" \| "subscriptions.connectCancel" \| "subscriptions.disconnect" \| "subscriptions.provider" \| "subscriptions.models" \| "subscriptions.refresh" \| "changes.diff" \| "changes.commit" \| "changes.discard" \| "changes.pr" \| "upgrade.check" \| "upgrade.start" \| "decor.add" \| "decor.update" \| "decor.remove" \| "jukebox.play" \| "jukebox.skip" \| "jukebox.stop" \| "whiteboard.ping" | yes | The owner action, a ClientMsg type. |
| `args` | object | no, default `{}` | The action fields, without t. |
| `floor` | string | no | Floor id, number (1 is the top of the elevator list) or name. |

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
