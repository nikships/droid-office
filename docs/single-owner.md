# Single-owner office: removing multiplayer

**Status:** planned, not implemented. Baseline `28cf00f` on `main`. Line numbers below refer to
that commit; when lines move, use the named symbol.

Related plans: [headset protocol](headset-protocol.md) (the server contract a standalone headset
uses) and [Unity headset app](unity-headset.md) (the headset client itself). This plan is
**Track A** of that roadmap and lands first, because the headset protocol depends on its
arrival and terminal-subscription changes.

## 1. Goal

Droid Office becomes an office with exactly one human: its owner. The owner hires agents,
reads and types into their terminals, works the boards and queue, travels between floors and
calls meetings with agents. Nobody else walks the office, talks, chats, watches terminals or
holds an account in it.

The client/server split stays. A Node server on the owner's laptop still owns workers, PTYs,
boards, the queue, floors and meetings; the desktop browser, WebXR and the headset are views
of it. "Remove multiplayer" means removing collaboration **between people**, not between the
owner and agents and not between client and server.

### 1.1 What goes, what changes, what stays

| Class | Meaning | Contents |
| --- | --- | --- |
| **a. Delete** | The feature and every producer and consumer go | Remote human avatars and presence, movement/action/emote relays, voice, WebRTC signalling, screen sharing, chat and chat history, teammate typing and viewer faces, office passwords, sessions, login pages and the claim flow, office accounts, roles and invites, SSH teammate provisioning, people menus and counts, spectator modes, multiplayer marketing copy |
| **b. Rewrite** | The feature stays; its multiplayer coupling goes | Connection state, welcome and arrival, floor routing and activity, terminal subscriptions and the "terminal open" signal, local held objects, game ownership, LAN access (QR token), search, settings, previews, tests and docs |
| **c. Keep** | Unchanged in behavior | One local player and avatar, workers and desks, PTYs and recovery, forge and Jira boards, the queue, floors, elevator, ladder, poles and roof, meetings with agents, kiosk agents, local held cards and coffee, the jukebox and audio, single-player games, AI provider credentials and plan limits, native rendering and input, own-device discovery |

Single-player games (golf, basketball, BLOCKFALL, Minesweeper) stay on the desktop and WebXR.
They are not multiplayer; only their spectator and replication paths go.

### 1.2 Non-goals

- No change to worker, PTY host, worktree, queue, meeting, board or provider behavior.
- No `PTY_PROTOCOL` bump. Nothing here edits code the detached PTY host runs (`ptyhost.ts`,
  `screen.ts`, or what it imports from `ptys.ts`). A bump would end running terminals.
- No per-message auth overhead. LAN gating is one token check per connection (see D1);
  nothing on the steady-state path may cost latency.
- No automatic cleanup of old runtime files, remote machines, SSH keys or accounts.
- No change to the Vulkan native renderer beyond removing the microphone path.

## 2. Decisions

These are the starting positions. Each is confirmed by the owner before the commit that
depends on it (section 11 names the commit).

| # | Decision | Starting position | Reason |
| --- | --- | --- | --- |
| D1 | Authentication (owner override: no passwords, no sessions) | No passwords, accounts, sessions, cookies or login pages. Each start mints a random LAN token; loopback connects freely, every non-loopback HTTP/WebSocket request must carry `?t=<token>`. Startup prints a QR code of the join URL in the terminal; the headset scans it. | The office serves one laptop plus its headset. Gating costs one token compare per connection and zero per-message latency. |
| D2 | Network bind | Keep today's default (`0.0.0.0`), gated by the per-start token (D1). Loopback-only stays available through `--host 127.0.0.1`. | The Galaxy XR headset reaches the laptop over the LAN. Defaulting to loopback breaks it. |
| D3 | Several owner windows and devices | Allowed. Each is a transport connection with its own subscriptions and floor. None has a name, avatar or presence. | A laptop tab and a headset are the same person. A single global "viewer" flag causes detach and reconnect bugs. |
| D4 | Emotes | Keep the local animation and controls; delete the network message. | Character animation is single-player. |
| D5 | Lounge TV | Keep the geometry and idle screen; remove media capture, playback and "watch screen". | Avoids a room layout change. |
| D6 | Webhook notifications | Keep as optional owner notifications; rename "team" wording. | They report worker state, not people. |
| D7 | Remote hosting (AWS) | Keep owner lifecycle (`up`, `open`, `service`, `status`, `allow`, `revoke`, `ssh`, `logs`, `resize`, `pause`, `resume`, `update`, `down`); delete `invite`, `uninvite`, `team`, `reset-password`. `allow` and `revoke` manage SSH source CIDRs, not people, and stay. | AWS hosting is not multiplayer. Teammate management is. |
| D8 | Account-only installs | Superseded by the D1 owner override: with no passwords or accounts there is nothing to migrate. `accounts.json` is left unread on disk. | Nothing to migrate to. |
| D9 | Claim token and generated password | Superseded by the D1 owner override: the claim flow and generated password are deleted with the password. | No password, nothing to claim. |
| D10 | Historical names | `createdBy`, `addedBy`, `calledBy`, jukebox and score names stay as provenance text. Nothing filters by them. | Old state keeps loading and still reads sensibly. |

## 3. Invariants

These are the six places where a multiplayer concept carries single-owner behavior. Each must
be separated **before** the multiplayer code around it is deleted.

1. **Arrival is not presence.** `server.ts:onConnection` sends the owner's position inside
   `welcome.peers`, and `main.ts` finds its own peer to place the player. An explicit arrival
   payload replaces it before peers go. Roof fallback, removed-floor notice, invalid-position
   checks, elevator fallback, facing direction and completed ladder or pole arrivals all keep
   working.
2. **Terminal subscribers are not teammates.** `WorkerManager.viewers` routes PTY output,
   marks work acknowledged, and blocks queue seat reuse, leave-on-merge auto-removal and
   duplicate webhook notifications. It becomes an internal set of connection IDs plus a
   public, non-identifying `open` flag.
3. **Carrying is not multiplayer.** The local issue-card handoff and the native and WebXR
   coffee and card placement share a channel with remote objects. The local state, geometry
   and physical controls stay; only the replicated pose and the "another player holds this
   card" board hiding go.
4. **Game messages are not all disposable.** Golf replication goes; golf stays. Basketball and
   the arcade mix single-player state with server state and persistence: throw validation,
   physics, reset, BLOCKFALL pause and resume on worker interruption and high scores stay.
5. **Not every "account" is a person.** `ProxyAccount`, Claude plan limits, Jira and forge
   credentials, provider sessions, meeting roles and git `owner/repo` names stay.
6. **Broadcast is not necessarily multiplayer.** The server still pushes worker, board, queue,
   meeting, jukebox, theme and floor state to every owner connection. Only peer-only delivery
   and neighbor proximity filters go.

## 4. Target design

### 4.1 Connections

`server.ts:Client` (around lines 77–110) becomes an owner connection with no player inside it:

```ts
interface Connection {
  id: string;                 // transport ID, never shown, never a player
  ws: WebSocket;
  floor: string | null;       // current floor ID, ROOF, or null for the empty lobby
  terminals: Set<string>;     // attached worker IDs
  watches: Set<string>;       // changes watchers
  stale: Set<string>;         // raw terminal streams waiting for a resnapshot
  alive: boolean;             // heartbeat
  game?: GameSession;         // the arcade session this connection drives, if any
}
```

`floorOf`, `toFloor`, service routing, floor transition and removal, and cleanup read
`connection.floor` instead of `c.peer.floor`. `toNeighbors` and all proximity routing are
deleted with golf, peer and cabinet spectators.

### 4.2 Arrival

`welcome` and `floor.enter` carry an explicit arrival instead of a self-peer:

```ts
interface Arrival {
  floor: string | null;
  /** Where to stand, when the requested or saved spot is valid on this floor. */
  at?: { x: number; y: number; z: number; rotY: number };
  /** How the server chose it; the client uses it for fallbacks and notices. */
  via: 'saved' | 'requested' | 'elevator' | 'roof' | 'lobby';
  /** The remembered floor no longer exists. */
  removed?: boolean;
}
```

`welcome` loses `you`, `peers`, `ice`, `chat`, `invites` and `me`, and gains
`connection: string` and `arrival: Arrival`. `floor.enter` loses `peers` and gains `arrival`.
`main.ts` places the player from `arrival` in the same commit, using the existing
`returnLanding`, `arrivalSpot` and climb-completion code. This lands first (commit A1) while
the old peer fields still exist, so the commit stays green.

### 4.3 Terminal subscriptions and attention

```ts
// workers.ts, internal
private subscribers = new Map<string, Set<string>>(); // workerId -> connection IDs

// protocol.ts, public WorkerInfo
open: boolean;          // replaces viewers: string[] and viewerIds: string[]
lastInputAt?: number;   // replaces lastInput?: { by: string; at: number }
```

- `attach(workerId, connectionId)` adds one connection. `detach` removes one. Closing a
  connection removes only its own subscriptions; another owner window keeps its terminal.
- `acked` transitions (`workers.ts:2101`) fire when the first subscriber attaches, as today.
- `queue.ts:~306`, `leave-on-merge.ts:79` and `webhook.ts:108` replace `w.viewers.length`
  with `w.open`. An open owner terminal still prevents recycling, automatic worktree removal
  and duplicate notifications.
- `main.ts:yours()` (line 2649) is deleted. Every worker on the floor can need the owner's
  attention, including restored workers created under old names. Kind, meeting and
  acknowledgement filters stay.
- Terminal size: the most recently typing connection owns the PTY size, as the latest typist
  does today, without sending any identity.

### 4.4 Local objects and games

- The held issue card, coffee cup and their poses live in client state only
  (`main.ts:offBoard`, `world/held-object.ts`, `vr/grab.ts`, `src/client/native/physical.ts`).
  `net.carry`, the `carry` message, `readCarry`, `sameCarry` and the server carry parser go
  once nothing reads them.
- Basketball: `BallState.holder` and `BallShot.by` stop being peer IDs. The ball is held or
  free; the server keeps validating throws and resetting the ball per floor.
- Arcade: other-player occupancy, watch mode and spectator frames go. A game session belongs
  to the connection that started it; scores and `arcade.json` stay. Old paused sessions that
  no longer match start a new game with a clear message instead of corrupting the table.
- Seats: other-player reservation goes. `freePlace` (`main.ts:4210`) no longer reads peers.

### 4.5 LAN access (owner override: QR token, no passwords)

- `auth.ts` and `accounts.ts` are deleted: no passwords, sessions, cookies, login pages or
  claim flow. `POST /api/login`, `GET /api/login`, `/api/join`, `/api/claim`, `/api/whoami`,
  the relay sign-in page and the `login`/`join`/`claim` HTML entries go with them.
- Each server start mints a random LAN token (kept in memory, never written to disk).
  Startup prints a QR code of the join URL (`http://<lan-ip>:<port>/?t=<token>`) in the
  terminal. The headset scans it; the laptop browser on loopback needs no token.
- Every non-loopback HTTP request and WebSocket upgrade must carry `?t=<token>` (one
  timing-safe compare per connection; nothing per message). Missing or wrong token gets
  401/closed socket. Loopback (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`) bypasses the check.
- Origin checks on the WebSocket upgrade, uploads and owner writes stay. Office-cookie
  stripping from worker-service requests goes with the cookies.
- Every connection is the owner: role/admin checks on hot reload, floor removal, projects
  directory, prompts, default agent, machine limit and Jira are deleted, not replaced.
  Worker hook tokens (`DROID_OFFICE_HOOK_TOKEN`) and AI provider credentials stay; they are
  machine credentials, not user auth.

### 4.6 Search

`/api/search` returns `{q, terminals, more}`. `ChatLine` and the chat branch go. Desktop and
WebXR keep a reachable Find entry after the chat menu item that led to search is removed.

## 5. Protocol changes

The full per-variant ledger is in appendices A to C. Summary of field-level changes:

| Class | Symbol (line) | Change |
| --- | --- | --- |
| b | `WorkerInfo` (82), `viewers`/`viewerIds` (135–138), `lastInput` (147–148) | Replace with `open` and `lastInputAt`. Keep `acked`, `waitingSince`, `cols`, `rows`. `createdBy` stays as provenance. |
| c | `CarriedIssue` (288), `CarryPose` (294), `CarriedObject` (301) | Keep as local types; move out of the wire protocol if nothing on the wire uses them. |
| a | `PeerInfo` (303–335) | Delete. Local name, color, look, position, seat, carry, drink and reading move to local player state. |
| b | `FloorInfo.people` (768) | Delete the field. |
| b | `FloorView` (795–817) | Rewrite arcade occupant and ball holder without peer identity. |
| a | `AccountRole`, `Me`, `AccountInfo`, `AccountInvite`, `AccountsState`, `TeamMember`, `TeamState` (820–880) | Delete. |
| a | `ChatLine` (1045–1053) | Delete. |
| b | `SearchResults` (1066–1072) | Terminal hits only. |
| b | `welcome` (1254–1282), `floor.enter` (1284) | Explicit `connection` and `arrival`; no peers, ICE, chat, invites or `me`. |
| b | `gong` (1318), `horn` (1320), `notify` (1348) | `by` becomes optional provenance, never a peer. |
| c | `ProxyAccount` (609), `ProxyState` (626), `PlanLimits` (232), forge comments, meeting and queue types | Keep. |

Every protocol change updates the server handlers (`server.ts`, `floor.ts`), `net.ts`,
`state.ts` and the windows that send or read the message in the same commit, as
`src/shared/AGENTS.md` requires.

## 6. Work by area

### 6.1 Server, CLI and deployment

**Delete whole modules or blocks:**

| File / symbol | What goes |
| --- | --- |
| `src/server/accounts.ts` (395 lines) | Accounts, invites, name reservation, account CLI |
| `src/server/auth.ts` (160 lines) | Passwords, sessions, cookies, login rate limit |
| `src/server/team.ts` (93 lines) | SSH teammate list, invite and remove |
| `server.ts:login`, `/api/login` (GET+POST), `/api/whoami`, claim routes, `/login`, `/claim`, `/join` assets, relay sign-in page | All sign-in. Old `/login`, `/join`, `/claim` URLs 404 with the removed pages. |
| `config.ts` password/verifier/salt/secret/claim storage, `--password`, `--reset-password`, `--claim-token`, `DROID_OFFICE_PASSWORD`, `DROID_OFFICE_CLAIM_TOKEN` | Password and claim configuration |
| `cli.ts` `accounts` and `reset-password` flows, claim/password startup copy | Account CLI and password copy |
| `src/client/login.ts`, `join.ts`, `claim.ts` (or equivalents), Vite `login`/`join`/`claim` inputs | Sign-in pages |
| `history.ts:CHAT_KEEP`, `ChatLog` (12–86) | Chat persistence and search. `ScrollbackStore`, `terminalTail`, `searchTerminal` stay. |
| `server.ts:join`, `meOf`, `stillIn`, `onlineAccounts`, `accountsChanged`, `handleAccounts`, `teamChanged`, `team.*`, account dispatch | Invite redemption, roles, revocation, online state, team and account dispatch |
| `server.ts` cases `move`, `act`, `golf`, `emote`, `sit`, `carry` (1258–1330), `voice`, `rtc`, `chat` (1339–1356), `term.typing` (1606–1616), `doing` (1618–1627) | Peer relays |
| `config.ts:iceServers`, `RTCIceServerLike` (56), `--turn`, default STUN URLs | WebRTC NAT traversal |
| `config.ts:HELP` account/password/claim lines | Account CLI and copy |
| `deploy/aws.sh:TEAM_USER` (30), `require_team` (388), `team_members` (392), `cmd_invite` (616), `cmd_uninvite` (661), `cmd_team` (675), dispatch (838–840) | Teammate commands |
| `deploy/provision.sh:142–205` | Teammate user, tunnel command, team helper and sudoers entry. Audit first whether owner tunnels use the restricted user; if so, keep an owner-named equivalent. |

**Rewrite:**

| File / symbol | Required result |
| --- | --- |
| `server.ts:Client`, `sendTo`, `broadcast`, `floorOf` (255), `toFloor` (262) | Section 4.1. |
| `server.ts:onConnection` (994–1108) | Keep return-floor choice, position validation, initial floor data and screens, `workers.wakeAll()`, limits and proxy refresh, heartbeat, error handling and close cleanup. Send `arrival`. No peer creation, join or leave. |
| `server.ts:goToFloor`, `goToRoof`, `floor.go` (1358), `floor.remove` (1387), `floor.projectsDir` (1399) | Keep travel, cancellation, fallback, floor lifecycle and cleanup. Drop pose, seat, drink and carry resets. Every connection is the owner, so role checks are deleted. |
| `server.ts:FloorContext.people` (495); `floor.ts:FloorContext` (32), `people` (55), `active` (344–345), `info` (~348–363) | A floor is active while an owner connection is on it, work is busy, the queue has tasks, a meeting runs or a worktree is lent. No people count. |
| `workers.ts` `viewers` (182), `attach` (1018), `detach` (1045), `detachAll` (1050+), input (1076–1094), `syncViewers` (2112–2117), restore (508–509, 2362–2363, 2396) | Section 4.3. Restored workers ignore legacy viewer fields. |
| `server.ts:search` (684–692) | Section 4.6. |
| `court.ts:Court` (11) | One holder, no contention; keep validation, per-floor lifetime and reset. |
| `cabinet.ts:Player` (97), `Arcade` (194), `HighScores` (15); `server.ts:cabinetPlayer`, `cabinetState`, `stopPlaying`, cases 2029–2061 | Section 4.4. |
| `server.ts` HTTP handler + WebSocket upgrade, `cli.ts` startup banner | Section 4.5: per-start LAN token, terminal QR of the join URL, loopback bypass, one timing-safe compare per non-loopback connection. |
| `services.ts`, `ServicesState` (`protocol.ts:898`) | Service discovery and URLs stay. The `ssh` tunnel hint comes from owner remote metadata, not team membership. |
| `jukebox.ts`, `webhook.ts`, `notify.*` | Keep; owner wording. Webhook URLs stay secret and never appear in logs or migrations. |
| Owner checks at `server.ts:773–787`, 1389, 1401, 1826, 1838, 1852, 1863–1885 | Deleted; every connection is the owner. |
| `.env.example`, `tests/env-example.test.ts` | Remove `DROID_OFFICE_TEAM_HELPER`, password and claim-token vars. Remove `DROID_OFFICE_PUBLIC_HOST` if only team code reads it; otherwise document its owner use. |

**Keep untouched:** `ptyhost.ts`, `ptys.ts`, `screen.ts`, provider adapters, hooks, tasks,
usage, repositories and worktrees, GitHub, GitLab and Jira, `queue.ts`, `meetings.ts`,
`building.ts`, `prompts.ts`, setup and prune, `relay.ts` worker-service forwarding (not RTC),
`discovery.ts`, TLS and self-signed support, uploads, the PWA manifest, hot reload and
upgrades. `ws`, `three`, xterm, `bonjour-service` and `selfsigned` stay; no RTC npm package
exists to remove.

### 6.2 Desktop client

| File / symbol | Change |
| --- | --- |
| `src/client/voice.ts` (289 lines) | Delete. |
| `main.ts` `Voice` import (80), construction (565), welcome, RTC and peer handlers (1842–1999), voice restore (1892) | Delete voice; keep `Net`, retained handlers, worker screens and reconnect recovery. |
| `main.ts:RemotePeer` (1601), remotes map, `syncPeers` (2342–2394), `sayBubble` (2396), `walkTo` (2419), `vrWalkToPeer` (2436) | Delete remote humans, bubbles and "walk to teammate". Keep worker models and pathfinding. |
| `main.ts:offBoard` (418–421), carry and coffee hooks | Local only (section 4.4). |
| `main.ts` golf setup (1406–1490), `teeTaken` (1451), `theirShot` (1474) | Delete spectator state; keep local golf. |
| `main.ts` sitting (~4228–4270) | No peer reservation. |
| `main.ts` sends of `act` (3790, 3831, 4770), `emote` (4791), periodic `move` (5533) | Delete sends; keep local animations and movement. |
| `main.ts:watchShare` (3636), `currentShares` (5201), `refreshShares` (5215), share wiring (5184–5258) | Delete. Keep the TV's idle screen. |
| `main.ts` chat input (5170–5182), T focus (4893), V/M voice keys (4902+) | Delete; keep terminal, docs, palette and native keyboard focus routing. |
| `main.ts:doing` send (4978); `ui/dom.ts:doingNow` (62), `onDoingChange` (73), `setDoing` (78) | Delete the network side; keep `readingNow` and modal lifecycle. |
| `main.ts:yours` (2648–2652) | Delete (section 4.3). |
| `main.ts:paletteEntries` (~3411–3500) | Drop people, voice, chat, share, account and invite actions. |
| `main.ts` HUD actions (5279+), profile save and send (5417) | Drop Together, media, invite and account actions; keep local profile save. |
| `main.ts` update loop (5509–5563), native keyboard send (5806) | Drop voice meter, remote loop and typing sends. |
| `net.ts:Net` (7), `connect` (31), `carry` (88) | Keep connection, retry, restart, session expiry and floor/spot URL parameters. Drop look and name query fields and the pose helper. Keep `?native=1` through the login redirect. |
| `state.ts` `Topic` (42), `Store` (~250), `apply` (~378+) | Drop peers, chat, team, accounts, me, ICE and invites. Add `arrival` and the `open` worker flag. |
| `state.ts` `Profile` (81), `Spot` (175), helpers (186–208) | Keep; drop account name lock. |
| `state.ts` `HudPanel` (114), `HUD_DEFAULTS` (116), `loadSettings` (213) | Drop people and chat HUD choices; filter old pins and flags on load. |
| `ui/hud.ts` `renderPeople` (18), `updateSpeaking` (54), `renderChat` (121), help (142, 199) | Delete people and chat; rewrite help copy. |
| `ui/menu.ts` `PANELS` (33), `PANEL_EL` (43), mount and render (91, 158) | Drop people and chat entries and the Together section. |
| `index.html` people panel (42–44), chat (57–60), share container | Delete mounts. |
| `style.css` 134–162, 224–237, 474–481, 637–663, 1095 | Delete people, chat, typing, account, invite and share rules. Split `.people,.workers`; extract `.team`/`.team-status` styles that services use before deleting. |
| `ui/accounts.ts` (165 lines) | Delete. |
| `ui/team.ts` (161 lines) | Extract `Os`, `OS_LABEL` (7–8), `guessOs` (10), `openCommand` (16), `copy` (42), `copyButton` (58) into a shared helper first, then delete. |
| `ui/terminal.ts` `typingLine` (31), presence (152–195), typing handler (273), peer subscription (293), timer cleanup (317), size check (129–136) | Delete presence; size ownership per section 4.3. Keep xterm, snapshot and live data, attach and detach, search jumps, reconnect, toolbar and file input. |
| `ui/search.ts` `search` (14), `chatRow` (86), counts (120–125) | Terminal-only. |
| `ui/palette.ts` (25, 30) | Drop teammate entries and copy. |
| `ui/character.ts` (153–158, 205, 247) | Drop the account name lock. |
| `ui/settings.ts` admin branches (304, 351, 420, 466), account and sign-out (559–587), sound (590) | Delete admin branches, account and sign-out. Owner settings stay; "Sound & voice" becomes "Sound". |
| `ui/elevator.ts` people (114, 151), admin (133, 244), remove-floor copy (142–145), peer subscription (332); `ui/floormenu.ts` (47, 79) | Drop people counts, admin gating and plural relocation copy. |
| `ui/prompts.ts` (89), `ui/meeting.ts` (117, 135) | Drop role restrictions; keep `calledBy` as display history. |
| `ui/services.ts` (4–17, 29–32, 91+) | Use the extracted helpers. |
| `ui/whereabouts.ts` (39 lines) | Delete after its consumers go. |
| `ui/cabinet.ts` `mode`/`watch` (47, 60), `use` (112+), frames (169+), `open` (185), remote state (284–301) | Drop watch mode; keep the game. |
| `world/character.ts` `setLabel` (654), badge (667), `setVoiceLevel` (716), `showLabel` (723) | Delete remote-human presentation once no local or medic user remains. Keep the module. |
| `world/nameplate.ts` `nameBadge` (437), `disposeBadge` (463) | Delete only proven dead exports. Worker seat nameplates and lamps stay. |
| `src/client/join.ts`, `join.html`; `vite.config.ts:34,54` | Delete with routing and build input. |
| `src/client/login.ts`, `login.html`, `login.css`, `claim.ts`, `claim.html` | Delete with routing and build inputs. Stop reading and writing `droid-office.login-name`. |
| `sound.ts:10` | Drop voice-only comment. |

### 6.3 WebXR

| File / symbol | Change |
| --- | --- |
| `vr/menu.ts` `VrMenuStores` (54), `VrMenuActions` (93), `MenuView` (173), subscriptions (295) | Drop chat, peers, mute, voice, walk-to-peer. Keep hire, queue, boards, details, floors, jukebox, bar, search, assign, settings, meeting, services, changes and terminal actions. |
| `vr/menu.ts` `chatLines` (466), `searchRows` (495), chat and people rows (559–572), voice rows (604–624), view branches (684, 788, 797, 824, 835, 919, 972, 1078, 1369, 1379, 1448, 1504), floor people count (460) | Delete; terminal-only search with its own menu entry. |
| `vr/attach.ts` `VrUiVoice` (74), `VrUiDeps` (84), wiring (238–257), chat prompt (444+), search (453+) | Drop voice and chat; keep search prompt and panels. |
| `vr/preview.ts` (32, 180, 186, 191–192, 231–268) | New fixtures without chat, peers or voice. |
| `main.ts` WebXR deps (898–996), `__vrtest` hooks (1183–1221) | Drop teammate seeding, people and voice hooks. |
| `vr/terminal-panel.ts` `VrTerminalMsg` (24), typing literal (29), send (227) | Drop typing presence. |
| `vr/grab.ts`, `vr/controls.ts` | Drop pose networking; keep grabbing and placement. |
| `iwsdk-scripts/vr-voice.mjs`, `vr-leave.mjs`, `vr-people.mjs`, `vr-walkto.mjs`, `show-chat.mjs` | Delete. |
| `iwsdk-scripts/vr-search.mjs` | Terminal-only expectations. |
| `iwsdk-scripts/vr-state.mjs`, `show-settings.mjs`, `show-bar.mjs`, `enter-office.mjs`, `login.mjs`, carry, seat, floor and reconnect scripts | Update removed views, hooks and login fields. Worker "screen" scripts are terminals, not screen sharing. |

### 6.4 Installed native app

The installed APK runs the same `main.ts` with `?native=1`, so sections 6.2 and 6.3 already
update its shared action lists and keyboard channels. Native-specific work:

| File / symbol | Change |
| --- | --- |
| `src/client/native/controls.ts`, `menus.ts`, `ui.ts`, `typing.ts` | Drop indirect peer, media and typing-presence dependencies. `NativeTyping` is real keyboard input and stays. |
| `AndroidManifest.xml:4` | Remove `RECORD_AUDIO`. Keep `INTERNET`, `EYE_TRACKING_FINE`, `VIBRATE`. |
| `OfficeWebServices.java` 41–57, 91–115 | Remove microphone docs, request codes and pending mic state. |
| `OfficeWebServices.java:onRequestPermissionsResult` (217–241) | Remove the microphone flow; remove the method and its Activity forwarding if nothing else uses it. |
| `OfficeWebServices.java:onPermissionRequest` (270–301), cancel (303–305) | Deny all WebView media requests. |
| `OfficeWebServices.java:cancelPending` (~566), `denyMicrophone` (576) | Remove microphone cancellation only; keep file chooser and dialog cancellation. |
| `OfficeWebServices.java:Rules.grantableResources` (749–757), `Rules.ownsRequestCode` (784) | No audio whitelist. |
| `OfficeActivity.java:onRequestPermissionsResult` (194–199) | Remove mic forwarding; keep eye-tracking permission and the renderer start and foveation flow (186–188, 210). |
| `hosttest/.../OfficeWebServicesRulesTest.java` (130, 149, 159–177) | Test that audio, video and unknown resources are denied; keep origin, navigation, image and dialog tests. |

Java changes need the native host checks and both APK variants; a TypeScript typecheck does
not compile them. The Vulkan renderer, discovery, settings and scene stream do not change.

## 7. Persistence and migration

The policy is tolerant reads, explicit versioning only where a shape changes, unsupported
files left untouched, and no destructive cleanup commands.

| Stored data | Policy |
| --- | --- |
| `.droid-office/accounts.json` | Stop reading and writing it. Leave the file on disk. Never expose its hashes or invite tokens. |
| `.droid-office/chat.jsonl` | Stop reading, writing, indexing and broadcasting. Leave it on disk; the guide says where it is for anyone who wants it. |
| `.droid-office/config.json` | Keep TLS state. Drop the owner verifier, salt, secret and claim state. Never rewrite the whole file as "multiplayer state". |
| Floor `workers.json` | Load records with legacy `viewers`, `viewerIds`, `lastInput` and `createdBy`. Start subscriptions empty. Map `lastInput.at` to `lastInputAt`. |
| Scrollback, PTY host metadata, drops | Unchanged. |
| Building, project and floor lists; per-floor queue, repos, worktrees, meetings, Jira, decor, prompts, usage | Unchanged. Floor removal still leaves checkouts and state on disk. |
| `.droid-office/arcade.json` | Keep scores, names and colors. Old paused sessions that no longer validate become a new game. |
| Per-floor jukebox state | Keep; `by` is provenance. |
| `webhook.json` | Keep; never print or copy the URL. |
| Browser `droid-office.settings` | Load only retained HUD flags; drop old pins and unknown entries so removed panels never mount. |
| Browser `droid-office.login-name` | Stop reading and writing it. Remove only this key, once, in the main client. |
| Browser `droid-office.profile`, `droid-office.floor`, `droid-office.spot`, game records | Keep. Never clear localStorage wholesale. |
| `ao_session` cookies | Ignored; no cookie code remains. Old cookies simply stop working. |
| AWS helper, keys, sudoers and restricted user on existing machines | Source changes do not touch running hosts. The guide documents a manual audit before anyone removes keys or users. |
| Android saved office, discovery choice, APK graphics settings, signing lineage | Unchanged; the microphone permission simply stops being requested. |

## 8. Tests

### 8.1 Add first (regression coverage before deletion)

- Welcome and reconnect place the player with no peers: a valid saved spot and facing; a
  removed floor lands on the roof; an invalid or colliding spot lands at the elevator; a
  completed ladder or pole arrival survives scene cleanup.
- PTY attach, snapshot, live output, input and resize survive a server restart. Closing one
  owner connection does not detach another. A stale or backpressured stream resnapshots.
- An open owner terminal blocks queue seat reuse and leave-on-merge. Attaching acknowledges
  attention and drives next-waiting and notifications.
- Restored workers with old `createdBy` and `lastInput.by` names stay visible and actionable.
- Issue-card handoff, coffee drinking and placement work in desktop, WebXR and native paths
  with no peer map and no network channel.
- Local golf, seats, Minesweeper, arcade and basketball work; the arcade pauses for worker
  input; scores survive a restart.
- Terminal-only search is reachable on desktop and in WebXR, including persisted scrollback
  and line jumps.
- LAN gating rejects missing and wrong `?t=` tokens from non-loopback senders, lets
  loopback through, and still rejects cross-origin WebSocket and mutation requests.
- No remaining code requests the microphone or display capture. The Android manifest has no
  `RECORD_AUDIO`; WebView media requests are denied while file picker and origin protections
  remain.
- Old HUD flags and voice, share, invite and account pins cannot mount missing UI.

### 8.2 Delete or rewrite

| Test | Change |
| --- | --- |
| `tests/whereabouts.test.ts` | Delete with `ui/whereabouts.ts`. |
| `tests/history.test.ts` | Drop chat cases; keep scrollback and terminal search. |
| `tests/vr-grab.test.ts` (245–264), `readCarry`/`sameCarry` tests | Drop peer updates; keep local grip, reach, cancel, coffee, card and placement. |
| `tests/hoop.test.ts` | One-player hold, throw and reset; keep geometry, aiming, physics, rebound and scoring. |
| `tests/cabinet.test.ts` | Drop account and connection contention; keep frame, schema and score validation, pause and resume, rate bounds and persistence. |
| `tests/emotes.test.ts` | Drop server leniency; keep local IDs, durations and keys. |
| `tests/queue.test.ts`, `leave-on-merge.test.ts`, `nextup.test.ts`, `repos.test.ts`, `meetings.test.ts`, `prompts.test.ts`, `workers.test.ts` and other worker fixtures | `open` instead of `viewers`/`viewerIds`; add owner-open protection, single detach, legacy creator and acknowledgement cases. |
| `tests/hot-reload-http.test.ts` (66–74) | Drop the member-account scenario and the admin gate; keep origin checks. |
| `tests/config.test.ts`, `env-example.test.ts` | Drop TURN, team, account, password and claim CLI/env; assert bind and QR-token policy. |
| `tests/settings-nav.test.ts` | "Sound" label. |
| `tests/pwa.test.ts`, `native-launch.test.ts`, `hot-reload-client.test.ts` | Drop join/login/claim page assumptions. |
| `tests/native-controls.test.ts`, `native-nameplates.test.ts`, `native-typing.test.ts`, `native-menus.test.ts`, `native-desktop-parity.test.ts` | Update peer, carry, menu and typing fixtures. |
| `OfficeWebServicesRulesTest.java` | Section 6.4. |

Keep: `seats`, `spot`, `return-landing`, `discovery`, elevator, building, climb, VR input,
worker, provider, board, worktree, actions, droidproxy, opencode, Jira and forge comment,
casualty, medic and shot suites. "People", "team", "shared" and "account" in them are issue
text, plan names, agent roles or provider credentials. Never delete a test by grep alone.

### 8.3 Coverage

`package.json` enforces 78% lines and 61% functions (excluding `tests/**`). Thresholds stay.
Deleting code changes the denominator; deleting tests must not drop coverage of what remains.

## 9. Docs and copy

| File | Change |
| --- | --- |
| `README.md` 7–9, 21–35, 42, 57, 85, 91 | Single-owner introduction. Drop voice, sharing, team and invite claims. Keep desks, PTYs, boards, meetings with agents ("Lead & team" is an agent pattern), limits and XR. Picture alt text stops claiming human teammates. |
| `docs/guide.md` 13–15, 21–27, 30–35, 40–48, 54–68, accounts, deploy, auth and "How it works" sections | Rewrite presence, media, shared terminals, accounts, invites, SSH team setup, spectators and permissions. Drop chat from restart notes. Note where the left-behind `chat.jsonl` and `accounts.json` are. |
| `docs/vr-webxr.md` 59–80, 85–102, 154–174 | Drop replicated held objects, voice, chat, people and walk-to-teammate. |
| `docs/vr-native-android.md` | Drop the microphone sentence (around line 600) and account sign-in references. |
| `docs/vr-native-checks.md`, `vr-native-ui-polish.md` (chat placeholder note), `vr-galaxy-xr-handoff.md`, `vr-native-controller-interactions.md` | Remove stale media, presence and auth steps only. Historical measurements stay as recorded. |
| Root `AGENTS.md` opening paragraph | "A 3D office in the browser where its owner hires claude, opencode, codex and droid workers at desks and works in their live PTYs." |
| `package.json` `description` | Same wording. |
| `.github/ISSUE_TEMPLATE/feature_request.yml:38` | Drop the "Voice/chat/screen sharing" area. |
| CLI startup and `HELP` | No "share with your team". |
| `gun-spec.md` "Multiplayer" section | Drop; other clients no longer exist. |

Built `dist/` output is regenerated, never hand-edited. Verify the packed release has no join
page or media assets.

## 10. Risks

| Risk | Severity | Control |
| --- | --- | --- |
| Deleting the self-peer before explicit arrival | High | A1 lands arrival with tests while peers still exist. |
| Deleting the viewer map with the typing UI | High | A2 separates subscriptions; tests for single detach and queue, auto-remove and notify protection. |
| No-password LAN access on a public bind | High | D1 per-start token + D2; origin checks stay; loopback bypass; rejection tests for missing and wrong tokens. |
| Old creator names hide restored workers | High | Delete `yours()`; legacy-state test. |
| Broad deletion of `Person`, character or native modules | High | Delete only proven dead exports; keep local avatar, worker, medic, nameplate and controller consumers. |
| Losing card, coffee or board handoff | High | A3 makes local objects independent before relay deletion; tests in all three clients. |
| Losing single-player arcade or basketball with spectators | Medium-high | A3 separates game state from peer ownership. |
| Deleting `ui/team.ts` breaks services, clipboard or styles | Medium | Extract helpers and CSS first. |
| Search orphaned when the chat menu goes | Medium | Independent search entry and navigation tests. |
| Stale pins, DOM mounts or dev pages ship | Medium | Settings migration and Vite inputs change together. |
| Java mic removal breaks the file picker or eye permission | Medium-high | Rules tests, eye branch preserved, native host checks and both APKs. |
| Docs no longer match the product | Medium | A8 sweep and the audit in section 13. |

## 11. Commit plan

Each commit is green on its own: lint, typecheck and coverage pass, the build runs, and any
protocol change updates server and client together. Tests and directly affected docs, env and
help ship with the behavior that makes them obsolete; A8 is a sweep, not a place to park
broken examples.

| Commit | Contents | Done when | Needs decision |
| --- | --- | --- | --- |
| **A1** `feat: send the owner's arrival explicitly` | `Arrival` in `welcome` and `floor.enter`; `Connection.floor` separate from `PeerInfo`; client placement from `arrival`; regression tests for reconnect, removed floor, elevator fallback, ladder and pole. Old peer fields stay. | Player placement never reads `welcome.peers` or `store.peers.get(store.you)`. | - |
| **A2** `feat: track terminal subscriptions per connection` | Internal subscribers, `WorkerInfo.open`, `lastInputAt`; queue, leave-on-merge, webhook and size ownership; `yours()` removed; helper and CSS extraction from `ui/team.ts`. | Two owner windows attach the same terminal; closing one leaves the other streaming; queue and auto-remove tests pass. | D3 |
| **A3** `feat: keep held objects and games local` | Local carry, seat, golf, emote and reading state; one-player ball and arcade; high-score compatibility. Spectator branches go once local tests pass. | No local gameplay path reads peers or sends `carry`, `sit`, `act`, `golf` or `emote`. | D4 |
| **A4** `feat: remove voice and screen sharing` | Delete `voice.ts`, RTC, ICE, TURN, media UI, hotkeys and TV streams, WebXR deps, previews, tests and scripts; protocol, server and state in the same commit. Jukebox, ambient audio and TLS stay. | No `getUserMedia`, `getDisplayMedia` or `RTCPeerConnection` in `src/`. | D5 |
| **A5** `feat: remove chat and teammate presence` | Delete chat persistence, DTO, UI and search branch; remote avatars, relay handlers, whereabouts, people views, floor people counts and movement sends. | Audit patterns for `PeerInfo`, `ChatLine`, `peer.*`, `term.typing` find nothing live. | - |
| **A6** `feat: replace passwords and accounts with QR pairing` | Delete auth/accounts/login/join/claim routes, pages, CLI, UI, team DTOs and role checks; per-start LAN token, terminal QR, loopback bypass; services ssh hint from owner metadata; Vite, env and help. | Laptop connects with no login; LAN needs `?t=`; missing/wrong token rejected; login/join/claim gone from the build. | D1, D2 |
| **A7** `chore: remove teammate deployment and the native microphone` | AWS team commands and provisioning; team env; Android `RECORD_AUDIO`, mic requests and grants; Java rules tests. May split into two commits. | Native host checks and both APK variants pass; `aws.sh help` lists no team commands. | D7 |
| **A8** `docs: describe the single-owner office` | Section 9 sweep; dead CSS, fixtures, emulator scripts; legacy browser settings; packaged artifact check; final validation. | Section 13 audit is clean except listed false positives. | D6, D10 |

## 12. Validation

For every commit, in order:

```bash
npm ci
npm run lint
npm run typecheck
npm run test:coverage
```

When startup, pages, `bin`, `files` or the installer change (A6, A8), also run the
workflow's "Pack the release" and "Install it with install.sh and start it" steps, including
the readiness check on `/login.html`.

For A7 (and A2 if `native/` TypeScript changes), run the native host checks and both
`assembleDebug` and `assembleRelease`. Linux Vulkan validation is reported as NOT RUN on
macOS, never as passing.

On a device: desktop browser, WebXR emulator (`npm run dev:runtime`) and the installed APK
each reconnect, travel floors, attach terminals from two windows, hand a card to a worker,
drink coffee and play a local game. Record which checks ran on which client.

## 13. Final audit

Run from the repository root after A8. Every hit is classified, not deleted automatically.

```sh
rg -n 'PeerInfo|ChatLine|TeamState|AccountsState|AccountRole|AccountInvite|RTCIce|RTCPeerConnection|getUserMedia|getDisplayMedia|term\.typing|peer\.(join|update|move|leave|act|emote)' src tests native/android/hosttest native/android/app/src
rg -n 'DROID_OFFICE_(PUBLIC_HOST|TEAM_HELPER)|droid-office-team|RECORD_AUDIO|Join voice|Leave voice|Screen sharing|Invite teammates|Sound & voice' src tests native docs README.md .env.example deploy .github
rg -n 'store\.(peers|chat|team|me|invites)|people-panel|chat-input|viewerIds|lastInput\b|Team notifications|droid-office.login-name' src tests
rg -n 'join\.html|/api/join|/join|--turn|stun:' src vite.config.ts tests docs README.md
git status --short
```

Expected false positives: provider `account` terms, agent `team` meeting patterns, historical
`createdBy`/`calledBy` provenance, worker-service WebSockets, native scene sharing, npm peer
dependencies, and license and fork provenance.

## 14. Scope

Planning ranges, not a measured diff:

| Area | Gross lines removed | Rewrite effort |
| --- | --- | --- |
| Server: accounts, team, chat, peers, auth, config | 1,200–1,900 | Connections, floor routing, owner auth, subscriptions, game ownership, migration |
| Desktop: main, state, UI, voice, CSS, pages | 1,500–2,500 | Local player and objects, `open` flag, settings, services, search |
| Shared protocol | 180–350 | Arrival, `open`, ball and cabinet shapes and their consumers |
| WebXR, native Java and media, test hooks | 400–800 | Menu, search, fixtures, picker and eye permissions, native builds |
| Deploy, tests, docs, emulator scripts | 900–1,600 | Owner remote policy, assertions, packaging, copy |
| **Total** | **about 4,200–7,150** | **about 700–1,700 new or replacement lines** |

Expected net reduction is about 2,500–6,400 lines across 45–70 production, config and doc
files plus 15–30 tests and scripts. Effort is roughly 6–10 focused engineering days for one
person, plus device validation and legacy-state checks. The risk is entanglement and
verification, not the size of `voice.ts`.

For context at the baseline: server 55 TypeScript files (about 17.6k lines), shared 28 (5.0k),
UI 43 (11.2k), world 41 (18.1k), WebXR 19 (8.1k), native TypeScript 27 (8.4k), tests 100
(21.1k). `main.ts` is about 6.1k lines and `server.ts` about 2.2k. Most world, native and
worker code stays.

## Appendix A. `ClientMsg` ledger (89 variants)

**a** removes the variant with every producer and consumer. **b** keeps it with a revised
payload or local-only replacement. **c** keeps it unchanged apart from identity checks that the
rewrites above remove.

| Line | Variant | Class | Disposition |
| --- | --- | --- | --- |
| 1078 | `move` | a | Delete the position broadcast; keep local movement and explicit saved arrival. |
| 1084 | `act` | a | Delete the arm, smoke, golf and drink relay; keep local animations and gameplay. |
| 1089 | `golf` | a | Delete the shot relay; keep local golf flight, aiming, records and camera. |
| 1091 | `sit` | a | Delete seat replication; keep local sitting and seat and game controls. |
| 1093 | `carry` | a | Delete replicated card and coffee pose; keep local held-object state. |
| 1095 | `emote` | a | Delete the relay; keep local emote selection and animation. |
| 1096 | `profile` | b | Remove the peer broadcast and account name lock; keep the local profile. |
| 1101 | `worker.spawn` | c | Keep. |
| 1102 | `worker.resume` | c | Keep. |
| 1103 | `worker.kill` | c | Keep. |
| 1105 | `worker.shoot` | c | Keep. |
| 1107 | `worker.revive` | c | Keep. |
| 1109 | `worker.worktree` | c | Keep. |
| 1111 | `worker.rebuild` | c | Keep. |
| 1112 | `worker.attach` | c | Keep the subscription, snapshot and acknowledgement, without viewer identity. |
| 1113 | `worker.detach` | c | Detach this connection only. |
| 1115 | `worker.prompt` | c | Keep. |
| 1121 | `station.prompt` | c | Keep. |
| 1123 | `worker.pr` | c | Keep. |
| 1124 | `term.input` | c | Keep PTY input; drop last-typist identity side effects. |
| 1126 | `term.typing` | a | Delete teammate typing; terminal input is unaffected. |
| 1127 | `term.resize` | c | Keep; size ownership per section 4.3. |
| 1129 | `doing` | a | Delete human whereabouts; keep the local reading animation. |
| 1130 | `gh.refresh` | c | Keep. |
| 1132 | `gh.merge` | c | Keep. |
| 1134 | `gh.comment` | c | Keep. |
| 1136 | `gong` | b | Keep the manual, merge and queue celebration; no peer attribution. |
| 1138 | `horn` | b | Keep the rooftop horn; no peer attribution. |
| 1140 | `gh.close` | c | Keep. |
| 1142 | `gh.labels` | c | Keep. |
| 1143 | `queue.add` | c | Keep. |
| 1144 | `queue.remove` | c | Keep. |
| 1146 | `queue.move` | c | Keep. |
| 1148 | `queue.retry` | c | Keep. |
| 1150 | `queue.clear` | c | Keep. |
| 1151 | `queue.limit` | c | Keep. |
| 1153 | `meeting.start` | c | Keep. |
| 1155 | `meeting.stop` | c | Keep. |
| 1157 | `meeting.clear` | c | Keep. |
| 1159 | `notify.webhook` | b | Keep as owner notification setup. |
| 1161 | `notify.test` | b | Keep the owner-triggered test. |
| 1163 | `machine.limit` | b | Owner check instead of admin role. |
| 1165 | `jira.connect` | b | Owner check instead of admin role. |
| 1167 | `jira.disconnect` | b | Owner check instead of admin role. |
| 1169 | `jira.epic` | b | Owner check instead of admin role. |
| 1171 | `jira.refresh` | c | Keep. |
| 1172 | `voice` | a | Delete. |
| 1173 | `rtc` | a | Delete. |
| 1174 | `chat` | a | Delete. |
| 1175 | `team.get` | a | Delete. |
| 1176 | `team.invite` | a | Delete. |
| 1177 | `team.remove` | a | Delete. |
| 1179 | `accounts.get` | a | Delete. |
| 1180 | `accounts.invite` | a | Delete. |
| 1181 | `accounts.cancel` | a | Delete. |
| 1182 | `accounts.revoke` | a | Delete. |
| 1183 | `accounts.role` | a | Delete. |
| 1185 | `accounts.shared` | a | Delete. |
| 1190 | `changes.watch` | c | Keep. |
| 1191 | `changes.unwatch` | c | Keep. |
| 1192 | `changes.diff` | c | Keep. |
| 1193 | `changes.commit` | c | Keep. |
| 1195 | `changes.discard` | c | Keep. |
| 1196 | `changes.pr` | c | Keep. |
| 1197 | `upgrade.check` | c | Keep. |
| 1198 | `upgrade.start` | c | Keep. |
| 1200 | `limits.refresh` | c | Keep. |
| 1202 | `decor.add` | c | Keep. |
| 1204 | `decor.update` | c | Keep. |
| 1205 | `decor.remove` | c | Keep. |
| 1207 | `jukebox.play` | c | Keep. |
| 1209 | `jukebox.skip` | c | Keep. |
| 1210 | `jukebox.stop` | c | Keep. |
| 1216 | `cabinet.play` | b | The owner's game start and resume; no occupancy or account ownership. |
| 1217 | `cabinet.leave` | b | Pause, leave and final score; no teammate state. |
| 1222 | `cabinet.frame` | b | Score validation upload; no spectator relay. |
| 1228 | `floor.go` | b | Travel with `at` and facing; no peer state. |
| 1230 | `floor.repos` | c | Keep. |
| 1232 | `floor.add` | b | Keep; `addedBy` is provenance. |
| 1234 | `floor.remove` | b | Owner check; no people counts. |
| 1236 | `theme.set` | c | Keep. |
| 1238 | `leaveOnMerge.set` | c | Keep. |
| 1240 | `floor.projectsDir` | b | Owner check instead of admin role. |
| 1242 | `ball.take` | b | One holder, no contention. |
| 1244 | `ball.throw` | b | Validated throw, no thrower ID. |
| 1246 | `prompts.set` | b | Owner check instead of admin role. |
| 1248 | `prompts.agent` | b | Owner check instead of admin role. |
| 1250 | `proxy.refresh` | c | Keep. |
| 1251 | `ping` | c | Keep for clock and jukebox sync. |

## Appendix B. `ServerMsg` ledger (60 variants)

| Line | Variant | Class | Disposition |
| --- | --- | --- | --- |
| 1255 | `welcome` | b | `connection` and `arrival`; no peers, ICE, chat, invites or `me`. |
| 1284 | `floor.enter` | b | `arrival`; no peers. |
| 1285 | `floors` | b | No `people`. |
| 1287 | `floor.repos` | c | Keep. |
| 1289 | `floor.added` | c | Keep. |
| 1291 | `projectsDir` | c | Keep. |
| 1292 | `peer.join` | a | Delete. |
| 1293 | `peer.update` | a | Delete. |
| 1294 | `peer.move` | a | Delete. |
| 1295 | `peer.leave` | a | Delete. |
| 1296 | `peer.act` | a | Delete. |
| 1298 | `golf` | a | Delete; local golf stays. |
| 1299 | `peer.emote` | a | Delete. |
| 1300 | `worker.update` | b | `open` and `lastInputAt` instead of viewers and last typist. |
| 1301 | `worker.remove` | c | Keep. |
| 1302 | `worker.worktree` | c | Keep. |
| 1303 | `screen` | c | Keep. |
| 1304 | `term.snapshot` | c | Keep. |
| 1305 | `term.data` | c | Keep, to connection subscribers. |
| 1307 | `term.typing` | a | Delete. |
| 1308 | `gh.issues` | c | Keep. |
| 1309 | `gh.pulls` | c | Keep. |
| 1311 | `gh.merged` | c | Keep. |
| 1313 | `gh.commented` | c | Keep. |
| 1318 | `gong` | b | Optional provenance `by`. |
| 1320 | `horn` | b | No sender identity. |
| 1322 | `gh.closed` | c | Keep. |
| 1324 | `gh.labeled` | c | Keep. |
| 1325 | `rtc` | a | Delete. |
| 1326 | `chat` | a | Delete. |
| 1332 | `toast` | c | Keep, including `workerId` tagging. |
| 1333 | `team` | a | Delete. |
| 1334 | `upgrade` | c | Keep. |
| 1335 | `services` | b | Owner remote metadata from a non-team source. |
| 1336 | `decor` | c | Keep. |
| 1338 | `ball` | b | No peer holder or thrower. |
| 1339 | `jukebox` | c | Keep. |
| 1341 | `cabinet` | b | No other-player occupant. |
| 1343 | `cabinet.frame` | a | Delete the spectator broadcast. |
| 1344 | `usage` | c | Keep. |
| 1345 | `limits` | c | Keep. |
| 1346 | `queue` | c | Keep. |
| 1347 | `meeting` | c | Keep. |
| 1348 | `notify` | b | Owner wording; no teammate attribution. |
| 1350 | `jira` | c | Keep. |
| 1351 | `jira.board` | c | Keep. |
| 1353 | `jira.setup` | b | No admin-role copy. |
| 1354 | `machine` | c | Keep. |
| 1355 | `proxy` | c | Keep. |
| 1356 | `sky` | c | Keep. |
| 1357 | `theme` | c | Keep. |
| 1358 | `leaveOnMerge` | c | Keep. |
| 1359 | `prompts` | c | Keep. |
| 1361 | `changes` | c | Keep. |
| 1362 | `changes.diff` | c | Keep. |
| 1364 | `team.invited` | a | Delete. |
| 1366 | `accounts` | a | Delete. |
| 1368 | `accounts.invited` | a | Delete. |
| 1370 | `me` | a | Delete. |
| 1372 | `pong` | c | Keep. |

## Appendix C. Exported protocol types (84)

| Line | Type | Class | Note |
| --- | --- | --- | --- |
| 14 | `WorkerStatus` | c | Worker lifecycle. |
| 23 | `WorkerKind` | c | Agent or shell. |
| 29 | `WorkerAction` | c | Tool-call animation. |
| 31 | `AgentProvider` | c | Worker engines. |
| 38 | `ClaudeModel` | c | Model choice. |
| 45 | `AgentEffort` | c | Reasoning effort. |
| 52 | `AgentChoice` | c | Default engine. |
| 63 | `PromptsState` | c | Owner prompts and default engine. |
| 74 | `WorkerTask` | c | Task card. |
| 82 | `WorkerInfo` | b | `open`, `lastInputAt`; `createdBy` as provenance. |
| 160 | `LostBranch` | c | Lost worktree recovery. |
| 163 | `Usage` | c | Token and cost accounting. |
| 205 | `UsageState` | c | Usage and budgets. |
| 219 | `PlanWindow` | c | Subscription window. |
| 232 | `PlanLimits` | c | AI provider plan. |
| 245 | `WorkerRepo` | c | Multi-repository worktrees. |
| 266 | `WorktreeCleanup` | c | Cleanup choice. |
| 269 | `WorktreeState` | c | Dirty, ahead and unpushed preview. |
| 288 | `CarriedIssue` | c | Local card handoff. |
| 294 | `CarryPose` | c | Local hand and placement pose. |
| 301 | `CarriedObject` | c | Local union; replication goes. |
| 303 | `PeerInfo` | a | Delete. |
| 338 | `Run` | c | Styled terminal run. |
| 346 | `GhLabel` | c | Forge label. |
| 353 | `GhIssue` | c | Forge issue. |
| 367 | `GhPull` | c | Forge PR or MR. |
| 390 | `TaskStatus` | c | Queue lifecycle. |
| 393 | `QueueTask` | c | Queue task. |
| 421 | `QueueState` | c | Queue state. |
| 428 | `MeetingPattern` | c | Agent meeting patterns. |
| 431 | `MeetingSeat` | c | Agent role and seat. |
| 444 | `MeetingTurn` | c | Agent turn. |
| 458 | `MeetingStatus` | c | Meeting lifecycle. |
| 464 | `Meeting` | c | Meeting state. |
| 520 | `MeetingRecord` | c | Past meeting. |
| 533 | `MeetingState` | c | Current and past. |
| 541 | `MeetingRequest` | c | The owner calls agents together. |
| 560 | `WebhookKind` | c | Notification sink. |
| 563 | `NotifyState` | b | Owner wording. |
| 575 | `MachineState` | c | Machine pressure and capacity. |
| 596 | `ProxyProvider` | c | Credential provider. |
| 599 | `ProxyWindow` | c | Quota window. |
| 609 | `ProxyAccount` | c | AI subscription record. |
| 626 | `ProxyState` | c | Proxy quotas. |
| 636 | `GhState` | c | Board wrapper. |
| 643 | `GhMergeMethod` | c | Merge choice. |
| 646 | `GhCloseReason` | c | Close reason. |
| 649 | `GhRepoInfo` | c | Repository and permissions. |
| 655 | `GhComment` | c | Forge comment, not office chat. |
| 666 | `GhReviewComment` | c | Review comment. |
| 681 | `GhCheck` | c | CI check. |
| 688 | `GhPullDetail` | c | PR detail. |
| 713 | `GhIssueDetail` | c | Issue detail. |
| 728 | `ProjectInfo` | c | Project and forge. |
| 744 | `FloorInfo` | b | No `people`. |
| 772 | `ProjectsDirState` | c | Projects directory. |
| 782 | `RepoChoice` | c | Checkout discovery. |
| 795 | `FloorView` | b | Arcade occupant and ball holder rewritten. |
| 820 | `AccountRole` | a | Delete. |
| 823 | `Me` | a | Delete. |
| 830 | `AccountInfo` | a | Delete. |
| 842 | `AccountInvite` | a | Delete. |
| 854 | `AccountsState` | a | Delete. |
| 861 | `TeamMember` | a | Delete. |
| 868 | `TeamState` | a | Delete. |
| 882 | `ServiceInfo` | c | Worker service. |
| 898 | `ServicesState` | b | Owner remote metadata, not team. |
| 906 | `ChangeStatus` | c | Git file state. |
| 909 | `ChangedFile` | c | Diff metadata. |
| 947 | `ChangesState` | c | Changes watch. |
| 974 | `VersionInfo` | c | Release metadata. |
| 982 | `UpgradeState` | c | Upgrade progress. |
| 1000 | `Weather` | c | Ambient weather. |
| 1004 | `SkyState` | c | Weather and time. |
| 1020 | `Theme` | c | Holiday theme. |
| 1022 | `ThemePick` | c | Theme choice. |
| 1025 | `ThemeState` | c | Theme state. |
| 1038 | `LeaveOnMergeState` | c | Cleanup policy; uses `open`. |
| 1045 | `ChatLine` | a | Delete. |
| 1056 | `TerminalHit` | c | Terminal search hit. |
| 1066 | `SearchResults` | b | Terminal hits only. |
| 1075 | `GongWhy` | c | Celebration reason. |
| 1077 | `ClientMsg` | b | Appendix A. |
| 1253 | `ServerMsg` | b | Appendix B. |

Constants, validators and formatters in `protocol.ts` that are not types (`WORKER_REVIVE_MS`,
provider, model and effort guards, token and cost formatters, terminal flags, forge limits,
weather constants, the image type helper) are class **c**.

## Appendix D. Whole-file candidates

Line counts at the baseline. A **b** file is mixed; only part of it goes.

| File | Class | Lines | Reason |
| --- | --- | --- | --- |
| `src/client/voice.ts` | a | 289 | WebRTC voice and display share |
| `src/server/accounts.ts` | a | 395 | Accounts, invites, CLI |
| `src/server/team.ts` | a | 93 | SSH teammate helper |
| `src/client/ui/accounts.ts` | a | 165 | Account management UI |
| `src/client/ui/whereabouts.ts` | a | 39 | Presence summaries |
| `src/client/join.ts` | a | 82 | Invite redemption |
| `src/client/join.html` | a | 32 | Invite page |
| `tests/whereabouts.test.ts` | a | 23 | Presence tests |
| `src/client/iwsdk-scripts/vr-voice.mjs` | a | 24 | Voice scenario |
| `src/client/iwsdk-scripts/vr-leave.mjs` | a | 15 | Leave and mute scenario |
| `src/client/iwsdk-scripts/vr-people.mjs` | a | 19 | People view scenario |
| `src/client/iwsdk-scripts/vr-walkto.mjs` | a | 25 | Walk-to-teammate scenario |
| `src/client/iwsdk-scripts/show-chat.mjs` | a | 6 | Chat scenario |
| `src/client/ui/team.ts` | b | 161 | Extract OS and clipboard helpers first |
| `src/server/history.ts` | b | 186 | Chat only; scrollback and search stay |
| `src/client/vr/menu.ts` | b | 1827 | Most views stay |
