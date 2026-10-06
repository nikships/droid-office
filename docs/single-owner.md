# Single-owner office

Implemented. Droid Office belongs to one person, who works with AI agents at desks.
There is no multiplayer, human teammate presence, chat, voice, screen sharing,
account system, password, session cookie, or login page.

## Server and browser responsibilities

The Node server owns worker processes, PTYs, queues, meetings, boards, floors,
and persisted state. Browser windows render that state and send actions.
Each connection has its own floor and terminal subscriptions, not a user identity.
Several windows or devices can watch the same PTY. Closing one leaves the others
attached. The last window to type determines the PTY's size.

Worker status comes from agent hooks or the OpenCode plugin. Terminal input does
not create typing presence. Meetings seat AI workers, never human participants.
Single-player games and local issue-card carrying remain browser features.

## Access

Loopback requests connect without credentials. Every server start creates a
random in-memory LAN token. Non-loopback HTTP requests and WebSocket connections
must supply it as `?t=<token>`. Startup prints a join link and QR code for another
browser on the same network. Restarting changes the token.

The default bind address remains `0.0.0.0`. Use `--host 127.0.0.1` to keep access
on the office's own machine. TLS and trusted reverse proxies remain available.
See [the guide](guide.md#access) for details.

## Existing data

Legacy `accounts.json` and `chat.jsonl` files remain untouched and unread.
The office never migrates them into identities or serves their contents.
Workers, queues, meetings, scrollback, pictures, and ordinary office configuration
keep their current persistence formats.

## Regression checks

- `tests/lan.test.ts` covers loopback access and token-gated network access.
- `tests/no-media.test.ts` rejects capture APIs, peer signaling, voice/share UI,
  chat, and teammate presence while preserving office sounds and the jukebox.
- Worker, terminal, floor, meeting, and queue suites cover the retained server
  workflows.
