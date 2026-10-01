# Headset protocol: what the laptop server offers a standalone headset

**Status:** planned, not implemented. Baseline `28cf00f` on `main`. Line numbers refer to that
commit; when lines move, use the named symbol. **Existing** marks behavior in the checkout.
**Proposed** marks a requirement this plan adds; nothing proposed exists yet.

This is **Track B** of the standalone headset roadmap:

| Track | Plan | Depends on |
| --- | --- | --- |
| A | [Single-owner office](single-owner.md): remove multiplayer | - |
| B | This document: device pairing, negotiated protocol, results, terminal grids, layout contract | A1, A2, A6 |
| C | [Unity headset app](unity-headset.md): the Galaxy XR client | B for everything past its feasibility spike |

## 1. Boundary

The headset is a full game client. The laptop is the office's back office.

| Laptop server owns | Headset owns |
| --- | --- |
| Worker processes, lifecycle, sessions and worktrees | All world geometry, lighting, materials and audio |
| PTYs, terminal state, scrollback and search | Worker characters as a visualization of `WorkerInfo` |
| Forge and Jira boards, comments, merges and labels | The player rig, locomotion, collision and physics |
| The task queue and its scheduler | Interaction recognition: grabs, pokes, climbs, throws, strikes |
| Projects and floors | Menus, settings presentation and every VR preference |
| Meetings and their worktrees | Haptics, comfort options and diagnostics |
| Owner authentication and paired devices | Local leisure props, music and ambience |
| Usage, plan limits, machine pressure, services, changes | Its own credential storage |

The headset connects directly to the selected laptop's HTTP and WebSocket origin. There is no
WebView, DOM, JavaScript scene bridge or second worker, board or queue implementation in the
headset. The server never streams a scene, a pose or a physics state to it.

## 2. What exists today

### 2.1 Authentication (existing)

Sources: `src/server/auth.ts` (`Auth`, `Session`, `COOKIE_NAME`, `cookieName`, `parseCookies`),
`src/server/server.ts:629–681` (`readGuess`, `signedIn`, `login`, `loginOptions`), `:713–767`
(routes), `:942–991` (upgrade and session handling).

| Operation | Contract |
| --- | --- |
| `GET /api/login` | Public `{accounts:boolean, shared:boolean}`. Track A removes it. |
| `POST /api/login` | `{name?, password}`, body at most 4096 bytes. Success returns `{ok:true}` and `Set-Cookie`. 10 attempts per IP per five minutes; success clears the counter. Asynchronous scrypt. |
| `GET /api/whoami` | Authenticated `{ok:true, me}`; unauthenticated API requests get HTTP 401 JSON. |
| `POST /api/logout` | Clears the cookie. No per-device revocation. |
| `GET /api/health` | Public `{ok:true}`. Not a capability or auth check. |

Session cookie: base name `ao_session`, or `ao_session_<port>` when the Host has an explicit
port. `Max-Age=1209600` (14 days), `Path=/; HttpOnly; SameSite=Lax`, plus `Secure` on TLS or a
trusted `x-forwarded-proto: https`. The value is a signed base64url payload `{exp, n, u?}`
(HMAC-SHA256), not a JWT.

The WebSocket upgrade at `/ws` requires a valid cookie **and** an `Origin` whose host and port
match the request Host (`server.ts:sameOrigin`, 159–166; scheme is not compared). A missing or
malformed Origin fails; the socket gets HTTP 401 and is destroyed. Maximum incoming payload is
2 MiB. The server pings every 20 seconds (`server.ts:2139–2151`), so a client must answer
WebSocket control pings. Revocation closes sockets with code 4001, reason `Signed out`. An open
socket is not re-checked for cookie expiry; a reconnect is.

`POST /api/term/drop` (`server.ts:829–845`) also requires a matching Origin.

### 2.2 Discovery (existing)

Sources: `src/server/discovery.ts:33–116` (`startDiscovery`), `src/server/cli.ts`,
`native/android/.../OfficeDiscovery.java` (`Rules`, `Rules.Catalog`), `OfficeActivity.java`.

```text
service: _droidoffice._tcp.
TXT:     v=1             discovery record version (not the protocol version)
         scheme=http|https
```

The instance is `Droid Office on <laptop> (<port>)`; the SRV host resembles
`<laptop>-office-<port>.local`. TXT carries no secret, path or repository name. The CLI starts
discovery; loopback, disabled, not-yet-listening and non-TCP servers do not advertise. Wildcard
binds advertise LAN interfaces (skipping common VPN, container and virtual interfaces).

The Android client keeps discovery to the picker, rejects callbacks from earlier scans, caps
the catalog at 16 offices, resolves one at a time with a 6-second timeout, shows an empty-list
hint after 8 seconds, validates type, `v`, `scheme`, port and addresses (preferring IPv4), stops
when connected, paused, hidden or destroyed, and runs a 15-second connection watchdog. It
remembers an office only after a successful load and keeps the saved choice on failure. The
parser requires exactly `v=1` and ignores other keys.

### 2.3 TLS (existing)

`--tls-cert`, `--tls-key` and `--self-signed` (`src/server/config.ts`). The generated
certificate and key persist with restricted permissions (2048-bit key, 825-day certificate).
The current Android network policy allows cleartext and trusts system and user CAs; the
WebView cancels certificate errors and never bypasses them. A discovered IP address can fail a
certificate issued for a hostname. Discovery is an unauthenticated advertisement, not proof of
identity.

### 2.4 Why the browser contract is not enough

A native client could POST the password, keep the cookie and open `/ws` with `Cookie` and a
fabricated `Origin`. That works today but is the wrong long-term contract: it stores a
password-equivalent session, imitates a browser to pass a browser protection, inherits every
owner power, and gets a browser-shaped bootstrap full of state the headset ignores. The Unity
feasibility spike may use it once to measure networking; nothing shipped uses it.

## 3. Proposed: server identity

- `config.json` gains `serverId`: a random UUID created once and never rotated (rotation would
  orphan every paired device). It is not secret.
- Discovery TXT adds `id=<serverId>` and `pair=1` when device pairing is available. `v=1` stays,
  so the existing Android parser keeps working.
- `welcome` carries `serverId`. A headset that reaches a saved origin and finds a different
  `serverId` treats it as a different office and does not send its token.

## 4. Proposed: device pairing and device tokens

### 4.1 Requirements

1. Pairing is opened deliberately by the signed-in owner on the laptop. It is never open by
   default.
2. Pairing runs over HTTPS. An office serving HTTP refuses to pair and says how to start with
   `--self-signed`. (Decision B-D1 below.)
3. The headset verifies the server's certificate either through platform trust or by pinning
   the certificate fingerprint learned during pairing. It never accepts an unverified
   certificate silently.
4. A device gets a revocable token with fewer powers than the owner's browser session.
5. Tokens never appear in URLs, TXT records, logs, crash reports, screenshots or the WebSocket
   subprotocol.
6. Cookie authentication and its Origin check are unchanged for browsers.

### 4.2 Flow A: QR code (preferred if the headset can read it)

1. Owner opens **Settings → Devices → Pair a headset** on the laptop page. The server creates a
   pairing record `{id, secret, expiresAt: now + 5 min, used: false}`; `secret` is 32 random
   bytes.
2. The page shows a QR code for
   `droidoffice://pair?v=1&origin=<https origin>&id=<serverId>&p=<pairing id>&s=<secret>&fp=<sha256 of the certificate's SubjectPublicKeyInfo, base64url>`.
3. The headset reads it (Android XR Extensions for Unity include QR code tracking; the Unity
   spike confirms it works on Galaxy XR and which permission it needs).
4. The headset connects to `origin`, checks that the presented certificate's SPKI hash equals
   `fp` (or that platform trust validates it), then calls `POST /api/device/pair` with
   `{pairing, secret, name, model, app, version}`.
5. The server checks the record is unexpired and unused, marks it used, creates the device and
   returns `{device: {id, name}, token, serverId}` once.

### 4.3 Flow B: compare a code (no camera needed)

1. Headset lists nearby offices from discovery. The owner picks one.
2. Headset calls `POST /api/device/pair/request` with `{name, model, app, version, nonce}`
   (`nonce`: 16 random bytes). This works only while the owner has **Pair a headset** open;
   otherwise HTTP 409 `pairing-closed`.
3. Server replies `{request, serverNonce}` and shows the request on the laptop page.
4. Both sides display a six-digit code: the first 20 bits of
   `SHA-256(spki || nonce || serverNonce)` as decimal. The headset computes `spki` from the
   certificate it actually received, so a machine in the middle produces a different code.
5. The owner checks the codes match and presses **Allow** on the laptop. The headset polls
   `POST /api/device/pair/poll {request}` (every second, for at most two minutes) and then
   receives `{device, token, serverId, fp}` once. **Deny** or expiry ends the request.

Both flows are rate limited like login (10 attempts per IP per five minutes) and close the
pairing window after one success.

### 4.4 Tokens and the device store

- The token is 32 random bytes, base64url, prefixed `dod1_` so secret scanners recognise it.
- The server stores only `SHA-256(token)` in `.droid-office/devices.json` (mode `0600`):
  `{id, name, model, createdAt, lastSeenAt, lastAddress, tokenDigest, fingerprintAtPairing}`.
- The token stays valid until revoked, or until 90 days pass with no use. (Decision B-D2:
  rotation. A single-owner LAN office does not need access/refresh rotation in v1; revocation
  covers a lost headset.)
- **Settings → Devices** lists devices with last use and a **Revoke** button. Revoking closes
  that device's sockets with 4001 and rejects its HTTP requests at once.
- Changing the owner password does not revoke devices; the Devices list says so, and offers
  **Revoke all**.
- The headset keeps the token encrypted with an Android Keystore key, alongside the origin,
  `serverId` and pinned fingerprint. It never stores the office password.

### 4.5 Using a token

- HTTP: `Authorization: Bearer dod1_…` on every `/api/*` request.
- WebSocket: the same header on the `/ws` upgrade. No Origin is required for a bearer request;
  one that carries cookies as well is rejected, so a request is authenticated in exactly one
  way.
- The server never enables CORS. Bearer support does not make any route callable from another
  web origin, because browsers never attach this header on their own.
- Routes that check Origin for cookie sessions (`/ws`, `/api/term/drop`, hot reload writes,
  owner mutations) accept a valid bearer token instead of the Origin check.

### 4.6 What a device may not do

A device token is the owner on a headset, minus actions that would let a stolen headset lock
the owner out or exfiltrate secrets:

| Denied to device tokens | Reason |
| --- | --- |
| Pairing, listing or revoking devices | Account takeover |
| Password reset or change | Account takeover |
| `upgrade.start`, hot reload | Replaces the running server |
| `notify.webhook`, `jira.connect` | Entering or replacing stored secrets |
| `floor.projectsDir` | Points the office at other directories |

Everything else the headset needs (workers, terminals, boards, queue, floors, meetings,
changes) is allowed. The server returns `result` code `forbidden` (section 6) for a denied
message.

## 5. Proposed: protocol negotiation and the headset profile

### 5.1 Hello

The headset opens `/ws?client=headset&proto=2`. Browsers send nothing and keep protocol 1.

- `proto` is the office WebSocket protocol version, separate from discovery `v`, the software
  `welcome.version` and the old native scene `WIRE_VERSION`.
- The server answers with `welcome` containing `proto: 2` and `capabilities: string[]`.
- An unsupported `proto` gets one message `{t:'error', code:'proto', supported:[1,2]}` and a
  close with code 4400.
- Capabilities in protocol 2: `result`, `grid`, `layout`, `devices`. A later
  `meeting.say` capability is added by section 9. A client never sends a message whose
  capability is missing.

### 5.2 The headset profile

With `client=headset` the server sends only office data. Track A has already removed people,
voice, chat, accounts and teams. The profile also omits leisure and environment state the
headset owns:

- `welcome` and `floor.enter` omit `decor`, `jukebox`, `cabinet`, `ball` and `theme`.
- The server does not send `decor`, `jukebox`, `cabinet`, `ball`, `theme`, `golf` or `horn` to a
  headset connection.
- `sky` stays: the laptop already fetches the weather and the headset uses it for the windows.
- The server ignores leisure messages from a headset connection.

```ts
// Proposed. The headset welcome.
type HeadsetWelcome = {
  t: 'welcome';
  proto: 2;
  capabilities: string[];
  serverId: string;
  connection: string;          // transport ID (Track A)
  arrival: Arrival;            // Track A
  layout: { version: number; hash: string };
  version: string;             // server software version
  floors: FloorInfo[];
  projectsDir: ProjectsDirState;
  upgrade: UpgradeState;
  usage: UsageState;
  limits: PlanLimits;
  notify: NotifyState;
  machine: MachineState;
  proxy: ProxyState;
  sky: SkyState;
  leaveOnMerge: LeaveOnMergeState;
  prompts: PromptsState;
  epoch: number;               // section 6.3
  floor: string | null;
  project: ProjectInfo | null;
  workers: WorkerInfo[];
  issues: GhState<GhIssue>;
  pulls: GhState<GhPull>;
  queue: QueueState;
  services: ServicesState;
  meeting: MeetingState;
  jira: JiraFloorState;
  jiraBoard: JiraBoardState | null;
};
```

### 5.3 Ordering rules (existing behavior, now written down)

1. `welcome` replaces all building and floor state from any previous connection.
2. `floor.enter` replaces all current-floor state and clears the screen map. Nothing from the
   old floor is merged in.
3. Full `screen` frames follow either snapshot (`server.ts:583–585, 1050–1074, 1130–1139`).
   A worker without a terminal has no screen yet.
4. `worker.update` replaces the whole `WorkerInfo`. `worker.remove` removes the worker, its
   screen, its terminal view and its subscriptions.
5. `gh.issues`, `gh.pulls`, `queue`, `meeting`, `jira.board` and the other state messages
   replace their state. `screen` (row deltas) is the exception.
6. Leaving a floor detaches its terminals and changes watchers (`server.ts:1185–1205`).
7. After a reconnect the client applies the fresh `welcome` and then re-attaches surviving
   terminals and watchers. It never replays an uncertain hire, prompt, merge, discard or
   meeting start.
8. Arriving on a floor calls `workers.wakeAll()` (`server.ts:1077–1080, 1137–1138`), so arrival
   alone can resume workers.

### 5.4 C# types are generated

`tools/headset/protocol-cs.ts` (proposed) reads `src/shared/protocol.ts` with the TypeScript
compiler API and writes `native/unity/Assets/DroidOffice/Protocol/Generated/Protocol.g.cs`:
DTO classes for the messages in section 7 and the types they reference, the `t` discriminator
table, and string enums. Optional fields stay nullable, explicit `null` stays distinct, and
millisecond timestamps stay `long`. `tests/headset-protocol-cs.test.ts` fails when the checked-in
file differs from the generator's output, so a protocol change that forgets the headset fails CI.

## 6. Proposed: results, idempotency and floor epochs

### 6.1 Results

Today most operations answer with a `toast`, and forge replies (`gh.merged` and others) are
correlated only by kind and number. A headset that animates a card into a worker's hands needs
to know whether that worked.

- Any client message may carry `rid: string` (at most 64 characters).
- For a message with `rid`, the server sends exactly one
  `{t:'result', rid, ok: boolean, code?: ResultCode, error?: string, epoch: number, ...data}`.
- `ResultCode` is `'invalid' | 'forbidden' | 'busy' | 'not-found' | 'conflict' | 'limit' | 'offline' | 'failed'`.
- `data` carries the useful identifiers: `workerId` for `worker.spawn`, `taskId` for
  `queue.add`, `floor` for `floor.go`, `meetingId` for `meeting.start`, `number` and `url` for
  `worker.pr` and `changes.pr`.
- The result comes after any state message the operation caused (for example the
  `worker.update` of a new hire), so the client's state is current when the result arrives.
- Toasts still go to browsers. A headset connection does not get the toasts that duplicate a
  result; it still gets unrelated toasts (worker warnings, server notices).

Operations that return a result: `worker.spawn`, `worker.resume`, `worker.kill`,
`worker.rebuild`, `worker.prompt`, `worker.pr`, `worker.shoot`, `worker.revive`,
`station.prompt`, all `queue.*`, `floor.go`, `floor.add`, `gh.merge`, `gh.comment`, `gh.close`,
`gh.labels`, `meeting.start`, `meeting.stop`, `meeting.clear`, `changes.commit`,
`changes.discard`, `changes.pr`.

### 6.2 Idempotency

The server keeps the last 256 results per device (or per browser session) for 10 minutes. A
repeated `rid` returns the stored result and does not run the operation again. A headset that
lost its connection during a hire can therefore resend the same `rid` after reconnecting and
get the original outcome instead of hiring twice. Rids are random 128-bit values.

### 6.3 Floor epochs

- Each connection has an `epoch` that increases on every `floor.enter` and is sent in it and in
  `welcome`.
- Results carry the epoch of the floor the operation ran on.
- Other floor-scoped messages rely on the existing guarantee that one socket delivers in order
  and that `toFloor` sends only to connections on that floor. The client drops any result whose
  epoch is older than its current one, after updating that operation's pending state.

## 7. Messages the headset uses

All payloads are shown after `t`. `?` means the field may be omitted; `null` is written out.
Unchanged messages keep their current payloads. Track A changes are already applied. Fields and
messages this plan adds are marked **proposed**; every message may also carry `rid` (section 6).

### 7.1 Workers

| Client `t` | Payload | Notes |
| --- | --- | --- |
| `worker.spawn` | `deskId; prompt?; worktree?; kind?; provider?; model?; effort?; issue?; repos?; target?` | `deskId` must be a valid seat. `repos` names up to 8 other floors. Prompts at most 20,000 characters. Omit provider to use the office default; never send empty model or effort strings. |
| `worker.resume` | `workerId` | Wakes a session; not a hire. |
| `worker.kill` | `workerId; cleanup?: 'keep' \| 'worktree' \| 'all'` | Ask `worker.worktree` first before offering destructive cleanup. |
| `worker.worktree` | `workerId` | Server replies `worker.worktree {workerId, state}`. |
| `worker.rebuild` | `workerId; all?` | Rebuild a lost worktree; `all` rebuilds every lost worker on the floor. |
| `worker.attach` | `workerId; format?: 'raw' \| 'grid'` | Subscribe this connection. `format` is **proposed** (section 8); the default stays `raw`. |
| `worker.detach` | `workerId` | Unsubscribe this connection only. |
| `worker.prompt` | `workerId; prompt; issue?` | A numeric `issue` also claims the forge issue and removes its queued copy. |
| `station.prompt` | `deskId; prompt; provider?; model?; effort?` | Ask a kiosk agent; wakes or hires it. |
| `worker.pr` | `workerId` | Push the branch and open or find its PR. Consequential. |
| `worker.shoot` | `workerId` | Starts the persisted 30-second revival window. |
| `worker.revive` | `workerId` | Cancels it while open. |

| Server `t` | Payload |
| --- | --- |
| `worker.update` | `worker: WorkerInfo` (full replacement) |
| `worker.remove` | `workerId` |
| `worker.worktree` | `workerId; state: WorktreeState` |

`WorkerInfo` after Track A (`protocol.ts:82–157`):

```ts
interface WorkerInfo {
  id: string; kind: 'agent' | 'shell'; provider?: AgentProvider;
  model?: string; effort?: AgentEffort; activeModel?: string; activeEffort?: AgentEffort;
  deskId: string; name: string; color: string; status: WorkerStatus; downedUntil?: number;
  acked: boolean; waitingSince?: number; createdBy: string; createdAt: number; prompt?: string;
  worktree?: { path: string; branch: string; base: string; from?: string; made?: string };
  lost?: { branch: 'here' | 'origin' | 'gone' }; repos?: WorkerRepo[];
  pr?: { number: number; url: string }; prOpening?: boolean; title?: string;
  sessionId?: string; exitCode?: number; cols: number; rows: number;
  open: boolean; lastInputAt?: number;
  activity?: string; action?: 'read' | 'edit' | 'test' | 'web' | 'failing';
  task?: { name: string; summary: string }; usage?: Usage; meeting?: string;
  workedMs?: number; workingSince?: number;
}
type WorkerStatus = 'starting' | 'idle' | 'working' | 'needs_input' | 'done' | 'exited' | 'offline';
type AgentProvider = 'claude' | 'opencode' | 'codex' | 'droid' | 'grok' | 'muse' | 'custom';
type AgentEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
```

Interpretation the headset must keep:

- `deskId` places a worker; the server sends no worker transforms.
- `activeModel` and `activeEffort` win over requested values for display.
- `acked: false` with `done` or `needs_input` means attention is due; `waitingSince` orders the
  next-waiting list.
- `downedUntil` is the server's deadline; a local animation never restarts or ends it.
- Paths in `worktree`, `repos` and drop replies are laptop paths.
- Port the predicates in `src/shared/status.ts` (asleep, busy, lost, downed are different),
  not just the colors.

Provider rules (`src/server/agents.ts`, `WorkerManager.spawn:431–520`): honor
`ProjectInfo.agentProviders`; `custom` only when the configured command is custom; explicit
models for Claude, OpenCode, Droid, Grok and Muse; effort for Claude, Droid, Grok and Muse.
Claude models are `fable | opus | sonnet | haiku`; OpenCode is `provider/model` up to 256
characters; Droid up to 256; Grok up to 64; Muse up to 128. Model catalogs:
`GET /api/agents/opencode/models` and `/api/agents/grok/models` return `{models: string[]}`;
`/api/agents/droid/models` returns `{models: DroidModelOption[], defaultModel?, defaultReasoningEffort?}`.
Catalogs are cached for 60 seconds. There is no Muse catalog endpoint.

Valid seats are the 16 desks, 12 overflow beanbags, 3 kiosks and 5 meeting seats in
`src/shared/layout.ts`. Meeting seats belong to meetings; kiosk agents need a task; shells
cannot sit at kiosks.

### 7.2 Terminals

| Client `t` | Payload | Notes |
| --- | --- | --- |
| `term.input` | `workerId; data` | Attached only. Truncated to 65,536 UTF-16 code units. Not a prompt API. |
| `term.resize` | `workerId; cols; rows` | Attached only. Clamped to 20–400 columns and 5–200 rows. Resizes the real PTY. |
| `term.history` | `workerId; before; count` | Proposed, grid only (section 8). |
| `term.resync` | `workerId` | Proposed, grid only. |

| Server `t` | Payload | Notes |
| --- | --- | --- |
| `screen` | `workerId; cols; rows; lines: Record<number, Run[]>; full; cursor: [x, y]` | Overview frames at up to 4 Hz with an 8-second keyframe. `full` resets the grid; an omitted row is unchanged; an empty row clears it. Droppable when a connection queues over 4 MiB. Cursor-only moves send nothing. |
| `term.snapshot` | `workerId; data; cols; rows` | Raw format: full serialized VT state. Reset the emulator, then feed it. |
| `term.data` | `workerId; data` | Raw format: ordered PTY output. Chunks can split escape sequences. A connection with more than 8 MiB queued goes stale; it gets a fresh snapshot once its backlog is at most 1 MiB. |
| `grid.snapshot`, `grid.delta`, `grid.history` | Section 8 | Proposed. |

`Run = [text, fg, bg, flags]`. Colors: `-1` default, `0..255` the ANSI palette, values with
`0x1000000` set are 24-bit RGB. Flags: `1` bold, `2` inverse, `4` dim.

The terminal theme the headset matches (`world/laptop.ts:14–34`): background `#0a0a0a`,
foreground `#eeeeee`, cursor `#ee6018`, selection `#2a2a2a`; ANSI 0–7 `#282a36 #ff5c7a
#7cf29a #ffd166 #6cb6ff #d69cff #72ddf7 #e6e6f0`; ANSI 8–15 `#6c7086 #ff8fa3 #a6f4b8 #ffe29a
#9ccfff #e5c1ff #a5ecfb #ffffff`; 16–231 the six-level cube `[0, 95, 135, 175, 215, 255]`;
232–255 grey `8 + 10 × i`. Enter and modified-Enter follow `src/client/term-keys.ts`.

Size ownership: a terminal resizes only when the owner types into it on that device, never
when it merely opens or shows as an overview.

### 7.3 Boards

| Client `t` | Payload |
| --- | --- |
| `gh.refresh` | none |
| `gh.merge` | `number; method: 'squash' \| 'merge' \| 'rebase'; deleteBranch; auto?` |
| `gh.comment` | `kind: 'issue' \| 'pull'; number; body` (at most 65,536 characters) |
| `gh.close` | `kind; number; comment?; reason?: 'completed' \| 'not planned'; deleteBranch?` |
| `gh.labels` | `kind; number; add: string[]; remove: string[]` (names at most 255, lists at most 100) |
| `jira.refresh` | none |

| Server `t` | Payload |
| --- | --- |
| `gh.issues`, `gh.pulls` | `state: GhState<GhIssue>` / `GhState<GhPull>` |
| `gh.merged` | `number; error?` |
| `gh.commented` | `kind; number; comment?; error?` |
| `gh.closed`, `gh.labeled` | `kind; number; error?` (`labels?` for labeled) |
| `jira`, `jira.board` | `state` |

Details are HTTP: `GET /api/gh/issue?floor=F&number=N` (`GhIssueDetail`),
`/api/gh/pull?floor=F&number=N` (`GhPullDetail` with checks, reviews, review comments and
allowed merge methods), `/api/gh/pull/diff?floor=F&number=N` (plain text), `/api/gh/labels?floor=F`,
`/api/jira/ticket?floor=F&key=K`. `gh.*` covers GitHub and GitLab.

**Handing an issue card to a worker** is not a separate message. The existing desktop flow
(`main.ts:dropCard`, 4150–4186) sends one of:

```ts
{ t: 'worker.prompt', workerId, prompt: issuePrompt(issue), issue: issue.number }
{ t: 'worker.spawn', deskId, prompt: issuePrompt(issue), worktree, provider, model?, effort?, issue: issue.number }
{ t: 'queue.add', prompt: issuePrompt(issue), title: `#${n} ${title}`, issue: issue.number, provider?, model?, effort? }
```

`issuePrompt` (`ui/boards.ts`) renders the office's `issue.work` prompt with `issueVars`. The
template is `PromptsState.custom['issue.work']` when the owner customized it, otherwise the
default in `src/shared/prompts.ts` (`PROMPTS`). The C# generator (section 5.4) also emits the
default templates and the variable substitution, and a shared fixture test checks that the
headset and `ui/prompts.ts:officePrompt` render the same text. A card dropped on a meeting-room seat
opens a meeting preset from `issue.meeting`. A worker refuses a card when it is downed, a shell,
lost, asleep or waiting for an answer (`main.ts:cantTakeCard`, 4199–4206). Jira tickets use
`ticketPrompt` and never put a Jira key in the numeric `issue` field; no Jira write exists.

### 7.4 Queue

| Client `t` | Payload |
| --- | --- |
| `queue.add` | `prompt; title?; issue?; provider?; model?; effort?` |
| `queue.remove` | `taskId` (queued or finished only) |
| `queue.move` | `taskId; delta` (negative moves up one, otherwise down one) |
| `queue.retry` | `taskId` |
| `queue.clear` | none (finished tasks only) |
| `queue.limit` | `maxWorkers` (0 pauses) |
| Server `queue` | `state: QueueState` |

Default limit 3, range 0–28 (`SEATS.length`), at most 100 unfinished tasks, a 10-second
fallback pump, titles capped at 120 characters, duplicate unfinished issues rejected. The
headset never schedules work itself.

### 7.5 Floors

| Client `t` | Payload |
| --- | --- |
| `floor.go` | `floor; at?: {x, y, z, rotY}` |
| `floor.repos` | `refresh?` |
| `floor.add` | `dir` (an existing checkout) |
| `floor.remove` | `floor` |

| Server `t` | Payload |
| --- | --- |
| `floors` | `floors: FloorInfo[]` |
| `floor.enter` | `arrival; epoch` plus the floor view |
| `floor.repos` | `repos: RepoChoice[]; error?` |
| `floor.added` | `dir; floor?; error?` |

At most 16 floors. `ROOF` is the rooftop; `floor: null` is the empty-building lobby. The
headset switches its data binding when `floor.enter` arrives, never when its elevator
animation starts. `at` uses the browser world's coordinates (section 10.3).

### 7.6 Meetings

| Client `t` | Payload |
| --- | --- |
| `meeting.start` | `MeetingRequest {pattern; prompt; title?; output?; roles; parts?; pr?; issue?; rounds?; budget?; provider?; model?; effort?}` |
| `meeting.stop` | none |
| `meeting.clear` | none |
| `meeting.say` | Proposed, section 9 |
| Server `meeting` | `state: MeetingState` |

| Pattern | Seats min/max/default | Rounds min/max/default | Extra |
| --- | --- | --- | --- |
| `debate` | 2/5/3 | 2/4/3 | Default output `docs/decisions/<slug>.md` |
| `lead` | 2/5/3 | 3/3/3 | Plan, work, merge |
| `mapreduce` | 2/5/3 | 2/2/2 | Needs `parts` |
| `redblue` | 2/2/2 | 1/5/3 | Can finish early |
| `review` | 2/5/3 | 2/2/2 | Needs `pr`; output `reviews/pr-N.md` |

Budget defaults to 1,000,000 tokens per seat, at most 50,000,000. Output is a safe relative
path of at most 200 characters.

### 7.7 Changes, services, usage and the rest

The headset uses `changes.watch`, `changes.unwatch`, `changes.diff`, `changes.commit`,
`changes.discard` (no `path` discards everything, so it always needs a confirmation),
`changes.pr`, `limits.refresh`, `proxy.refresh` and `ping {at}`. It reads `changes`,
`changes.diff`, `services`, `usage`, `limits`, `machine`, `proxy`, `notify`, `prompts`,
`leaveOnMerge`, `upgrade`, `sky`, `gong {why: 'hit' | 'merged' | 'queue'}` and
`pong {at, now}`. It may send `leaveOnMerge.set`, `queue.limit`, `prompts.agent` and
`machine.limit`. Missing or unknown cost is never shown as zero.

HTTP tools: `POST /api/term/drop?floor=F&worker=W&name=N` (raw body up to 25 MiB; replies
`{path}`, a laptop path the headset pastes escaped with `droppedPaths`, never runs);
`GET /api/changes/file?floor=F&worker=W&path=P&side=old|new&repo=R`; `GET /api/docs?floor=F`,
`/api/docs/file`, `/api/docs/picture`; `GET /api/search?floor=F&q=Q` (terminal hits after
Track A). Worker web services have no in-headset browser; the headset shows the URL and a QR
code, or opens Android's browser on request.

### 7.8 Not used by the headset

`decor.*`, `jukebox.*`, `cabinet.*`, `ball.*`, `theme.set`, `golf`, `horn`, `gong` (sent;
the headset plays the strike locally), `upgrade.*`, `prompts.set`, `notify.*`, `jira.connect`,
`jira.disconnect`, `jira.epic`, `floor.projectsDir`. Office policy stays on the laptop page in
v1.

## 8. Proposed: terminal grids

### 8.1 Why

The overview `screen` feed is lossy by design: no cell widths, no wrap flags, no alternate
screen identity, no cursor visibility or style, no scrollback, no input modes, and cursor-only
moves are dropped. The raw stream needs a full VT emulator in C#. The server already keeps an
authoritative headless xterm mirror for every worker in `workers.ts` (line 1923), so it can
send the headset the cells it has already computed.

The grid is produced in `workers.ts`, which runs in the server process, not in the detached PTY
host. **It needs no `PTY_PROTOCOL` bump.** If an implementation ever touches `screen.ts`,
`ptyhost.ts` or what the host imports from `ptys.ts`, it must bump `PTY_PROTOCOL` as
`src/server/AGENTS.md` requires, and plan for the restart that ends running terminals.

### 8.2 Messages

```ts
// Proposed.
type GridRun = [text: string, fg: number, bg: number, flags: number, width: 1 | 2];
interface GridRow { runs: GridRun[]; wrapped?: boolean }       // wrapped: continues on the next row
interface GridCursor { x: number; y: number; visible: boolean; style: 'block' | 'bar' | 'underline'; blink: boolean }
interface GridModes {
  alt: boolean;                     // alternate screen active
  bracketedPaste: boolean;
  appCursor: boolean;               // DECCKM
  appKeypad: boolean;
  mouse: 'none' | 'x10' | 'vt200' | 'drag' | 'any';
  mouseEncoding: 'default' | 'utf8' | 'sgr' | 'urxvt' | 'sgr-pixels';
}

// server → headset
{ t: 'grid.snapshot', workerId, gen, rev, cols, rows, lines: GridRow[], cursor, modes, history: number, title?: string }
{ t: 'grid.delta',    workerId, gen, rev, base, lines?: Record<number, GridRow>, cursor?, modes?, scrolled?: number, title?: string }
{ t: 'grid.history',  workerId, gen, from, lines: GridRow[] }
```

- `gen` changes whenever the terminal is replaced (a new session, a rebuild, a server restart).
  A different `gen` discards everything held for that worker.
- `rev` increases by one per delta. A delta applies only when `base` equals the held `rev`;
  otherwise the client sends `term.resync` and waits for a snapshot.
- `flags` extends the overview flags: `1` bold, `2` inverse, `4` dim, `8` italic, `16`
  underline, `32` strikethrough, `64` invisible, `128` blink.
- A run contains graphemes of one `width`; a wide grapheme occupies two columns. Zero-width
  continuation cells are not sent.
- `scrolled: n` means the visible rows moved up by `n` before `lines` applies, so a scrolling
  log costs one row per new line instead of a full screen.
- `history` is the number of scrollback rows available above the screen (at most 3,000, the
  mirror's `SCROLLBACK`). `term.history {workerId, before, count}` fetches up to 200 rows ending
  just above row `before` (0 is the first visible row; negative numbers count into history).

### 8.3 Rates and backpressure

- A focused grid (the terminal the owner is reading or typing in) coalesces changes for at most
  33 ms (up to 30 deltas a second).
- Overview monitors keep the existing 4 Hz `screen` feed; the headset does not subscribe to a
  grid for them.
- Above 1 MiB queued for one grid subscription the server stops sending deltas, and sends a
  fresh `grid.snapshot` when the backlog falls below 256 KiB.
- Raw and grid subscriptions are independent; browsers keep the raw stream.

### 8.4 Acceptance

Tests run each fixture through the server's headless terminal and compare the grid the client
reconstructs from snapshot plus deltas with the server's own buffer, cell by cell:
CJK and emoji widths, combining marks, alternate screen enter and exit (vim, less, htop),
bracketed paste toggles, mouse mode toggles, cursor hide and show, scroll regions, resize,
3,000-line history paging, the powerline glyphs the bundled symbols font covers, and a delta
gap forcing a resync.

## 9. Proposed: the owner speaks at a meeting

Today a meeting is the owner calling agents together to run a pattern (`src/shared/meetings.ts`,
`src/server/meetings.ts`). Agents take turns; the owner can watch the board and open any
seated agent's terminal. There is no human turn, no `meeting.say` and no transcript.

The product goal is meetings between the owner and agents. Two steps:

1. **v1 (no server change).** The owner sits at the head of the table. The table console shows
   the pattern, round and each seat's state. Touching a seat's place card opens that agent's
   terminal at the table so the owner can answer or redirect it. This uses only existing
   messages.
2. **Capability `meeting.say` (after a design pass on `src/server/meetings.ts`).**
   `meeting.say {text}` (at most 4,000 characters) appends an owner line to the meeting's
   notes and delivers it to every seated agent at its next turn boundary, or at once to an
   agent that is idle between turns. `Meeting.transcript?: {who: 'owner' | number, text, at}[]`
   records owner lines and each seat's turn summaries. Requirements: an owner line never
   interrupts an agent mid-tool-call; a stopped or finished meeting rejects it with
   `conflict`; the line is included in the meeting record. The design pass decides whether an
   owner line can also end a round early.

## 10. Proposed: the layout contract

### 10.1 One source

The headset bundles its world. Seat, desk, kiosk and meeting IDs and positions must match what
the server validates, and both come from `src/shared/layout.ts`.

- `tools/headset/export-layout.ts` (proposed) imports `layout.ts` through `tsx` and writes
  `native/unity/Assets/DroidOffice/Layout/office-layout.json`: every exported constant the
  world needs (floor bounds, wall height, storey, slab, desks, beanbags, stations, meeting seats
  and table and board, boards, TV, machine monitor, jukebox, cabinet, bookshelf, gong, plants,
  balcony, exit stairs, stage, roof bar, fire pit, elevator, ladder, poles, seating), in the
  office's own coordinates and units (metres, +Y up).
- `tests/headset-layout.test.ts` fails when the checked-in JSON differs from the exporter's
  output.

### 10.2 Version and hash

- `layout.version` is an integer bumped by hand when seat IDs or their meaning change.
- `layout.hash` is SHA-256 over the sorted seat IDs with their positions and kinds.
- `welcome.layout` carries both. A headset whose bundled hash differs keeps working but stops
  offering hires at seats it does not know, and says on the Home panel that the app and the
  office are different versions.
- `GET /api/headset/layout` returns the same JSON the exporter writes, so a mismatch can be
  diagnosed from the headset.

### 10.3 Coordinates

The office world uses three.js conventions: right-handed, metres, +Y up, the floor at y = 0.
Unity is left-handed. One conversion function in the headset turns office positions and yaw
into Unity transforms, and the same function turns them back for `floor.go.at`. A golden test
places a desk, its laptop, a board and the elevator and checks they face the way they do in
the browser. The glTF importer chooses its own axis flip; the exporter's conversion must match
it, verified by importing `macbook-base.glb` onto a desk anchor.

## 11. Security checklist

- Bearer tokens over HTTPS only; HTTP offices refuse pairing.
- Constant-time digest comparison; tokens hashed at rest; `devices.json` mode `0600`.
- Cookie and bearer authentication never combine on one request.
- No CORS headers; Origin checks stay for cookies.
- Pairing is owner-initiated, short-lived, single-use and rate limited.
- Device tokens cannot manage devices, passwords, upgrades, hot reload, webhooks, Jira
  credentials or the projects directory.
- Revocation closes live sockets at once.
- Tokens are absent from logs (server and headset), crash reports, screenshots and URLs.
- `.env.example` and `HELP` document any new option in the same change.

## 12. Tests

| Test | Covers |
| --- | --- |
| `tests/devices.test.ts` | Store, digests, expiry, revocation, file mode |
| `tests/device-pairing.test.ts` | Both flows: closed window, expiry, single use, rate limit, code derivation, deny |
| `tests/device-auth-http.test.ts` | Bearer on every route, cookie plus bearer rejected, no CORS, forbidden actions |
| `tests/device-auth-ws.test.ts` | Bearer upgrade without Origin, revocation closes the socket with 4001, `serverId` mismatch |
| `tests/headset-welcome.test.ts` | `proto=2` hello, capabilities, omitted leisure fields, 4400 on an unknown proto |
| `tests/results.test.ts` | One result per rid, ordering after state messages, idempotent replay, epochs |
| `tests/terminal-grid.test.ts` | Section 8.4 fixtures, rates, backpressure and resync |
| `tests/headset-layout.test.ts` | Checked-in layout JSON is current; hash stability |
| `tests/headset-protocol-cs.test.ts` | Checked-in C# types are current |
| `tests/discovery.test.ts` | TXT `id` and `pair`; `v=1` unchanged |

Browser behavior keeps its existing tests. The coverage thresholds in `package.json` stay.

## 13. Commit plan

Each commit is green on its own and updates server, client and docs together.

| Commit | Contents | Depends on |
| --- | --- | --- |
| **B1** `feat: give each office a stable server ID` | `serverId` in config and `welcome`; TXT `id` and `pair`; discovery tests | - |
| **B2** `feat: pair headsets and accept device tokens` | `src/server/devices.ts`, pairing routes, bearer on HTTP and `/ws`, Settings → Devices, revocation, forbidden actions, tests, guide section | A6 |
| **B3** `feat: negotiate the headset protocol` | `client=headset&proto=2`, capabilities, headset profile, error close, C# type generator and test | A1, A2, B1 |
| **B4** `feat: answer operations with results` | `rid`, `result`, idempotency cache, epochs, headset toast filtering | B3 |
| **B5** `feat: stream terminal grids` | `format: 'grid'`, snapshot, delta, history, resync, rates, tests | B3 |
| **B6** `feat: publish the office layout contract` | Exporter, JSON, hash in `welcome`, `/api/headset/layout`, tests | B3 |
| **B7** `feat: let the owner speak at meetings` | Section 9 step 2 after its design pass | B4 |

## 14. Decisions

| # | Question | Recommendation |
| --- | --- | --- |
| B-D1 | Require HTTPS for pairing, or allow HTTP with a warning | Require HTTPS. `--self-signed` already exists; the fingerprint pin makes it safe. |
| B-D2 | Token rotation | Long-lived revocable token in v1; add rotation only if a threat needs it. |
| B-D3 | Where pairing is approved | The laptop page (Settings → Devices). A CLI approval path is optional later. |
| B-D4 | QR or code comparison first | Build code comparison first (works everywhere); add QR when the spike confirms QR tracking on Galaxy XR. |
| B-D5 | Grid as the only headset terminal format | Yes, with the raw stream kept for browsers. Revisit only if grid fidelity tests fail. |
| B-D6 | Office policy settings in the headset | Laptop only in v1, except queue limit, default engine at a desk, leave-on-merge and machine limit. |
