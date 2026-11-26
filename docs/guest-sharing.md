# External guest sharing

Implemented. The owner can make a secret **share link** that opens the web companion for someone outside
their tailnet. Each link is scoped by one of five presets. Guests are not accounts or teammates: they have
no avatar, cursor, chat, voice or presence, and the office shows them nothing outside their link's scope
(see [single-owner.md](single-owner.md)). Code says "guest link"; the UI says "Share" and "share link".

## Presets

Every link has exactly one preset. View presets never change anything. Write presets act only inside
their scope.

| Preset | Scope | Can change things | Mission Control |
| --- | --- | --- | --- |
| `view-office` View only (entire office) | every open floor | no | watch |
| `view-worker` View only (single worker) | one worker on one floor | no | hidden |
| `view-floor` View only (single floor) | one floor | no | hidden |
| `edit-floor` Single floor (full read & write) | one floor | yes | hidden |
| `edit-office` Complete access overall | every open floor | yes | watch and drive |

Settings and their actions (connections, prompts, models, setup, limits, upgrades), pairing and devices,
remote MCP, share-link management and the sharing toggle, floor management, the office shell, automation,
decor and the jukebox stay owner-only for every preset, including `edit-office`. The presets and their
words are in `src/shared/guest-links.ts`.

## Transport: a Funnel-only guest backend

Guests are outside the tailnet, so the office publishes a third loopback listener, the **guest backend**
(`src/server/guest-funnel.ts`), through [Tailscale Funnel](https://tailscale.com/kb/1223/funnel). It is
separate from the main listener and from the tailnet Serve backend (`tailnet-https.ts`), which still
refuses Funnel traffic.

- **Only while sharing is on.** The global toggle is off for a new or upgraded office. Turning it on starts
  the guest backend and runs `tailscale funnel --bg --yes --https=<port> http://127.0.0.1:<backend>`
  ([CLI reference](https://tailscale.com/kb/1311/tailscale-funnel)). Turning it off closes every guest
  socket at once (close code 4411), closes the listener and runs `tailscale funnel --yes --https=<port> off`.
  Nothing public remains.
- **Ports.** Funnel allows only 443, 8443 and 10000. The office tries 10000, then 8443, then 443. It never
  takes a port another mapping uses: Serve and Funnel cannot share a port, so the tailnet HTTPS gateway
  keeps its own. The chosen ports are saved so the guest URL stays the same across restarts.
- **Requirements.** Funnel needs Tailscale v1.38.3 or later, MagicDNS, HTTPS certificates and the `funnel`
  node attribute in the tailnet policy. When Tailscale is not running, or Funnel needs approval, the Share
  list shows the reason and the admin link, and the office retries in the background.
- **Every request is a guest.** The backend accepts only loopback connections whose `Host` and `Origin`
  match its public origin, and marks each one as a guest in-process (`lan.ts` `markGuest`). It accepts
  requests with or without `Tailscale-Funnel-Request: ?1`: an owner or tailnet device that opens the guest
  URL is a guest too. Loopback trust, the LAN token (`?t=`) and device tokens are refused there, and guest
  tokens are refused on the main and tailnet listeners. `x-forwarded-host` is dropped so it can never make a
  forwarded host count as same-origin.

### Mapping lifetime

`tailscale funnel --bg` is kept by tailscaled, not by the office process. The office records the mapping it
owns in `guest-funnel.json` (backend port, Funnel port, `published`, and the office's data folder) before it
runs the CLI. It removes a mapping only while that mapping still points at its own backend.

- **Clean shutdown** removes the mapping (unlike Tailscale HTTPS, which keeps its private mapping).
- **Crash or kill while sharing is on.** The mapping stays published and points at a loopback port that
  nothing owns until the office starts again. Funnel answers with a gateway error meanwhile. If another local
  program binds that port in the meantime, Funnel exposes it. At the next start the office takes the
  mapping back: with sharing on it rebinds the saved backend port (or re-points the same Funnel port at a
  new one), and with sharing off it removes the mapping.
- **Another office's mapping is never touched.** A `guest-funnel.json` whose recorded data folder is not
  this office's (a clone, a test run) is ignored: the office neither reuses, replaces nor removes that
  mapping, and picks a free Funnel port if it publishes at all.
- **Locked offices never run the CLI.** `DROID_OFFICE_GUEST_SHARING=off` locks sharing: the toggle answers
  403 and the office never runs `tailscale funnel`, not even to clean up. If it finds its own leftover
  mapping, it prints the command that removes it.

### Testing without the real daemon

`DROID_OFFICE_TAILSCALE_BIN` (or `--tailscale-bin`) pins every `tailscale` call to one absolute path, with
no PATH lookup and no fallback to an installed CLI. A missing file stops the office from starting. Tests
leave `cfg.guestSharing` unset, which locks sharing. The office-clone skill's `start.sh` exports
`DROID_OFFICE_GUEST_SHARING=off` unless the run sets it. It refuses to unlock sharing without
`DROID_OFFICE_TAILSCALE_BIN`, and the clone copier leaves out `guest-funnel.json`. A copied
`guest-links.json` with sharing on therefore never publishes a clone.

## Links and tokens

- **Token.** 32 random bytes, base64url. The office stores only its SHA-256, in `guest-links.json`
  (mode 0600, atomic writes), and checks a token against every link in constant time.
- **URL.** `<guest origin>/dashboard#g=<token>`. The fragment keeps the token out of request lines, logs and
  `Referer`. It is shown once, when the link is created. The page removes it from the address bar and sends
  it as `Authorization: Bearer <token>` on requests, as `?g=<token>` on embedded read-only GETs (pictures),
  and as the WebSocket subprotocol pair `droid-office-guest, <token>` (the server answers with
  `droid-office-guest` and never echoes the token).
- **Limits.** At most 32 active links. Labels are cleaned like device names and capped at 64 characters.
- **Expiry and revocation.** A link lasts 1 hour, 24 hours, 7 days or until revoked. Expiry is checked on
  every request, and a timer closes a link's sockets when it expires (close code 4410, reason `expired`).
  Revoking is permanent and closes the link's sockets at once (4410, `revoked`). Ended links stay in the
  Share list for 7 days.
- **Refusals.** A missing or unknown token answers 401 `unavailable`; expired or revoked 410; sharing off
  403 `disabled`. Refusals carry only the reason and a fixed sentence, never paths, hostnames or tokens.
- **Failed attempts.** A valid token always passes. Wrong tokens are counted per source: past 20 in a
  minute, a wrong token gets 429 with `Retry-After`. Requests without a token are not counted (the page
  shell and card assets carry none). The source is `X-Forwarded-For`, which tailscaled's Funnel proxy
  replaces with the client address the Funnel ingress reports
  ([`addProxyForwardedHeaders`](https://github.com/tailscale/tailscale/blob/main/ipn/ipnlocal/serve.go)), so
  a client cannot choose it. Only a process on this machine can send another value.

## Enforcement

Everything is checked on the server and denied by default.

- **HTTP** (`src/server/server-runtime/guest-http.ts`). The guest backend serves an explicit allowlist:
  the companion's static files and `/dashboard` without a token, then `GET /api/guest/hello` and the routes
  below with one. Everything else answers 404 whether or not it exists on another listener.

  | Route | Presets | Scope check |
  | --- | --- | --- |
  | `GET /api/thread/image` (pictures by id), `GET /api/changes/file` (changed pictures) | all | worker in scope |
  | `GET /api/whiteboard/file`, `/render`, `/render/status`, `GET /api/gh/pull`, `/issue`, `/pull/diff` | office and floor presets | floor in scope |
  | `GET /api/thread/file`, `GET /api/thread/files`, `GET /api/term/file`, `POST /api/term/paths` | write presets | worker in scope |
  | `POST /api/term/drop`, `POST`/`DELETE /api/prompt/image`, `POST /api/whiteboard/blob`, `GET /api/gh/labels` | write presets | worker or floor in scope |
  | `GET /api/agents/droid/models`, `GET /api/agents/droid/commands` | write presets | commands: worker or floor in scope |

  Routes that read a file by a path the guest chooses are write-only: a floor's folder can be the owner's
  whole home folder, and a write guest already has the worker's terminal. `/api/changes/file` serves only
  pictures in the worker's own list of changes: the new side must resolve inside the checkout (real path,
  no `..` or symlinks out), and the old side is a blob at the diff's base commit. Whiteboard card frames
  (`/whiteboard/c/<capability>/…`) cannot carry a token. Without one they resolve by capability only on
  floors an active `view-office`, `edit-office`, or matching `view-floor`/`edit-floor` link shows. With one,
  they are held to that link's scope.
- **WebSocket.** A guest socket authenticates only on the guest backend, with the token as the second
  `Sec-WebSocket-Protocol` entry; the office answers with `droid-office-guest`. The connection carries its
  grant on `Client`.
  - *Inbound.* Every message passes one gate before the message switch. `GUEST_INBOUND` in
    `src/shared/guest-policy.ts` classifies every `ClientMsg` type as read, write or owner-only, typed so a
    new message type fails typecheck until it is classified. Unclassified and owner-only messages are
    refused, write messages need a write preset, and every target must be in scope
    (`src/server/server-runtime/guest-gate.ts`). A refused message gets the same generic refusal whatever
    the reason.
  - *Outbound.* Every send path (direct sends, broadcasts, floor sends, terminal data, off-floor screens
    and the welcome) passes one filter, `GUEST_OUTBOUND`, which drops or redacts every `ServerMsg` type for
    the guest's scope. Out-of-scope floors, workers and Mission Control are never sent, not sent and hidden.
  - *Writes.* A write guest may resize a terminal; a view-only guest may not. Write presets may hire desk,
    shell and cloud workers on floors in scope. A guest's Whiteboard edits keep the owner as the board's
    author, and the audit names the link. Accepted writes are audited once the office has acted on them.
  - *No owner side effects.* A guest never counts as the owner looking: opening or acknowledging a worker,
    last-visited floors, board polling, wake-ups, and Jira or Linear refreshes ignore guests. A guest is not
    one of the owner's browsers: the web companion switch does not close guest sockets, and the Mac menu
    bar's device counts leave guests out.
  - *Closed floors.* A floor or single-worker guest whose floor closes waits in a lobby and returns when the
    floor reopens, without a new link or connection.
  - *Close codes.* 4410 when the link expired or was revoked (the close reason says which), 4411 when the
    owner turned sharing off. They do not collide with 4401 (device unpaired) or 4403 (web companion off).

## Owner management

The Share modal is in **Settings → Phone & web → Share links**, in the 3D office, the Mac app's companion and
the web companion. Android has no Share UI: guests use the web companion only.

The API is documented at the top of `src/shared/guest-links.ts`. `GuestLinksState.manage` says what the
requester may do:

- `full`: the office's own page on its own machine (the `/api/mobile/pairing` gate). It can do everything.
- `limited`: any other authenticated owner request (a paired device token, or this start's LAN token through
  the main or tailnet listener). It can list links and the audit log, revoke links and turn sharing off.
  Creating a link and turning sharing on answer 403, so a paired device cannot mint a credential that
  outlives its own pairing. Guests get nothing.

Every owner WebSocket connection receives `guestLinks.changed` (no data, `audit: true` when the audit log
grew), debounced to 250 ms. Owner pages then re-read the API, so open-guest counts update without a refresh.

## Audit

Every guest change the office accepts is appended to `guest-audit.jsonl` (mode 0600; rotated to
`guest-audit.1.jsonl` at 2 MB). Each entry has the link id and label (copied, so it survives revocation),
the preset, the time, the target (floor, worker or Mission Control, with ids and names), an action and
detail text of up to 200 characters. Terminal input is grouped into one entry per worker burst (ended by
5 seconds of quiet, or after 60 seconds) with a short preview. The preview is what the guest typed, so it
can contain secrets they typed; the file is readable only by the owner (mode 0600). Refused attempts are not
logged. The owner pages through the log newest first.

## State and configuration

| File (office `.droid-office/`) | Holds |
| --- | --- |
| `guest-links.json` | the sharing toggle and every link (hashes only), mode 0600 |
| `guest-audit.jsonl`, `guest-audit.1.jsonl` | the audit log, mode 0600 |
| `guest-funnel.json` | the Funnel mapping this office owns and whether it is published, mode 0600 |

| Variable | Effect |
| --- | --- |
| `DROID_OFFICE_GUEST_SHARING=off` | Locks external sharing: the toggle is refused and the office never runs `tailscale funnel`. |
| `DROID_OFFICE_TAILSCALE_BIN=<absolute path>` | Runs only that `tailscale` executable, with no fallback. |

## Regression checks

- `tests/guest-links.test.ts`: tokens, hashes, expiry, revocation, the failed-token limit, token
  presentation and the audit log.
- `tests/guest-funnel.test.ts`: Funnel port planning, ownership, kill switch, leftover mappings after an
  unclean exit, copied state from another office, the lock, and the Tailscale binary pin.
- `tests/guest-http.test.ts`: the guest allowlist, scope per preset, card frames, the `full` and `limited`
  owner API, credential isolation between listeners, and the menu bar counts.
- `tests/office-clone.test.ts`: clones leave out `guest-funnel.json` and keep sharing locked.
- `tests/no-media.test.ts`: guests add no media, chat or presence.
