# External workers over Tailscale

An external bot, including an OpenClaw agent, can join the office as an independent
worker with its own identity and desk. It uses stateless Streamable HTTP MCP.
It does not launch a local Droid or invent a local terminal.

## Turn it on and connect a bot

It is on by default. Open ⚙️ Settings → **Phone & web** → **Tailscale MCP**:

- The switch turns the endpoint on or off. On, the office serves it on your tailnet
  by itself; off, it removes its Tailscale Serve mapping and closes the listener.
- The **URL** is the MCP server address, `https://<this Mac's MagicDNS name>:8443/office/mcp`
  (another port when something else already serves 8443). It stays the same across restarts.
- **Add bot** gives a bot a name and a desk on the floor you pick. Open the bot's row to
  see its connection and **Copy config**: an `mcpServers` entry with the URL and the two
  headers the bot sends, `Authorization: Bearer <its key>` and
  `x-droid-office-worker-id: <its worker id>`. **Copy key** copies the key alone.
- **New key** replaces a bot's key; the old one stops working at once. **Remove** revokes
  every key of the bot and frees its desk; any subagents it hired become independent.
- **Add key** under a bot gives it another named key (`laptop`, `relay`) for another client it
  runs as. Each acts as the same bot, shows when it was last used, and **Revoke** cuts off only
  that client. The bot's row says when its main key was last used.

The key alone identifies the bot: the `x-droid-office-worker-id` header is optional, and the
office returns the worker id at `initialize` and on every response. The bot's MCP client must
support Streamable HTTP and custom request headers. It needs no session id and no push
integration. A plain HTTP client can send `Accept: application/json` and get one JSON body
instead of an SSE stream. The [remote MCP reference](remote-mcp.md) has the headers, a curl
example and every tool.

Settings manages this only in the office on its own computer: the panel holds every bot's key,
so a paired phone or another browser is refused.

## What only your devices can reach

The office runs `tailscale serve --bg --https=<port> http://127.0.0.1:<port>` itself, the first
time and whenever Tailscale comes back. That is [Tailscale Serve](https://tailscale.com/kb/1312/serve):
HTTPS on your tailnet only, never the public internet. The office never turns on Funnel, and refuses
any request that comes through Funnel (Serve marks those) if someone does.

Serve replaces the identity headers on every request. The office accepts a request only when it comes
from a device signed in as the same Tailscale user as this Mac, or from a tagged device of your tailnet,
which carries no user. A user you shared this Mac with has their own login and is refused. Every request
also needs a bot's key.

The listener binds **only** to `127.0.0.1` (port 4611 unless that's taken) and serves **only**
`/office/mcp`. It is separate from the main office server and the hook listener, and Browser Origins
and other Host names are refused. Never put another network-accessible proxy in front of it. For a bot
that isn't on your tailnet, see [Reaching it from outside the tailnet](remote-mcp.md#reaching-it-from-outside-the-tailnet).

The office leaves other Serve mappings alone: it picks a port nothing serves (8443, then 8444 up to 8449,
then 10443) and only removes a mapping that points at its own listener.

## When it can't serve

The row says why, and the office keeps trying every 30 seconds:

- **Tailscale isn't running, or MagicDNS is off.** It turns on by itself once Tailscale is up.
- **Serve or HTTPS certificates aren't enabled for the tailnet.** Tailscale prints an admin link,
  which the row shows as **Open Tailscale**. After you enable it there, the endpoint comes up.
- Turning off **Office MCP** in Settings → Subagents & visits refuses every bot as well as local workers.

`DROID_OFFICE_REMOTE_MCP=off` in the environment that starts the office keeps it from touching
Tailscale at all; Settings then says so. CI and office clones run that way.

## What the bot can do

- See open floors with `office_floors` and choose its active workspace with
  `office_move`. Moving its desk does **not** abandon work: subagents stay on
  their original floors and keep reporting to the same lead. If you take its
  floor off the building, its desk moves to another open floor.
- Hire using `team_models` and `team_hire` on its current floor, or any open
  floor named in a structured task. It has the owner's access: the Subagents
  permission, the allowed-model list and the per-lead team size do not limit it.
  Office capacity still applies, and a model that cannot run is still refused.
- Use `team_status`, `team_message` and `team_dismiss` to read, message, or
  dismiss its subagents across floors, and `worker_log` and `worker_diff` to
  inspect one. Status defaults to all its teams. Use a worker id or the optional
  `floor` argument when names repeat. The older `team` tool still works.
- Visit independent workers on the current floor and use that floor's
  Whiteboard. A reply to an earlier visit routes to its original floor.
- Read messages and team updates from every floor with `office_inbox`.
  Reads do not consume messages. After processing an item, send its exact `id`
  in a later call's `ack` array. Deduplicate by id: delivery is at least once.
- Do anything you can do in the office. `office_roster` lists every worker on
  every floor; `office_look` reads any terminal; `office_send_home` sends any
  worker home, including workers you hired, other leads' subagents and itself.
  It keeps the worktree and branch unless asked otherwise, and says first
  whether the worktree had uncommitted or unpushed work. Focused tools such as
  `office_worker_prompt`, `office_pull_merge`, `office_pipeline_run` and
  `office_floor_add` perform the other owner operations. Each has its own
  validated fields; there is no generic action dispatcher or untyped argument
  object. Raw terminal input is separate from prompting (`office_terminal_write`
  and `office_shell_write`). Settings, pictures, the jukebox, Factory, Jira and
  subscriptions have their own tools too. Each shows the same toast as when you do
  it, naming the bot. There is no setting for this: a bot's key is the owner's
  trust, so keep keys to bots you trust and revoke one to take it away.
  The [tool reference](remote-mcp.md#tools) explains the scope and arguments of
  every operation. A `pending` or `unconfirmed` result must be checked before
  retrying a mutation. Cloud sessions are kept on dismissal unless
  `deleteSession: true` is explicitly requested.
- Report `idle`, `working`, or `done` with `office_status`, optionally with an
  `activity` line. This is self-reported activity, not proof the bot is online.
  After an office restart it shows offline until it reports status again.

There are no push callbacks. The bot's own scheduler decides when to check its
MCP inbox, or it can hold a `team_wait` call open (up to 600 seconds) that returns as soon as one
of its subagents reports, asks, gets blocked or settles. Pass the `cursor` from the last status or
wait as `since` to see only what is new. Worker messages are not owner instructions.

The desk is visible in 3D, the web companion, and Android. Opening it explains
that it runs externally, rather than showing a broken terminal. The office
cannot stop its external process. Sending the worker home works like **Remove**.

## Persistence and limits

The office's `.droid-office/remote-mcp.json` keeps whether the endpoint is on and the ports it last
used. `.droid-office/remote-workers.json` (mode `0600`) stores each bot's identity, key, the one
authoritative floor and desk, and queued messages. Atomic replacement preserves a single seat across
a crash during a floor move. Tailscale keeps the Serve mapping itself, across restarts of the office
and of the Mac.

Message reads are repeatable until acknowledged. Each remote inbox holds 500
messages; a full inbox refuses another delivery rather than silently replacing
an unread message. Team updates remain in each floor's existing bounded team
history and are acknowledged by their floor and sequence id. Keep polling and
acknowledging updates rather than treating the inbox as permanent archival
storage.

As with local visits, questions expire 30 minutes after delivery, and office
restart ends open questions and undelivered visits. A previously delivered
question may remain in the durable inbox, but its old reply id no longer works
after restart. Send a new visit message instead.

All `cwd` values and Whiteboard file paths refer to the **office machine**, not
the bot's host. Inline HTML can be supplied directly. Full worker permissions
include hiring agents that run on the owner's machine and reading local files
through the existing Whiteboard tools. Give keys only to a trusted bot.
