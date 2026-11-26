# Single-owner office

Implemented. Droid Office belongs to one person, who works with AI agents at desks.
There is no multiplayer, human teammate presence, chat, voice, screen sharing,
account system, password, session cookie, or login page.

## Server and browser responsibilities

The Node server owns worker processes, PTYs, boards, pipelines, floors,
and persisted state. Browser windows render that state and send actions.
Each connection has its own floor and terminal subscriptions, not a user identity.
Several windows or devices can watch the same PTY. Closing one leaves the others
attached. The last window to type determines the PTY's size.

Worker status comes from Droid's hooks. Terminal input does
not create typing presence.
Single-player games and local issue-card carrying remain browser features.

## Access

Loopback requests connect without credentials. Every server start creates a
random in-memory pairing token (historically called the LAN token). Remote HTTP
requests and WebSocket connections arrive only through Tailscale Serve HTTPS
and must supply it as `?t=<token>`, or carry a paired device token. Startup prints
the HTTPS companion link and an Android pairing QR code. Restarting changes the
pairing token.

A paired phone (Droid Office for Android) is a device of the same owner, not a
second user. Pairing gives it a device token, sent as `Authorization: Bearer` or
`?d=`, that opens the office like the LAN token but survives restarts. The office
stores only its SHA-256 in `.droid-office/devices.json`; forgetting the phone in
Settings → Phone & web revokes it at once. A device record names a phone, never a
person: it has no role, profile or presence.

The main listener always binds `127.0.0.1`, including with legacy `--host` flags.
It serves the Mac app and local browsers. Remote access, including Android,
requires Tailscale HTTPS, even on the same Wi-Fi. A separate loopback Serve
backend shares the HTTP and WebSocket handlers but marks requests in-process:
they must authenticate and never gain local owner privileges. It validates the
Serve host and HTTPS Origin, refuses Funnel and a known different Tailscale
user, and ignores forwarded-host overrides. Client headers cannot grant local
trust. Local pairing management and `/api/status` remain local-only. Funnel
reaches only the separate guest backend, and only while external sharing is on.

The HTTPS endpoint starts by default and keeps its ports and on/off setting in
`.droid-office/tailnet-https.json`. Disabling it closes remote HTTP and WebSocket
connections and removes only its own Serve mapping. Shutdown retains the mapping
for a stable URL on restart. The setting is independent of remote MCP and the
web companion switch (which does not disable Android). Set
`DROID_OFFICE_TAILNET_HTTPS=off` for local-only operation.
See [the guide](guide/getting-started.md#access) for details.

## External guests

The owner can share a scoped, secret link with someone outside the tailnet
(see [guest-sharing.md](guest-sharing.md)). A guest is not an account or a
teammate: there is no sign-in, profile, avatar, cursor, chat, voice or presence,
and the office never shows one guest to another or to the owner as a person. A
link is a credential for one preset's scope; the Share list shows only how many
connections are open on it. Guests reach the office only through a separate
loopback guest backend that Tailscale Funnel publishes while external sharing is
on. Every request there is a guest, never local and never the owner, and LAN,
device and loopback credentials do not work there. Guest tokens do not work on
the main or tailnet listeners. Guest connections are not paired devices: the web
companion switch does not affect them, and the Mac menu bar does not count them.

## Existing data

Legacy `accounts.json` and `chat.jsonl` files remain untouched and unread.
The office never migrates them into identities or serves their contents.
Workers, scrollback, pictures, and ordinary office configuration
keep their current persistence formats.

## Regression checks

- `tests/lan.test.ts` covers loopback access and token-gated network access.
- `tests/devices.test.ts` covers pairing, device tokens, revocation and the
  pairing link.
- `tests/tailnet-https.test.ts` covers Serve lifecycle, collisions, HTTPS-only
  origins, Funnel refusal, proxy authentication and local owner isolation.
- `tests/guest-http.test.ts` covers the guest backend's allowlist and credential
  isolation between the main, tailnet and guest listeners.
- `tests/no-media.test.ts` rejects capture APIs, peer signaling, voice/share UI,
  chat, and teammate presence while preserving office sounds and the jukebox.
- Worker, terminal, floor and pipeline suites cover the retained server
  workflows.
