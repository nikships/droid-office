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

- **Single-floor links leave out cross-repository workers.** A `view-floor` or `edit-floor` link does not
  show a worker that also works in another floor's repository (its `repos`), because its terminal, Changes
  window and pull requests reach that repository. Share such a worker with a single-worker link (view-only;
  the worker arrives without its entries for other floors) or an office link. An HTTP request that names
  another floor's repository with `?repo=` answers 404 unless the link reaches that floor, and a guest's
  hire can add only repositories on floors the link reaches.
- **Changes are for edit presets.** Listing and reading a worker's changes (`changes.watch`,
  `changes.unwatch`, `changes.diff`) needs an edit preset and is not audited; only edit links receive the
  `changes` and `changes.diff` frames. View presets keep only the changed-picture route
  (`GET /api/changes/file`).
- **Connections stay the owner's.** A guest's hire or prompt that hands a worker a Linear ticket is
  refused, since the ticket would move on the owner's Linear account. Connecting, refreshing or changing
  the Linear, Jira and Factory connections is owner-only, and their state never reaches a guest. A cloud
  hire from an edit preset still runs on the owner's Factory computers.
- **Mission Control without its settings.** Office presets get Mission Control with the Orchestrator's
  saved settings reduced to whether it is on (no model or effort), and without external bots.
## Transport: a Funnel-only guest backend

Guests are outside the tailnet, so the office publishes a third loopback listener, the **guest backend**
(`src/server/guest-funnel.ts`), through [Tailscale Funnel](https://tailscale.com/kb/1223/funnel). It is
separate from the main listener and from the tailnet Serve backend (`tailnet-https.ts`), which still
refuses Funnel traffic.

- **Only while sharing is on.** The global toggle is off for a new or upgraded office. Turning it on starts
  the guest backend and runs `tailscale funnel --bg --yes --https=<port> http://127.0.0.1:<backend>`
  ([CLI reference](https://tailscale.com/kb/1311/tailscale-funnel)). Turning it off closes every guest
  socket at once (close code 4411), closes the listener and runs `tailscale funnel --yes --https=<port> off`.
  Once that succeeds, nothing public remains. Until it does, the office keeps retrying and the Share window
  says so (see [Known risks](#known-risks)).
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
  | `GET /api/thread/file`, `GET /api/thread/files`, `GET /api/term/file`, `POST /api/term/paths` | write presets | worker in scope; `/api/thread/files` without a worker (the Hire dialog's `@` list): floor in scope, never for a single-worker link |
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

## What a guest sees

A share link opens the web companion (`/dashboard`) with only what its preset covers.
`src/client/dashboard-guest.ts` derives what the page shows and offers from the link's session. The office
enforces every boundary itself; the page only avoids offering what the office would refuse.

- **Shared-view badge.** The top bar shows **Shared view**, then **Can edit** or **View only**, then
  **Until <time>** when the link expires. Its tooltip names the scope (one worker, one floor or the
  office), whether the guest can work there, and when the link ends.
- **Token per tab.** The page reads the token from `#g=`, removes it from the address bar and keeps it in
  this tab's `sessionStorage` (`droid-office.guest-link`), never in `localStorage`. A refresh reopens the
  link; another tab opened without the link does not. `src/client/token.ts` (`setGuestAuth`) replaces every
  owner credential with the token, and `guestFetch` sends it as `Authorization: Bearer` to same-origin
  `/api/` paths only.

| Preset | Shows | Leaves out |
| --- | --- | --- |
| `view-office` | floor tabs for every open floor, All workers and the building pulse, each floor's workers and Whiteboard, Mission Control (watch only) | all work |
| `view-floor` | one floor's workers and its Whiteboard | floor tabs, All workers, Mission Control, all work |
| `view-worker` | one worker alone in one pane | the worker sidebar, layouts, floor tabs, All workers, Whiteboard, Mission Control, all work |
| `edit-floor` | what `view-floor` shows, plus work on that floor | floor tabs, All workers, Mission Control |
| `edit-office` | what `view-office` shows, plus work on every open floor and Mission Control's composer, Stop and New conversation | nothing beyond the owner-only list |

- **Every guest.** The **Shell** button is hidden. Settings, usage, Orchestrator settings, pairing, setup,
  update prompts and adding, reordering or removing floors never appear.
- **Edit presets only.** Work means prompts, terminal input and resizing, answering questions and
  permission prompts, hiring, interrupting, sending home, forking, resuming, rewinding, the queue, model
  and effort, git and pull requests, and Whiteboard edits. The Changes window opens only on edit presets
  (and not for cloud workers).
- **View-only pages.** There is no Hire button, no composer, no terminal input and no answers to questions
  or permission prompts. The worker menu offers only opening and copying. The Whiteboard is read-only:
  cards, marks and comments stay live, and nothing on the board can change. File links in Threads and
  terminals are inert, and the page never requests the routes the guest backend opens only to write
  presets (`GUEST_WRITE_ONLY_PATHS`).

### Status screens

No status screen names the office's address, paths or anything else about it.

| When | Title |
| --- | --- |
| The page is checking the link | **Opening the shared view…** |
| The token is missing or unknown | **This link isn’t available** |
| The link expired | **This link has expired** |
| The owner revoked the link | **This link was turned off** |
| The owner turned sharing off | **Sharing is turned off** (with **Try again**) |
| The office does not answer, or too many wrong tokens came from this address | **The office is offline or restarting** (with **Try again**) |
| A floor or single-worker link's floor is closed | **This floor isn’t open right now** |
| A single-worker link's worker left before the page showed it | **This worker has left** |

- **Opened without a link.** A page on the guest address with no token (opened directly, or refreshed
  after its link ended) asks `GET /api/guest/hello` without one and shows the matching refusal screen,
  never pairing. A tab mark (`droid-office.guest-origin` in `sessionStorage`) sends a refresh there first.
- **Ending.** A refusal other than **Sharing is turned off** makes the tab forget its token. Close codes
  4410 and 4411 show the screen at once; any other close asks hello again and reconnects. A wrong-token
  limit (429) waits 5 to 60 seconds before asking again, and other failures keep retrying.
- **While connected.** A dropped connection keeps the page with the banner "The office is offline or
  restarting. What you see may be out of date. Reconnecting…". A single-worker link whose worker leaves
  keeps the last of its work on screen under "<name> has left. This is the last of its work this link
  showed."

## Owner management

The **🔗 Share** window opens from **Settings → Phone & web → Share links** on every Settings surface: the
3D office, the Mac app's companion and the web companion in a browser. In a browser, Phone & web holds only
Share links. Android has no Share UI: guests use the web companion only.

- **What it holds.** The **External sharing** switch with the Funnel state and guest address, a form to
  create a link (label, preset, the floor or worker it needs, expiry), the links with their scope, expiry
  countdown and live guest count, and what guests changed.
- **The link is shown once.** After creation the window shows the full URL with **Copy link** and "Copy it
  now: this link won’t be shown again." The page keeps it in the window only while it shows it, never in
  storage or logs.
- **Limited pages.** A `limited` page hides the create form and shows "Create share links and turn sharing
  on from the office on its own computer. Here you can watch, revoke links and turn sharing off." It can
  watch links and activity, revoke links and turn sharing off.
- **Turning off.** Turning sharing off asks first, then disconnects every guest at once. Links that have
  not expired or been revoked work again when sharing is turned back on.

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

Every guest change the office carries out is appended to `guest-audit.jsonl` (mode 0600; rotated to
`guest-audit.1.jsonl` at 2 MB). Each entry has the link id and label (copied, so it survives revocation),
the preset, the time, the target (floor, worker or Mission Control, with ids and names), an action and
detail text of up to 200 characters. Terminal input is grouped into one entry per worker burst (ended by
5 seconds of quiet, or after 60 seconds) with a short preview. The preview is what the guest typed, so it
can contain secrets they typed; the file is readable only by the owner (mode 0600). The owner pages through
the log newest first.

An entry is written once the office knows the write happened, never before:

- **Forge and pipeline writes** (merge, comment, close, labels, rerun, cancel, run) when the forge answers
  that the change was made.
- **Whiteboard changes** when the batch is committed. A retried batch the board already holds is not
  recorded again.
- **Whiteboard pings** when the line is delivered to the worker.
- **Worktree rebuilds** only when at least one worktree was rebuilt.
- **Uploads** (files into a terminal, pictures onto the Whiteboard) when the upload succeeds.
- **Other writes** when their handler finishes without refusing them.

Refused attempts, and writes the forge or the office turned down, are not logged.

## Known risks

- **A mapping that cannot be removed yet.** Turning sharing off disconnects every guest and closes the
  guest backend at once, then removes the Funnel mapping. When Tailscale does not answer, or the removal
  fails, the mapping stays published and points at a loopback port nothing owns: Funnel answers with a
  gateway error, and a local program that binds that port would be exposed. The Share window stays **Off**
  and says "The public address could not be removed yet. Retrying…" with the command that removes it
  (`tailscale funnel --https=<port> off`). The office retries every 30 seconds while it stays open, until the
  mapping is gone or no longer points at its backend. Turning sharing back on stops the retry. If the office
  quits first, its next start removes the mapping, or prints that command when sharing is locked (see
  [Mapping lifetime](#mapping-lifetime)).
- **The guest port is the office's alone.** Turning sharing off runs `tailscale funnel --yes --https=<port> off`,
  which removes every handler on that port. Do not mount anything else on the guest port.

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
- `tests/guest-funnel.test.ts`: Funnel port planning, ownership, the kill switch and its retried removal,
  leftover mappings after an unclean exit, copied state from another office, the lock, and the Tailscale
  binary pin.
- `tests/guest-http.test.ts`: the guest allowlist, scope per preset, cross-repository workers and
  `?repo=`, card frames, the `full` and `limited` owner API, credential isolation between listeners, the
  menu bar counts, and the Hire dialog's floor file list.
- `tests/office-clone.test.ts`: clones leave out `guest-funnel.json` and keep sharing locked.
- `tests/guest-ws.test.ts`: guests get only their scope on the WebSocket, and only write presets change
  anything.
- `tests/guest-policy.test.ts`: the inbound and outbound policy, identical refusals, worker and floor
  targets, write-only changes, refused Linear tickets, cross-repository workers, scoped welcome, roster and
  Mission Control, removal news, and audit wording.
- `tests/guest-audit-outcome.test.ts`: forge and pipeline writes settle their audit only after the forge
  answers, and only as a success when the change happened.
- `tests/guest-links-model.test.ts`: the Share window's states, the `limited` page, the lock, expiry
  countdowns, the create form and audit paging.
- `tests/settings-nav.test.ts`: a browser's Phone & web holds only Share links, and companions list only
  what they show.
- `tests/dashboard-guest.test.ts`: what each preset shows, hello and close outcomes, status screens, the
  per-tab token, the guest-origin screen, the badge, credential isolation and write-only routes.
- `tests/dashboard-guest-pane.test.ts`: a view-only pane offers no work and a write link keeps it (runs
  when Chromium is installed).
- `tests/no-media.test.ts`: guests add no media, chat or presence.
