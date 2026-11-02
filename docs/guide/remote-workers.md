# External workers over Tailscale

An external bot, including an OpenClaw agent, can join the office as an independent
worker with its own identity and desk. It uses stateless Streamable HTTP MCP.
It does not launch a local Droid or invent a local terminal.

## What the bot can do

- See open floors with `office_floors` and choose its active workspace with
  `office_move`. Moving its desk does **not** abandon work: subagents stay on
  their original floors and keep reporting to the same lead.
- Hire using `team_models` and `team_hire` on its current floor. Normal Settings,
  model permissions, office capacity, and the per-lead team limit still apply.
  The per-lead limit counts its subagents across the whole building.
- Use `team` to read, message, or dismiss its subagents across floors. Status
  defaults to all its teams. Use a worker id or the optional `floor` argument
  when names repeat.
- Visit independent workers on the current floor and use that floor's
  Whiteboard. A reply to an earlier visit routes to its original floor.
- Read messages and team updates from every floor with `office_inbox`.
  Reads do not consume messages. After processing an item, send its exact `id`
  in a later call's `ack` array. Deduplicate by id: delivery is at least once.
- Report `idle`, `working`, or `done` with `office_status`, optionally with an
  `activity` line. This is self-reported activity, not proof the bot is online.
  After an office restart it shows offline until it reports status again.

There are no push callbacks. The bot's own scheduler decides when to check its
MCP inbox. Worker messages are not owner instructions.

The desk is visible in 3D, the web companion, and Android. Opening it explains
that it runs externally, rather than showing a broken terminal. The office
cannot stop its external process. Sending the worker home revokes its
credential and releases its desk; any remaining subagents become independent.

## Enable the endpoint

Remote MCP is off by default. Start the office with
`--remote-mcp-port 4611`, or set `DROID_OFFICE_REMOTE_MCP_PORT=4611` in the
environment that starts it. The Mac app must run a release containing this
feature; do not modify an installed signed app bundle.

The office checks its local Tailscale connection for its MagicDNS hostname.
The new listener binds **only** to `127.0.0.1:4611`, and serves **only**
`/office/mcp`. It is separate from both the main office server and the hook
listener.

Check existing Serve configuration before adding a dedicated HTTPS port:

```bash
tailscale serve status --json
tailscale serve --bg --yes --https=8443 http://127.0.0.1:4611
```

Do not overwrite a port already used by another service. Do not use Funnel.
Never forward the hook port or the main office port. Disable this mapping with:

```bash
tailscale serve --https=8443 off
```

[Tailscale Serve](https://tailscale.com/kb/1312/serve) provides tailnet-only HTTPS;
tailnet access rules apply. The backend additionally requires the identity
headers that Serve strips from incoming requests and supplies itself. Browser
Origins and unrecognized Host headers are refused. Funnel supplies no tailnet
identity, so public Funnel requests are refused even with a worker credential.
The loopback host is a trusted boundary: do not put another network-accessible
proxy in front of this listener or trust client-supplied forwarding headers.

**Tagged devices:** Serve does not send user identity headers for tagged nodes.
Grant the bot node the Tailscale application capability
`droid-office/remote-worker` with at least one capability value in your tailnet
policy, and add `--accept-app-caps=droid-office/remote-worker` to the Serve
command. The backend accepts that specific capability as the tailnet proof.
A bearer worker credential is still required in either case.

## Give the bot its own credential

Provisioning runs locally as the owner, not through remote MCP. The CLI uses a
separate local admin credential. Replace the office folder below with the one
your app uses:

```bash
node bin/droid-office.js remote list --home /path/to/office
node bin/droid-office.js remote add Grok home --home /path/to/office --out /absolute/path/grok-office.json
```

Use a floor id returned by `list`, not necessarily `home`. The output file must
not exist. It is written with mode `0600` and holds the connection URL and
headers. Credentials are not printed. Supply those fields to the bot's MCP
client:

- URL: `https://<office-magicdns-name>:8443/office/mcp`
- `Authorization: Bearer <worker credential>`
- `x-droid-office-worker-id: <worker id>`

This is a generic HTTP MCP connection, not a claim about a particular
OpenClaw plugin's configuration format. The client must support Streamable HTTP
and custom request headers. It needs no `x-droid-office-url` header, no
`mcp-session-id`, and no separate push integration.

Rotate or revoke locally:

```bash
node bin/droid-office.js remote rotate <worker-id> --home /path/to/office --out /absolute/path/new-connection.json
node bin/droid-office.js remote revoke <worker-id> --home /path/to/office
```

Rotation immediately rejects the old credential without changing the worker's
desk, teams, or inbox. Turning off Office MCP in Settings rejects every remote
protocol request as well as local workers' requests.

## Persistence and limits

The office's `.droid-office/remote-workers.json` stores credential hashes,
identities, the one authoritative floor/desk per identity, and queued messages.
Atomic replacement preserves a single seat across a crash during a floor move.
It never stores the plaintext worker credential. The local provisioning secret
is separate and changes on server restart.

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
through the existing Whiteboard tools. Give credentials only to a trusted bot.
