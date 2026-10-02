# Unity headset app: specification and plan

**Status:** implementation in progress. Baseline `28cf00f` on `main`; section 25 records
the implemented foundation and measured evidence. The other sections remain the target
specification, not a claim that their features or milestone exits are complete.

This is **Track C** of the standalone headset roadmap:

| Track | Plan | Summary |
| --- | --- | --- |
| A | [Single-owner office](single-owner.md) | Remove multiplayer from the server, desktop, WebXR and the current APK |
| B | [Headset protocol](headset-protocol.md) | Device pairing, negotiated protocol, operation results, terminal grids, layout contract |
| C | This document | A Unity Android XR app for Galaxy XR that talks to the laptop directly |
| D | Section 22 | Retire the WebView-based APK once the Unity app replaces it |

## 1. Why

The installed Galaxy XR app (**existing**, [vr-native-android.md](vr-native-android.md)) draws
the world natively, but the office itself runs in a WebView page. Gameplay, picking, physics and
UI run at that page's pace: the page's control packets arrive about every 33 ms and, while the
page works, regularly 250 to 500 ms apart ([controller interactions](vr-native-controller-interactions.md)).
Every grab, press and menu round-trips through a bridge. That ceiling rules out the interaction
quality the owner wants.

The Unity app moves everything the owner touches into the headset process, running at display
rate. The laptop keeps only what it must own: workers, PTYs, boards, the queue, floors and
meetings.

## 2. Product

### 2.1 One sentence

Put on the headset and you are standing in your office, with your agents at their desks, and
every part of directing them is something you do with your hands.

### 2.2 The bar

The reference is **Half-Life: Alyx for interaction and menu quality**, not for graphics. In
practice that means:

- **Objects behave like objects.** Cards, cups, books, the tablet, buttons and handles have
  weight, grab poses, sound and haptics. Nothing is a floating rectangle that ignores your hand.
- **The world explains itself.** No text names a controller button. Affordances show what can be
  done: a highlight when your hand is near, a pose change when it can be grabbed, a click when it
  presses.
- **Feedback is immediate and local.** Contact, press and grab respond on the same display frame.
  The server's answer refines the result; it never gates the first response.
- **Nothing is debug.** No raw identifiers, timestamps, JSON keys, stack traces or placeholder
  copy in any shipped surface.
- **Comfort is never an afterthought.** Teleport by default; every motion that can make someone
  ill has an option.
- **Menus are physical too.** The main menu is a tablet you hold, put down and poke, not a panel
  bolted to your face.

### 2.3 What the owner does in v1

1. Put on the headset; the app reconnects to the saved office and places you where you left off.
2. See which agents need you: red lamps at their desks, a ping from their direction, a count on
   the back of your left hand, a list on the tablet.
3. Walk up to an agent, open its laptop, read the terminal and answer, with a paired keyboard,
   the quick-answer pad or the poke keyboard.
4. Pull an issue card off the board, from across the room with a flick of the wrist, and hand it
   to an agent. The agent takes it, reads it and starts typing.
5. Put a card on an empty desk and ring the desk bell to hire an agent for it.
6. Drop a card into the queue tray; rearrange the queue by moving its cards.
7. Ride the elevator by pressing its floor buttons; climb the ladder; slide down a fire pole.
8. Review a pull request at the PR board: read checks and the diff, then stamp it merged.
9. Look at a worker's changes, commit them and open a pull request.
10. Call a meeting about an issue at the meeting table, watch it run, and talk to any seated
    agent through its terminal.
11. Change every headset setting on the tablet.
12. Lose Wi-Fi or restart the laptop and carry on without a duplicated hire or prompt.

### 2.4 Out of scope for v1

| Excluded | Reason |
| --- | --- |
| Other people: avatars, presence, voice, chat, sharing | Removed product-wide (Track A) |
| Any microphone use, including dictation | No voice in v1; no `RECORD_AUDIO` |
| Mini-games: golf, basketball, arcade, BLOCKFALL, Minesweeper | Owner decision for v1 |
| Rooftop bar drinks, drunk effect, smoking, DJ, parachute jump | Leisure; later |
| TV media, wall decor editing, holiday themes | Leisure; the TV shows its idle screen |
| Hand tracking, passthrough, mixed reality | Controllers only, as today |
| Office policy editing: prompts, webhooks, Jira setup, projects directory, upgrades | Laptop page (headset protocol B-D6) |
| Embedded web browsing of worker services | URL and QR code, or Android's browser on request |

The roof, street and balcony exist as places you can visit. Their props are scenery in v1.

## 3. Platform and stack

### 3.1 Device

Samsung Galaxy XR on Android XR. **Existing** facts from the current app: the runtime advertises
60, 72 and 90 Hz and accepts a 90 Hz request; the recommended eye size is 1856×2160 and the
maximum 3152×3682; the controllers bind through the Oculus Touch interaction profile; eye-tracked
foveation works through the runtime with fine eye-tracking permission; the first foveation
profile a world swapchain receives sticks for that swapchain's life.

### 3.2 Engine and packages

Pin exact versions in `native/unity/Packages/manifest.json` and `packages-lock.json` at the
start of U0, using the newest patches that satisfy this table, and record them in the spike
report.

| Component | Version | Use |
| --- | --- | --- |
| Unity | 6.3, 6000.3.6f1 or a later patch | Android XR Extensions 1.3+ require at least 6000.3.6f1 |
| Universal Render Pipeline | Matching Unity | Android XR recommends URP; eye-tracked foveation requires URP |
| Graphics API | Vulkan only | Required for Unity's foveated rendering; matches the current app's Vulkan-only rule |
| XR Plug-in Management | Matching Unity | Loader |
| OpenXR Plugin (`com.unity.xr.openxr`) | 1.17.x | Touch controller profile, Foveated Rendering feature, Display Utilities (refresh rate), Composition Layer Support |
| Unity OpenXR: Android XR (`com.unity.xr.androidxr-openxr`) | 1.3.x | Android XR provider; Performance Metrics |
| Android XR Extensions for Unity | 1.4.0 | Session management, QR code tracking, Fine Eye, Recommended Settings, Battery State Display, Vulkan subsampling |
| XR Composition Layers (`com.unity.xr.compositionlayers`) | 2.x | Quad and cylinder layers for sharp text, if the spike selects them |
| XR Interaction Toolkit (`com.unity.xr.interaction.toolkit`) | 3.x | Interaction manager, poke, near-far, grab, climb, teleport, turn and move providers, haptics, tunneling vignette, XR Interaction Simulator |
| Input System | Matching Unity | Actions, keyboard |
| glTFast (`com.unity.cloud.gltfast`) and Draco (`com.unity.cloud.draco`) | Current | Import the existing Draco GLB props and the Blender pipeline output |
| Newtonsoft Json (`com.unity.nuget.newtonsoft-json`) | Current | Protocol parsing with optional and null fields |
| uGUI with TextMeshPro | Matching Unity | Tablet and panel text |
| Unity Test Framework | Matching Unity | EditMode and PlayMode tests |

Player settings: Android, ARM64 only, IL2CPP, minimum API 29 (matches the current app; OpenXR
needs at least 24), target API as high as the pinned Unity supports and at least 35, GameActivity,
HDR off, post-processing off, MSAA 4×, linear color space, multiview (single pass instanced).
OpenXR features: Oculus Touch Controller Profile, Foveated Rendering, Display Utilities,
Android XR session (with **Optimize Buffer Discards (Vulkan)** on), and Composition Layer
Support if U-D1 chooses layers. Hand Interaction, Hand Tracking and Palm Pose stay off.

### 3.3 What is custom and what comes from XR Interaction Toolkit

| From XRI | Custom on top |
| --- | --- |
| Interaction manager, interactor and interactable plumbing | Hand poser with authored grab poses |
| Poke interactor and poke filters | Physical buttons with travel, detent and backlight |
| Near-far interactor for pointing at distance | Gravity-glove fetch (section 8.4) |
| Grab interactable (velocity tracking) | Throw estimator and throw assist |
| Climb provider and climb interactables | Two-hand averaging, pole tangential turning (existing contract) |
| Teleportation, snap turn, continuous move and turn providers | Teleport validity for the office collision, head-in-wall fade |
| Haptic impulse player | Haptics catalogue (section 10.3) |
| Tunneling vignette | Comfort settings wiring |
| XR Interaction Simulator | Scripted interaction scenarios for PlayMode tests |

## 4. Architecture

### 4.1 Process and threads

```text
            laptop (droid-office)                      headset (Unity app)
 ┌────────────────────────────────────┐     ┌──────────────────────────────────────────────┐
 │ workers · PTYs · boards · queue     │     │ network thread: socket, TLS pin, frames     │
 │ floors · meetings · devices         │ ◄─► │ parse thread:   JSON → DTOs → store deltas   │
 │ HTTPS + WSS (bearer device token)   │     │ main thread:    apply deltas within budget   │
 └────────────────────────────────────┘     │                 world, workers, interaction  │
                                            │ render thread:  URP, multiview, foveation   │
                                            │ Android plugin: discovery, keystore, picker │
                                            └──────────────────────────────────────────────┘
```

- **Network thread.** Owns the WebSocket and HTTP client. Never touches Unity objects.
- **Parse thread.** Deserializes frames into generated DTOs and turns them into store deltas.
  Terminal grid deltas are decoded into compact cell arrays here.
- **Main thread.** Drains a bounded queue of deltas, spending at most 1.0 ms per frame on
  office data and at most 1.0 ms on terminal texture updates. Excess work waits for the next
  frame; ordering is preserved. Head and controller poses never wait on office data.
- **Render thread.** Unity's. No office work.
- **Android plugin.** Discovery, Keystore, document and photo pickers, opening URLs. Callbacks
  marshal to the main thread.

Steady-state frames allocate nothing on the managed heap. Parsing reuses buffers; the store
recycles DTO instances where it can.

### 4.2 Assemblies

| Assembly | Depends on | Contents |
| --- | --- | --- |
| `DroidOffice.Protocol` | none (no `UnityEngine`) | Generated DTOs (`Protocol.g.cs`), message table, prompt templates |
| `DroidOffice.Core` | Protocol | Store, pending operations, epochs, status predicates, coordinate conversion, terminal grid model |
| `DroidOffice.Net` | Core | Connection, pairing, reconnect, HTTP calls |
| `DroidOffice.Platform` | Core | C# side of the Android plugin; editor stubs |
| `DroidOffice.Settings` | Core | Local preferences, schema, migration |
| `DroidOffice.World` | Core, Settings | Layout anchors, floors, elevator, ladder, poles, rooms, lighting, audio zones |
| `DroidOffice.Workers` | World | Worker characters, animation, nameplates, laptops |
| `DroidOffice.Terminal` | Core, World | Terminal renderer, focus panel, keyboards |
| `DroidOffice.Interaction` | World, XRI | Rig, hands, grabs, pokes, fetch, throw, climb, locomotion, haptics |
| `DroidOffice.UI` | Interaction | Design system, tablet, panels, wrist display |
| `DroidOffice.Features.*` | the above | Boards, queue, hiring, PRs, changes, meetings, monitors, bookshelf |
| `DroidOffice.Diagnostics` | all | Performance HUD, capture, debug commands (debug builds only) |
| `DroidOffice.Editor` | all | Layout import, greybox builder, build script, capture tools |
| `*.Tests` | per assembly | EditMode and PlayMode tests |

`DroidOffice.Protocol` and `DroidOffice.Core` compile without Unity so their tests run fast in
EditMode and could run under plain .NET if needed.

### 4.3 The store

`OfficeStore` is the headset's only copy of office state.

- It applies `welcome` and `floor.enter` as atomic replacements and every other message as the
  replacement or delta the [protocol](headset-protocol.md#53-ordering-rules-existing-behavior-now-written-down) defines.
- It raises one event per topic per frame (workers, worker *id*, issues, pulls, queue, floors,
  meeting, changes, services, usage, limits, machine, connection), after applying all deltas of
  that frame, so a view never sees half a frame.
- Views read the store; only the store writes it. No view caches server state of its own.
- It tracks `epoch`, `serverId`, `layout` and `capabilities`.

### 4.4 Pending operations

Every consequential action creates a `PendingOp {rid, kind, epoch, startedAt, subject}` and
sends its message with `rid`.

- The view shows the pending state at once (the card in the agent's hand, the button lit, the
  elevator doors closing).
- `result.ok` completes it; `result.ok == false` reverses the local presentation and shows the
  reason in the world (section 11.6).
- No result after 15 s shows "No answer from the office yet" where the action happened, and
  keeps the presentation pending.
- After a reconnect, every pending op is resent with the **same** `rid`; the server's
  idempotency cache returns the original result without repeating the action.
- A result whose epoch is older than the current floor's completes its op silently.

### 4.5 Coordinates

The office uses three.js conventions: right-handed, metres, +Y up, floor at y = 0. Unity is
left-handed. `OfficeSpace` holds the one conversion:

```csharp
// Office (x, y, z, rotY) -> Unity. Mirrors Z; the glTF importer must agree (U0 check).
public static Vector3 ToUnity(double x, double y, double z) => new((float)x, (float)y, (float)-z);
public static Quaternion YawToUnity(double rotY) => Quaternion.Euler(0f, (float)(-rotY * Mathf.Rad2Deg), 0f);
```

The exact axis and sign are fixed in U0 by importing `macbook-base.glb` onto a desk anchor and
comparing with the browser. A golden test then places a desk, its laptop, the issues board and
the elevator and checks their facing. Nothing else in the codebase negates a coordinate.

## 5. Connecting

### 5.1 First run

The app opens in **the lobby**: a quiet, softly lit entrance hall, distinct from any office floor.

1. A wall screen lists offices found nearby (`_droidoffice._tcp`, existing discovery rules:
   generation-checked callbacks, at most 16 offices, 6 s resolve timeout, 8 s empty hint).
   Each row shows the laptop name and port.
2. **Enter an address** opens the poke keyboard for a manual origin.
3. Choosing an office starts pairing ([protocol section 4](headset-protocol.md#4-proposed-device-pairing-and-device-tokens)):
   - Code comparison: the screen shows six large digits and says "Check your laptop shows the
     same code, then press Allow there".
   - QR (when available): "Show the QR code from Settings → Devices on your laptop" and a framing
     guide.
4. On success the doors at the end of the hall open onto the elevator, which takes you to the
   floor the server's `arrival` names.

### 5.2 Every later run

- Auto-connect to the saved office using the stored token and pinned fingerprint. Show the
  lobby only if that fails.
- Target: from app launch to standing in the office in at most 8 s on a warm start with the
  laptop reachable (U7 measures it).
- The headset keeps showing the last known office while it reconnects, with the tablet and
  wrist showing "Reconnecting…" and office actions dimmed.

### 5.3 Failure states

| Situation | What the owner sees |
| --- | --- |
| Office unreachable | Lobby: "Can't reach *laptop name*. Is Droid Office running, and is the headset on the same Wi-Fi?" with **Try again** and **Choose another office** |
| Certificate changed | Lobby: "This office's identity changed. Pair again to trust it." Never connects silently. |
| `serverId` differs at a saved origin | Treated as a different office; the token is not sent |
| Token revoked (close 4001) | Lobby: "This headset was signed out from the laptop." and **Pair again** |
| Protocol unsupported (close 4400) | Lobby: "Update Droid Office on your laptop" or "Update this app", whichever side is older |
| Layout hash differs | Office loads; hires at unknown seats are disabled; tablet About shows the mismatch |
| Connection drops mid-session | World stays; reconnect with backoff 0.5 s doubling to 8 s; pending ops resend on reconnect |

### 5.4 Storage

- Token, origin, `serverId`, pinned SPKI fingerprint and office display name: encrypted with an
  `AndroidKeyStore` AES-GCM key, stored in app-private storage.
- Nothing secret in Unity `PlayerPrefs`, logs or crash reports.
- **Forget this office** on the tablet deletes all of it and returns to the lobby.

### 5.5 Networking library

The spike chooses between two implementations by the criteria below and records the result
(decision U-D2):

| Option | Notes |
| --- | --- |
| C# `ClientWebSocket` and `HttpClient` under IL2CPP | Must support custom upgrade headers, a certificate validation callback that pins SPKI for self-signed certificates, control-frame pong, and stable throughput on device |
| Android library with OkHttp | WebSocket with headers and pings built in; pinning through a custom `X509TrustManager` that accepts exactly the paired SPKI (or platform trust); C# receives frames through JNI |

Criteria: custom `Authorization` header on the upgrade; SPKI pinning for self-signed
certificates with no global trust change; WebSocket control ping and pong; at least 8 MB/s
sustained receive without main-thread work; reconnect without leaks; no TLS errors under IL2CPP
stripping.

## 6. The world

### 6.1 Layout parity, not pixel parity

The headset world uses the same layout as the browser so that the same seat IDs, floor
positions and arrival coordinates mean the same things. It does not have to look like the
browser. The layout comes from `office-layout.json`, exported from `src/shared/layout.ts`
([protocol section 10](headset-protocol.md#10-proposed-the-layout-contract)).

### 6.2 Building the office

1. **Greybox (U1).** `DroidOffice.Editor/OfficeBuilder` reads the layout JSON and generates the
   floor shell (36 × 26 m, `WALL_HEIGHT` 6.8 m, slabs, windows, exit door, balcony door), the
   loft and stairs, the meeting room, desks, beanbag anchors, kiosks, boards, the elevator shaft
   and car, ladder, poles and holes, the gong, coffee machine, bookshelf, machine monitor and
   seating, each as a prefab placeholder at its anchor, with colliders.
2. **Interaction sidecar.** Every anchor gets its gameplay component (desk, kiosk, board, button,
   climbable, seat) carrying the stable ID from the layout. Visual meshes never carry gameplay
   identity.
3. **Art (U6).** Authored prefabs replace placeholders one by one, keeping anchors, IDs and
   colliders. Sources: the existing GLB props (`src/client/public/props/`), the Blender
   generator (`tools/props/generate.py`) extended for new props, and new models.

### 6.3 Floors

- A building has up to 16 project floors, the roof and the empty lobby (`floor: null`).
- Only the current floor is fully live. The floors directly above and below exist as low-cost
  shells visible through the ladder hatch, pole holes and the elevator glass.
- Each floor uses the project's `palette` index for its accent colors, like the browser.
- Floor change: data binding switches when `floor.enter` arrives; geometry is already loaded
  because all office floors share one prefab set.

### 6.4 Lighting and look

- Art direction: the existing cartoon office (warm wood, soft daylight, robot workers), with
  clean shapes and strong silhouettes. Readability first.
- Static office lighting is baked (lightmaps, light probes for characters). One realtime
  directional light for the sun through the windows, no realtime shadows from it in v1 unless
  the budget allows.
- Time of day and weather come from `sky` (existing server state); they drive the skybox, window
  emission and the sun's direction and colour, blending baked "day" and "night" lightmap sets.
- No post-processing, no HDR, no screen-space effects.

### 6.5 Audio zones

Reverb zones per room (open office, meeting room, elevator car, stairwell, balcony, roof).
Ambience: soft HVAC, distant street through windows, rain when `sky` says so.

## 7. Agents

### 7.1 Presentation

Each `WorkerInfo` is a robot at its `deskId` seat. Its appearance comes from its `color` and a
stable hash of its `id` (body variant, accessory), so it looks the same every time.

| Status / state | Pose and animation | Desk lamp | Sound |
| --- | --- | --- | --- |
| `starting` | Arrives from the elevator, sits, opens laptop | `#8c8c8c` | Elevator ding, footsteps |
| `idle` | Sits back, small idle movements | `#5aa9e6` | None |
| `working` | Types; variation by `action`: `read` scrolls and leans in, `edit` types fast, `test` watches and taps, `web` reads a phone or second screen, `failing` frustrated gestures | `#f2b84b` | Quiet spatial typing |
| `needs_input` | Turns toward you, raises a hand | `#ef4444`, blinking | Spatial "ping" from the desk every 20 s until acknowledged |
| `done` | Celebrates once, then idles | `#3ccf91` | Chime |
| `exited`, `offline` | Head down on the desk, asleep | `#6c757d` | Soft snore when near |
| downed (`downedUntil`) | Section 7.4 | Heartbeat flash | Heartbeat |
| `lost` worktree | Looks under the desk, puzzled | Amber with a dark ring | None |

Colors are the existing `STATUS_BULB` values (`src/client/world/character.ts:1278`). Status is
never shown by color alone: the lamp also has a shape (steady ring, blinking ring, check, moon).

The seat nameplate shows the agent's name, the engine (`activeModel` and `activeEffort` win over
requested values) and, when present, its task title. The `task` card floats above the laptop
only when you look at the desk from within 4 m.

### 7.2 Reacting to you

- An agent you approach while it `needs_input` looks at you and gestures to its laptop.
- An agent handed a card reaches for it with an IK arm, takes it on contact, reads it, puts it
  down and starts typing when the server confirms (section 8.6).
- An agent that refuses a card shakes its head and holds it back out to you.

### 7.3 Hires and departures

- A new hire walks from the elevator to its seat (or appears seated if you are not on the
  floor when it starts).
- Sending an agent home: it closes its laptop, stands, walks to the elevator. Cleanup choices
  (keep, worktree, all) are made on the desk panel before it leaves (section 9.3).

### 7.4 The gun and revival (existing semantics)

The existing native app's gun and medic sequence stays, with its server semantics
(`worker.shoot` starts a persisted 30 s window; `worker.revive` cancels it; on expiry the server
dismisses the agent and deletes its owned worktrees and branches;
[controller interactions](vr-native-controller-interactions.md), [medic sequence](medic-sequence.md),
`gun-spec.md`). It ships in U6, behind a setting (**Gun: off by default**), because it is
destructive. Decision U-D7 confirms it belongs in v1.

- Draw from a back holster with grip; trigger fires; release in the holster to stow.
- The hit reaction plays at once; the server's `downedUntil` drives the heartbeat and lamp.
- Revive with a free hand's trigger at the body within the window.
- No dialog, countdown or toast appears; the world shows everything.
- **Blood** is a separate comfort setting (on by default when the gun is on).

## 8. Interaction model

### 8.1 Controller roles

These keep the existing contract ([controller interactions](vr-native-controller-interactions.md))
except where marked **changed**.

| Control | Action |
| --- | --- |
| Left Menu | **Changed:** bring the tablet to your left hand, or put it away |
| Right Menu | Android XR system; never bound |
| Left stick | Smooth movement when enabled; click and hold to sprint |
| Right stick left / right | Snap or smooth turn |
| Right stick forward, release | Aim and commit a teleport (also with smooth movement on) |
| X | Teleport to the next waiting agent's desk |
| Y | Open the tablet on Find |
| A | Jump (setting; on by default) |
| B | Back one step on the tablet or a panel; with a card in hand, send it back to its board |
| Trigger | Use: press what you point at, use a held object, fire a held gun |
| Grip | Grab, hold, release; with nothing in reach, fetch what you point at (section 8.4) |

Left-handed mode swaps every stick and face-button role between hands; the Menu buttons stay
where Android XR puts them. Movement and turning keep their hands if one controller disconnects.
Grip never navigates a menu. No text anywhere names a control.

### 8.2 Hands

- Hands are drawn as gloves, not controller models (decision U-D5), posed from the controller:
  grip curls the last three fingers, trigger curls the index finger, and capacitive touch (if
  Galaxy XR reports it through the Touch profile, checked in U0) lifts the thumb and index.
- **Near a pokeable**, the hand forms a pointing pose automatically while the trigger is
  released.
- **Grabbing** snaps the glove to the object's authored grab pose (for example, a card pinched
  between thumb and index, a mug by its handle, the tablet by its edge).
- **Solid world.** The drawn hand stops at desks, walls and buttons (a swept proxy follows the
  tracked hand and slides along surfaces). When the tracked controller is more than 6 cm inside
  geometry, a faint ghost glove shows where the real hand is.
- **Tracking.** Physical gestures require a tracked grip pose, a valid head pose, fresh samples
  and bounded pose changes. On tracking loss or a focus change, held interactions are cancelled
  or reanchored and stale presses are suppressed (existing contract).

### 8.3 Grabbing and placing

- Grip near a grabbable within 8 cm of the palm grabs it. With several in reach, the nearest to
  the palm centre along the fingers' direction wins.
- Held objects follow the hand at display rate; heavy objects (the tablet, a mug) lag slightly
  in rotation for weight.
- Releasing over a valid surface lands the object flat with a short settle; over nothing it
  falls with physics.
- Objects never pass through the hand that holds them or through world colliders while held.

### 8.4 Fetching at a distance

The signature interaction, after Alyx's gravity gloves:

1. Point at an object up to 6 m away with an empty hand. Fetchable objects (issue and PR cards,
   queue cards, books, mugs, the tablet) inside a 6° cone around the hand's aim get a soft
   outline; the best candidate gets a stronger one and a faint tick.
2. Hold grip. The candidate locks, outline brightens, and the glove forms a "ready" pose.
3. Flick the wrist toward you: angular velocity above 4 rad/s toward the body, or linear
   velocity above 1.2 m/s toward the head, within 0.3 s.
4. The object leaves its place (a card pops its pin) and flies a ballistic arc to arrive at the
   hand in 0.45 to 0.7 s. If grip is still held when it arrives, the hand catches it; otherwise
   it lands near your feet.
5. Releasing grip before the flick cancels without moving anything.

Thresholds are tuning starting points, adjusted in U3 playtests and recorded in this document.

### 8.5 Throwing

Release velocity is the controller's linear velocity averaged over the last 4 tracked samples
(about 45 ms at 90 Hz) plus the angular velocity's contribution at the object's grab offset.
Throw assist bends a throw toward a valid target (the queue tray, an agent's hands, a desk)
when the target lies within 10° of the throw direction and within its natural range. A card
thrown at an agent counts as a handoff only if the agent catches it (it reaches out when a card
comes toward it).

### 8.6 Handing a card to an agent

The core loop. Applies to issue cards and Jira cards (Jira uses `ticketPrompt` and never a
numeric `issue`).

1. Hold a card near an agent's hands (within 0.35 m) or over its desk.
2. The agent's eligibility is local and immediate, using the existing rules
   (`main.ts:cantTakeCard`, 4199–4206):

   | Agent state | Agent's reaction | Card back says |
   | --- | --- | --- |
   | Downed | No reaction | *name* is down |
   | Shell | Shakes head | *name* is a shell, not an agent |
   | Lost worktree | Shrugs, points under the desk | *name*'s worktree was deleted |
   | Asleep | Stays asleep | *name* is asleep |
   | Needs input | Points at its laptop | *name* is waiting on an answer |
   | Otherwise | Reaches out | (nothing) |

3. Releasing into a reaching hand sends `worker.prompt {workerId, prompt: issuePrompt(card), issue}`
   with a `rid`; the agent holds the card.
4. On `result.ok` the agent reads the card, sets it down beside its laptop and starts typing;
   the board removes the card (the server's `gh.issues` refresh confirms).
5. On failure the agent hands the card back to you; the card's back shows the reason.
6. B with a card in hand sends it back to its board (it flies to its pin).

### 8.7 Pressing

- Buttons have physical travel (4 to 6 mm), actuate at 70% of travel, and click: a tick haptic
  (section 10.3), a click sound and a backlight change, on the same frame.
- A button never actuates from a ray; it must be touched. Panels on the tablet may also be
  pressed by pointing and pulling the trigger, for comfort (setting **Point and click on
  panels**, on by default).
- Holding to confirm: destructive or consequential buttons (merge, discard all, close issue,
  send home with cleanup, remove a floor) fill a ring over 0.8 s and actuate only when it
  completes; releasing early cancels with a soft "tock".

### 8.8 Climbing and poles (existing contract)

- Ladder: grip a rung or rail; pull down to climb up; two held hands average their motion;
  alternating hands keeps the remaining grip; still hands do not move; motion comes from
  tracking-space hand deltas so the rig's movement does not feed back; reanchor after tracking
  loss; an already committed floor arrival finishes. Crossing a floor sends `floor.go`.
- Fire pole: grip near the pole; slide with gravity; tangential hand motion turns the body; the
  head is never spun; releasing steps off at the next available floor or lands on the mat.
- No auto-grab by walking into a pole hole.

## 9. Places and what they do

Each subsection lists the affordances, the server messages, and the feedback. "Result" means the
`result` reply ([protocol section 6](headset-protocol.md#6-proposed-results-idempotency-and-floor-epochs)).

### 9.1 Desks and laptops

| Affordance | Interaction | Server |
| --- | --- | --- |
| Laptop screen | Always shows the overview terminal (4 Hz `screen` feed) when within 6 m; a dim status card beyond | `screen` |
| Open the terminal | Touch the laptop's trackpad, or point and trigger | `worker.attach {format: 'grid'}` |
| Wake an asleep agent | Tap its shoulder | `worker.resume` with result; it lifts its head |
| Desk panel | A small angled panel on the desk edge, shown when you stand at the desk: Prompt, Changes, PR, Send home | Below |
| Prompt | Opens the keyboard with a prompt field; Send | `worker.prompt` |
| Changes | Section 9.10 | `changes.*` |
| Pull request | "Open pull request" or "View #N" | `worker.pr` |
| Send home | Hold to confirm, after choosing cleanup if it has a worktree (`worker.worktree` first; Keep, Remove worktree, Remove worktree and branch) | `worker.kill` |
| Rebuild a lost worktree | Shown instead of Prompt when `lost` | `worker.rebuild` |
| Attach a picture | Paperclip on the desk panel; Android photo picker | `POST /api/term/drop`, then the escaped path is typed into the terminal, never run |

### 9.2 Terminals

**Overview.** Every laptop renders its terminal with the same renderer as the focused view,
from the 4 Hz overview feed. Beyond 6 m it shows only the status card.

**Focused terminal.** Opening a laptop lifts its screen into a floating monitor above the desk,
facing you at the **Terminal distance** setting (default 0.9 m), about 0.9 m wide.

- Grab its frame to move it; grab both sides to resize. It stays anchored to that desk.
- Up to three focused terminals can be open; opening a fourth closes the oldest.
- Walking more than 6 m away folds it back into the laptop and detaches.
- Scroll: grab the text and drag, or push the right stick while pointing at it. Scrolling past
  the top pages history with `term.history`.
- Resizing the panel changes columns and rows locally; the PTY is resized (`term.resize`) only
  when you type into it, and only to the panel's size, clamped to 20–400 columns and 5–200 rows.
- The title bar shows the agent's name, engine, branch and status lamp, plus Close.

**Input.**

| Method | Use |
| --- | --- |
| Paired Bluetooth keyboard | Primary. Keys go to the focused terminal; Enter and modified Enter follow `src/client/term-keys.ts`; paste is bracketed when the grid's `bracketedPaste` mode is on |
| Quick-answer pad | Always under the focused terminal: 1, 2, 3, y, n, Enter, Esc, Tab, arrows, Ctrl-C. Big physical keys for the answers agents usually need |
| Poke keyboard | Full layout on a tray below the terminal, pressed with fingertips; for short prompts without a paired keyboard |

Keyboard focus is explicit: the focused terminal has a lit border; typing never goes anywhere
else; a paired keyboard's keys never move the player.

**Rendering (decision U-D1).** One draw call per terminal:

- A cell texture (`cols × rows`) holds, per cell, a glyph index, foreground and background
  colours and flags. A delta updates only changed rows on the CPU copy; the GPU texture uploads
  once per frame at most.
- A glyph atlas holds Geist Mono and the bundled Droid Office Terminal Symbols font
  (`src/client/public/fonts/`, OFL), pre-generated as a multi-channel signed distance field for
  ASCII, Latin-1, box drawing, block elements, powerline and the symbols set. Other graphemes
  (CJK, emoji) go to a dynamic atlas rasterized on first use.
- A panel shader computes each pixel's cell, samples the atlas and colours it; wide graphemes
  span two cells; cursor and selection are shader overlays.
- The panel is drawn either in the eye buffer or into a texture shown on an OpenXR quad
  composition layer, whichever U0 shows is sharper at reading distance without breaking hand
  occlusion. A composition layer cannot be depth-tested against hands; if chosen, it is
  submitted as an underlay with a hole cut in the world layer, as the existing native app does
  (`PanelCutout`).

Theme: the existing terminal palette ([protocol section 7.2](headset-protocol.md#72-terminals)).

### 9.3 Empty desks and hiring

An empty desk shows a small hiring kiosk on its surface and a brass desk bell.

1. The kiosk shows the remembered engine for this desk (provider, model, effort, worktree),
   from the last hire here, or the office default (`prompts.agent`).
2. Large tiles change the provider; steppers change model and effort (from the model catalogues,
   [protocol 7.1](headset-protocol.md#71-workers)); a switch sets **Own worktree**.
3. Put a card on the desk to give the new agent that task (the prompt is `issuePrompt(card)`),
   or type a prompt on the keyboard, or leave it empty.
4. **Ring the bell.** `worker.spawn` goes out with a `rid`; the bell's ring and a haptic thump
   happen at once; the elevator dings as the agent arrives.
5. A hire refused (budget spent, office full, seat taken) shows its reason on the kiosk; the card
   stays on the desk.

Beanbags appear when the office needs overflow seats, as in the browser (`beanbagsOut`). Kiosk
(station) agents are hired by asking them: section 9.6.

### 9.4 Boards

The issues board and the pulls board are cork boards; the queue board is a whiteboard with a
tray. Jira, when the floor has an epic, is a tab on the issues board.

- **Cards** are paper, pinned. Each shows number, title, labels as coloured tape and assignees'
  initials. Like the browser's board (at most 15 notes), it shows a bounded set; a **More** pin
  flips pages.
- **Reading a card.** Hold it: the front shows the title and labels; turn your wrist to read
  the back, which shows the body's first lines and comment count. Hold it close (under 30 cm)
  to open the full issue on a reading panel beside it (`GET /api/gh/issue`).
- **Filters.** A row of label pins on the board's frame; touching one filters the cards.
- **Refresh.** A small lever on the frame (`gh.refresh`), which shows a spinner while
  `loading`.
- **Comment, label, close.** On the reading panel: Comment (keyboard), Labels (chips), Close
  (hold to confirm, reason Completed or Not planned). All use results.

### 9.5 The queue

- The **task tray** below the queue board: drop a card in to queue it (`queue.add` with the
  remembered engine for the queue, `title: "#N title"`). Duplicate issues are refused with the
  card bouncing back.
- Queued tasks hang on the board as cards in order; running tasks show the agent's name;
  finished tasks show the outcome and PR.
- Move a queued card up or down by grabbing it and placing it between others (`queue.move`,
  one position per placement step).
- Remove a queued or finished task by dropping it into the **shredder** beside the board
  (`queue.remove`). The shredder never closes an issue.
- **Retry** and **Clear finished** are buttons on the board's frame. **Parallel agents** is a
  physical dial (0 to 28, 0 pauses) (`queue.limit`).

### 9.6 Kiosk agents

The three kiosks (`station-issues`, `station-pulls`, `station-queue`) have agents who manage
their boards. Walk up and touch the kiosk's screen to talk: the keyboard opens with a prompt
field; Send uses `station.prompt`. The agent's terminal opens like a desk terminal.

### 9.7 The elevator

The elevator is how you change floors.

- **Hall:** a call button beside the doors. The car is always at your floor (single owner), so
  pressing it opens the doors.
- **Car panel:** a column of round brass buttons, 30 mm across, one per floor (two columns
  above 8 floors), each engraved with the floor number and the project's name, plus **R** for
  the roof, door open and door close. The current floor's button is lit.
- **Travel:**
  1. Pressing a floor button lights it, clicks, and sends `floor.go` with a `rid`.
  2. Doors close over 1.2 s; the car's display shows the destination.
  3. The car travels for at least 2.0 s (a gentle, constant-speed ride; see Comfort).
  4. Doors open when the travel time has passed **and** `floor.enter` has been applied **and**
     the new floor is ready.
  5. If no result arrives within 10 s, or the result fails, the button blinks red, the display
     shows why, and the doors reopen on the floor you left.
- **Adding a floor:** a small **+** plate under the buttons opens a list of laptop checkouts on
  the car's display (`floor.repos`), and choosing one adds it (`floor.add`).
- **Removing a floor:** tablet only, hold to confirm.

### 9.8 Ladder, hatch and poles

As section 8.8. Each floor's ladder goes through a hatch in the ceiling to the floor above and
to the roof from the top floor. Two poles drop through every floor to the ground floor's mat.

### 9.9 The PR board and the stamp station

- PR cards show number, title, author, branch, checks as a coloured strip (pass, fail, pending,
  none), review decision, additions and deletions, and draft state.
- Holding a PR card close opens its reading panel: description, checks with links, reviews,
  review comments by file and line, and **Diff** (`GET /api/gh/pull/diff`), a scrollable
  monospace panel using the terminal renderer.
- **The stamp station** beside the board has three stamps on a rack: **Squash**, **Merge**,
  **Rebase**, showing only the methods the repository allows (`GhRepoInfo.methods`).
  - Put the PR card on the stamp pad, pick up a stamp and press it onto the card. A ring fills
    while you hold it down (0.8 s); completing it merges (`gh.merge`, **Delete branch** switch
    on the pad, default on).
  - With failing or pending checks the pad shows the state; stamping still works but needs a
    second, deliberate press after the warning (no silent override).
  - Success: ink, a satisfying thunk, the gong rings when the server's `gong {why: 'merged'}`
    arrives, and the card leaves the board.
- **Call a review meeting:** put the PR card on the meeting table (section 9.11).
- **Comment, label, close** as for issues.

### 9.10 Changes

At a worker's desk panel, **Changes** opens a clipboard on the desk (`changes.watch`; closing it
sends `changes.unwatch`):

- Files listed with status letters and +/− counts; repository tabs for multi-repository workers.
- Touch a file to see its diff on a reading panel (`changes.diff`); pictures show old and new
  side by side (`GET /api/changes/file`).
- **Commit**: message on the keyboard, then press (`changes.commit`).
- **Discard** a file: hold to confirm. **Discard all**: hold to confirm, then a second hold on a
  red button that says how many files will be lost.
- **Open pull request**: title and body on the keyboard (`changes.pr`).

### 9.11 The meeting room

- **Calling a meeting:** the table console. Choose a pattern on large tiles (Debate, Lead,
  Map-reduce, Red/blue, Review), seats (steppers within the pattern's limits), rounds, budget and
  output path; or put an issue or PR card on the table to preset it (`issue.meeting` prompt, or
  the review pattern for a PR). Start with a hold (`meeting.start`).
- **During:** seated agents work; the whiteboard shows the round, each seat's role and state, the
  token budget and the notes preview. Touch a seat's place card to open that agent's terminal at
  the table and talk to it.
- **Stop** and **Clear the table** on the console (hold to confirm for Clear, which sends the
  agents home).
- **Speaking to the meeting** (`meeting.say`) arrives when the server capability exists
  ([protocol section 9](headset-protocol.md#9-proposed-the-owner-speaks-at-a-meeting)): the
  console gains a **Say** field, and owner lines appear on the whiteboard.

### 9.12 Monitors

- **Machine monitor:** CPU, memory, pressure history, worker count and the machine limit (a dial
  for `machine.limit`).
- **Limits:** Claude plan windows and DroidProxy accounts as bars with reset times; a physical
  refresh key (`proxy.refresh`, `limits.refresh`).
- **Spend:** today's and total usage; unknown cost shows "unknown", never $0.

### 9.13 Services board

Worker web services as cards: port, command, worker. Touching one shows its URL and a QR code;
**Open on headset** opens Android's browser after a confirmation.

### 9.14 Bookshelf

The project's docs (`GET /api/docs`) as books. Pull one out to open it as a two-page spread;
turn pages by grabbing the corner or swiping. Markdown renders with headings, lists, code blocks,
tables and images (`/api/docs/picture`). Links to other docs open those books.

### 9.15 Gong and coffee

- **Gong:** strike it with the mallet from its stand, or with your hand; loudness follows strike
  speed; a resting hand does not ring it; moving away rearms it (existing physical rules). The
  strike is local. Server `gong` events (`merged`, `queue`) ring it on their own.
- **Coffee:** take a mug, put it under the machine, press its button, watch it fill; drink by
  lifting it to your mouth (sip sound, the mug empties over sips). Caffeine gives the existing
  speed and jump boost for its duration when the setting allows. Decision U-D8 confirms coffee
  in v1.

## 10. Feedback

### 10.1 Rules

- Every interaction gives visual, audio and haptic feedback on the frame it happens.
- The world answers before any menu does: a refused card is handed back, a failed floor button
  blinks red, a refused hire shows on the kiosk.
- A server failure is explained where it happened, in plain words, once. No toast stacks.

### 10.2 Sound

All sounds are spatial at their source, except tablet UI sounds, which come from the tablet.

| Event | Sound |
| --- | --- |
| Hover tick (fetch candidate, button under finger) | Very soft tick |
| Button press, release | Mechanical click, lighter release |
| Hold-to-confirm fill, complete, cancel | Rising tone, solid thunk, soft tock |
| Card off pin, card handed over, card in tray | Pin pop, paper rustle, paper slide |
| Agent needs you | Two-note ping from its desk, every 20 s until you open its terminal |
| Agent done | Short chime |
| Agent working | Quiet keyboard typing, within 4 m |
| Elevator | Door motor, ding at arrival, soft hum while moving |
| Ladder, pole | Rung clank per hand, slide hiss |
| Gong | Gong, loudness by strike speed |
| Stamp | Inked thunk |
| Teleport | Soft whoosh |
| Error at an object | Low double buzz |

### 10.3 Haptics

Amplitude 0 to 1, duration in milliseconds; scaled by the **Haptics strength** setting. Frequency
is left to the runtime.

| Event | Amplitude | Duration |
| --- | --- | --- |
| Hover tick | 0.10 | 8 |
| Grab | 0.35 | 20 |
| Release | 0.15 | 12 |
| Button actuation | 0.45 | 15 |
| Hold-to-confirm complete | 0.70 | 40 |
| Fetch lock | 0.20 | 15 |
| Fetch catch | 0.50 | 30 |
| Ladder rung grab | 0.40 | 18 |
| Pole slide | 0.12 continuous | while sliding |
| Gong strike | 0.3 to 1.0 by speed | 60 |
| Gun shot (existing) | 1.00 | 70 |
| Error at an object | 0.30, twice | 25 each, 60 apart |
| Agent heartbeat near the body (existing) | per beat | per beat |

## 11. The tablet and menus

### 11.1 The tablet

The tablet is the main menu: a physical device about 26 × 18 cm with a rounded aluminium frame.

- **Left Menu** brings it to your left hand (it flies from its holster on your left hip); Left
  Menu again, or putting it back to the hip, stows it.
- You can hold it in either hand, put it down on any surface, or lean it against something. It
  stays where you put it, per floor, until you call it again.
- Poke it with the other hand's index finger, or point and pull the trigger (setting).
- It faces you as you hold it naturally; text is sized for 35 to 45 cm away.

### 11.2 Pages

| Page | Contents |
| --- | --- |
| **Home** | Waiting agents (go to, open terminal), this floor's agents with status, the floors list (go to), spend today, connection state |
| **Find** | Search field (keyboard) and live results: agents, issues, pulls, queue tasks, floors, terminal text (`/api/search`); choosing a result takes you there with a fade |
| **Settings** | Section 12 |
| **Office** | Connected office name, laptop, server version, protocol, latency; Forget this office; Pair again; Devices note ("Manage devices on your laptop") |
| **About** | App version, Unity and package versions, layout version and hash, licences |

Home is the default. **B** goes back one step; the page header has a back arrow and the page
title. Pages never nest more than two levels.

### 11.3 The back of your hand

The back of the left glove shows a small display: the number of waiting agents (a red dot when
any), today's spend, and a Wi-Fi mark when reconnecting. Turning your palm toward you hides it.

### 11.4 Panels in the world

Desk panels, the hiring kiosk, reading panels, the stamp pad, the meeting console and the car
display follow the same design system as the tablet. A panel appears at the object it belongs to,
angled to face a standing owner, and never follows your head.

### 11.5 Design system

| Element | Rule |
| --- | --- |
| Type | Geist for text, Geist Mono for numbers, identifiers and terminals (bundled, OFL) |
| Text size | Measured in angular height at the intended distance: body text cap height at least 0.4°, secondary at least 0.32°, titles 0.6° or more; validated on device in U4 |
| Contrast | Body text at least 7:1 against its panel; secondary at least 4.5:1 |
| Colour | Neutral panels (warm off-white or deep graphite by context), one accent per floor from its palette, status colours only for status; amber is the `working` status only, never a warning (warnings use red with an icon) |
| Targets | Poke targets at least 22 mm across with 6 mm gaps; ray targets at least 1.6° |
| States | Every control has rest, hover, pressed, disabled and pending states, plus focus for keyboard fields |
| Motion | Panels open in 180 ms with ease-out, close in 120 ms; nothing bounces; **Reduce motion** removes all non-essential motion |
| Layout | 8 mm grid on tablet pages; consistent page header, content, action row; no large empty regions |
| Copy | Sentence case; verbs on buttons; say what happens, not how; never name a controller button; never show identifiers, timestamps in milliseconds or raw errors |
| Empty, loading, error states | Every list and panel has all three, designed |
| Icons | One icon set, filled at rest, outlined disabled; always with a label on first use |

### 11.6 Messages

- **Where:** at the object. A refused card says why on its back; a hire problem shows on the
  kiosk; a floor problem on the car display. Only office-wide problems (connection, protocol,
  layout mismatch) use the tablet.
- **How:** one plain sentence, what happened and what to do. "*Ada* is asleep. Tap her shoulder
  to wake her." Not "Error: worker offline".
- **Server toasts** that duplicate a result are not sent to the headset
  ([protocol 6.1](headset-protocol.md#61-results)); the rest show as a small card that floats up
  at the related desk (or on the tablet's Home if none) and fades after 6 s.

### 11.7 Known failures to avoid

A design review of the current APK's settings panel (2026-10-01 screenshot) found: debug-like
text, missing comfort settings, amber used ambiguously, inconsistent button styles and large
empty regions. Each review in section 16 checks for these explicitly.

## 12. Settings

All headset settings live in the app, never on the server. The tablet's **Settings** page has
these sections. Defaults keep the existing app's values (**existing** where marked).

| Section | Setting | Default | Range / choices |
| --- | --- | --- | --- |
| Movement | Smooth movement | Off (**existing**) | Off, On |
| | Movement direction | Head (**existing**) | Head, Left hand |
| | Movement speed | 2.5 m/s | 1.0 to 4.6 m/s (the existing app glides at 4.6 m/s, the desktop walk speed; the lower default is for comfort, decision U-D10) |
| | Sprint | On (**existing**) | Off, On: left stick click held moves 1.6× faster (existing 7.5 m/s against 4.6) |
| | Turning | Snap (**existing**) | Snap, Smooth |
| | Snap angle | 45° (**existing**) | 30°, 45°, 60°, 90° |
| | Smooth turn speed | 90°/s (**existing**) | 30 to 180°/s |
| | Fade on teleport | On (**existing**) | Off, On |
| | Jump | On | Off, On |
| Comfort | Vignette while moving | Medium | Off, Low, Medium, High |
| | Elevator view | Glass | Glass, Frosted while moving |
| | Reduce motion | Off | Off, On |
| | Fade when head enters walls | On | Off, On |
| | Seated mode | Off | Off, On (raises the view to standing eye height) |
| | Gun | Off | Off, On (section 7.4) |
| | Blood | On | Off, On (only when Gun is on) |
| | Caffeine effects | On | Off, On |
| Body | Height | 175 cm (**existing**) | 120 to 220 cm |
| | Floor offset | 0 m (**existing**) | −2.5 to +2.5 m |
| | Calibrate | | "Stand straight, look ahead, press" sets height from the tracked head |
| | Dominant hand | Right | Right, Left (left-handed mode) |
| Hands | Point and click on panels | On | Off, On |
| | Haptics strength | 100% | 0 to 100% |
| | Show the back-of-hand display | On | Off, On |
| Terminals | Text size | Medium | Small, Medium, Large, Extra large |
| | Terminal distance | 0.9 m | 0.6 to 1.5 m |
| | Cursor blink | On | Off, On |
| Sound | Effects volume | 70% (**existing**) | 0 to 100%, mute |
| | Ambience volume | 50% | 0 to 100%, mute |
| | Agents need you ping | On | Off, On |
| Graphics | Render scale | 1.0 (**existing**) | 0.75 to 2.0, bounded by runtime and Vulkan limits |
| | Foveation | Medium (**existing**) | Off, Low, Medium, High |
| | Refresh rate | 90 Hz | 72 Hz, 90 Hz (a request; the actual rate is shown) |
| | Performance overlay | Off (**existing**) | Off, On |

Rules:

- Each row shows what is **requested** and, for graphics, what is **actually applied** (bound
  eye size, foveation level, refresh rate), like the current APK.
- Changing a value applies at once; nothing needs a restart unless the spike shows a foveation
  change cannot apply live on Galaxy XR, in which case the row says "Applies when you next open
  the app".
- Settings are saved off the main thread to `settings.json` in app-private storage (write to a
  temporary file, then rename), with a `schema` number and a migration step per version.
- **Reset this section** at the bottom of each section, with confirmation.

## 13. Locomotion and comfort

- **Teleport** (default): right stick forward shows an arc (6 m/s launch, gravity 9.8 m/s², the
  existing WebXR arc) ending in a floor marker with facing; release commits. Invalid targets show
  a red marker and do nothing. Teleport fades through black over 120 ms when Fade is on.
- **Smooth movement:** left stick, with the tunneling vignette per setting; collision slides along
  walls; stairs and the loft ramp are walkable.
- **Turning:** right stick left and right; snap (default 45°) or smooth.
- **Room scale:** the player capsule follows the head; walking physically into a wall stops the
  capsule; the head entering geometry fades the view to black (setting) and back when it leaves.
- **Elevator:** the car moves at a constant speed with gentle ease in and out; the car interior
  is stable, so vection is small; **Frosted while moving** hides the shaft view entirely.
- **Height:** the rig's floor follows Height and Floor offset; head tracking stays 1:1 and is
  never smoothed or predicted by the app.
- **Next waiting agent (X):** fade, then stand in front of that agent's desk, facing it.

## 14. Performance

### 14.1 Budgets at 90 Hz (11.1 ms per frame)

| Budget | Target |
| --- | --- |
| Main thread (scripts, physics, interaction, store apply) | at most 5.5 ms |
| Render thread | at most 5.5 ms |
| GPU at the recommended eye size, Medium foveation | at most 9.0 ms |
| Office data apply | at most 1.0 ms per frame |
| Terminal texture updates | at most 1.0 ms per frame |
| Managed allocations in steady state | 0 bytes per frame |
| Draw calls (multiview, both eyes) | at most 150 in the busiest view |
| Visible triangles | at most 350,000 |
| Texture memory | at most 600 MB |
| Floor change | no frame longer than 22 ms, all loading behind the elevator doors |
| Warm start to office | at most 8 s |

### 14.2 How

- Static batching and GPU instancing for desks, chairs, plants and repeated props; one material
  atlas per prop family.
- Baked lighting; light probes for characters; no realtime shadows by default.
- Agent characters with two LODs; animation culling beyond 15 m.
- Terminals: one draw each (section 9.2); overview terminals stop updating beyond 6 m.
- Occlusion culling baked per floor.
- Unity's Foveated Rendering feature with gaze allowed (`XRDisplaySubsystem.foveatedRenderingLevel`
  and `foveatedRenderingFlags`), mapped from Off, Low, Medium and High; the eye-tracking permission
  is requested at first launch; when it is missing, foveation reports "Needs eye tracking
  permission" and does not silently fall back to fixed foveation.
- Vulkan subsampling (Android XR Extensions session setting) if U0 shows it helps.
- Application SpaceWarp is not used; it is evaluated only if U7 cannot hold 90 Hz otherwise,
  because reprojection artifacts hurt text.
- Refresh: request 90 Hz through Display Utilities at start, on focus and after a drop; poll the
  actual rate once per second; retry with backoff capped at one request per 30 s (**existing**
  policy). The owner accepts ordinary thermal throttling; the app never pauses to cool down.

### 14.3 Measurement

Every performance claim states: build, device, refresh rate actually reported, eye size and
foveation actually bound, scene (floor, number of agents and their states, terminals open),
duration, missed frames, CPU and GPU frame times, draw calls, triangles and memory. Acceptance
runs are focused 1 to 2 minute captures of a **populated** office (at least 12 agents, at least
6 working, 2 focused terminals updating), with the tablet open and closed. Compositor FPS alone
never counts.

## 15. Android packaging and release

### 15.1 Identity

- **Development:** application ID `dev.droidoffice.xr.unity`, so the Unity app installs beside the
  current APK with separate data.
- **Release (U8):** application ID `dev.droidoffice.xr`, the existing package, signed with the
  existing key and lineage, with a version code above the last WebView release, so it installs
  over the current app as an update.

### 15.2 Manifest

| Entry | Value |
| --- | --- |
| Permissions | `INTERNET`, `android.permission.EYE_TRACKING_FINE`, `VIBRATE` if Unity's haptics path needs it, plus whatever QR tracking needs if U0 adopts it |
| Not requested | `RECORD_AUDIO` (neither the current app nor this one uses the microphone), hand tracking, storage (pickers use the system photo and document pickers) |
| Features | `android.software.xr.api.openxr` and `android.hardware.xr.input.controller` required; `android.hardware.xr.input.eye_tracking` not required at install but needed for foveation. The current app's `glEsVersion` requirement is dropped |
| XR properties | `PROPERTY_XR_ACTIVITY_START_MODE` = `XR_ACTIVITY_START_MODE_FULL_SPACE_UNMANAGED` and `PROPERTY_XR_BOUNDARY_TYPE_RECOMMENDED` = `XR_BOUNDARY_TYPE_LARGE`, as the current app; checked against what Unity's Android XR build writes in U0 |
| Backup | `allowBackup="false"`, as today (tokens must not leave the device) |
| Network security | HTTPS for everything once paired; cleartext only to show an HTTP office's "start with `--self-signed`" message |

### 15.3 Signing

Unity's built-in signing cannot apply the existing proof-of-rotation lineage. The build produces
an unsigned (or debug-signed) APK; `native/unity/build-release.sh VERSION [VERSION_CODE]` then
aligns with `zipalign -P 16`, signs with `apksigner` using the private signing material outside
the repository and the lineage file, verifies with `apksigner verify -Werr`, checks alignment and
writes a SHA-256 checksum, exactly as `native/android/build-release.sh` does today. The version
code defaults to `git rev-list --count HEAD`, which keeps it monotonic across both apps.

### 15.4 Migrating from the current app

Installing the Unity release over the current app keeps app-private storage.

| Old data | Where it is | Migration |
| --- | --- | --- |
| Saved office origin and name | `OfficeActivity` shared preferences (`server`, `server_name`) | Read once by the Android plugin; offered on the lobby as "Reconnect to *name*", then pairing |
| Graphics settings | `files/native-graphics.json` | Read once: render scale, foveation, performance overlay |
| Height, floor offset, movement, terminal font | WebView localStorage | Not migrated (no privileged JavaScript bridge exists or will be added). First run asks for a height calibration; other settings take their defaults |
| Session cookie | WebView cookie store | Not used; the headset pairs once |

After migration the old files stay untouched until Track D removes their readers.

### 15.5 Build and CI

- Project at `native/unity/` with visible meta files and force-text serialization.
- `native/unity/build.sh` runs Unity in batch mode (`-executeMethod DroidOffice.Editor.Build.Android`)
  and then the release script for signed builds. The Unity editor path comes from an environment
  variable; `.env.example` documents it in the same change, as the root `AGENTS.md` requires.
- `.gitignore` adds `native/unity/{Library,Temp,Obj,Build,Builds,Logs,UserSettings,MemoryCaptures}/`.
- Large binary art (models, textures, audio) uses Git LFS under `native/unity/Assets/Art/**`
  (decision U-D3); code, scenes, prefabs and JSON stay in plain git.
- CI (decision U-D4): EditMode tests and a debug APK build run in `.github/workflows/release.yml`
  as new steps when a Unity licence secret is available; until then the build and tests run
  locally and each change records what ran. `native/**` is already in both path filters.

## 16. The design review loop

Every surface the owner sees goes through this loop before its milestone closes. The aim is a
surface that would ship in a top-tier VR game, judged by someone other than its builder.

### 16.1 Surfaces

Tablet Home, Find, each Settings section, Office, About; the back-of-hand display; the lobby and
pairing; the focused terminal with its pads and keyboard; the desk panel; the hiring kiosk; issue
and PR cards (front, back, reading panel); the stamp station; the queue board and tray; the
elevator car panel and display; the meeting console and whiteboard; the monitors; the changes
clipboard; the bookshelf reader; object messages.

### 16.2 Captures

For each surface, in each of its states (rest, hover, pressed, pending, success, error, empty,
loading, longest realistic content):

1. **Device capture:** `adb exec-out screencap -p` on the headset, plus the debug build's
   `capture` command, which renders the left eye at 2× from a recorded head pose and saves a PNG.
2. **Editor capture:** the same surface from a fixed camera at its intended distance, mono, 2×.
3. **Context capture:** a wider shot showing where the surface sits in the room.

Captures go in `native/unity/Reviews/<surface>/<yyyy-mm-dd>/` (git-ignored except the review
notes, which are committed).

### 16.3 The critic

A separate reviewer (a subagent running a different model from the one that built the surface)
receives the captures, this section's rubric and section 11.5, and nothing else from the builder.
It answers:

1. Scores 1 to 5 for each rubric item, with the evidence for each score.
2. Every issue found, ranked blocking, major or minor, each with the capture it appears in.
3. "Would this surface ship as-is in a AAA VR game such as Half-Life: Alyx? Yes or no, and why."

### 16.4 Rubric

| Item | Question |
| --- | --- |
| Legibility | Is every word readable at the intended distance, without leaning in? |
| Hierarchy | Is the most important thing the most prominent? Can the owner tell in one glance what this is and what to do? |
| Consistency | Do controls, type, spacing and colour match the design system and the other surfaces? |
| Physicality | Does it look and behave like an object in the room, with a sensible place, scale and material? |
| Feedback | Do hover, press, pending, success and error states read clearly and quickly? |
| Copy | Plain, short, verbs on buttons, no debug text, no controller names, no identifiers? |
| Layout | Aligned to the grid, balanced, no cramped or empty regions, nothing cut off? |
| Motion and sound | Purposeful, quick, matched to the action, never in the way? |
| States | Are empty, loading and error states designed, not leftovers? |
| Comfort | Comfortable angle, height and distance; no eye strain; works seated? |
| Accessibility | Not colour-only; works left-handed; works with Reduce motion? |
| Known failures | None of section 11.7's failures present? |

### 16.5 Passing

A surface passes when, in the same round, no item scores below 4, the average is at least 4.5,
there are no blocking or major issues, and the critic answers **yes**. Then the owner checks it
on the headset and signs off.

### 16.6 Iterating

1. The builder fixes every blocking and major issue and as many minor ones as are cheap.
2. New captures, a fresh critic (no memory of earlier rounds, to avoid anchoring), new scores.
3. After five rounds without a pass, the builder stops and brings the owner two or three
   concrete directions with captures and the critic's notes, and the owner picks one.

### 16.7 Record

Each round writes `native/unity/Reviews/<surface>/<date>/review.md`: the capture list, scores,
issues, the yes/no and what changed since the last round. Milestone exit lists each surface's
passing review.

## 17. Testing

| Layer | What | Where |
| --- | --- | --- |
| Protocol | Generated DTOs round-trip golden JSON produced by the server's own tests (`tools/headset/fixtures.ts` writes them) | EditMode |
| Store | Snapshot replacement, deltas, per-frame events, epochs, pending operations, resend with the same rid | EditMode |
| Terminal grid | Snapshot plus deltas equals the server's buffer for the fixtures in [protocol 8.4](headset-protocol.md#84-acceptance); history paging; resync | EditMode |
| Coordinates | Golden placements of desk, laptop, board and elevator; round trip to `floor.go.at` | EditMode |
| Settings | Defaults, ranges, schema migration, atomic save, migration from the old APK's files | EditMode |
| Prompts | `issuePrompt`, `ticketPrompt` and meeting presets render the same text as the browser for shared fixtures | EditMode |
| Interaction | Scripted XR Interaction Simulator scenarios: fetch a card, hand it to an agent, drop it in the tray, press an elevator button, climb the ladder, slide a pole, stamp a PR, poke-type a prompt, hold-to-confirm cancel | PlayMode |
| Integration | The headset app (editor, no XR) against a real `droid-office` server started by the test harness with fake agent commands: pair, connect, hire, prompt, queue, floor travel, reconnect during a hire (no duplicate), revocation | PlayMode |
| Device | The acceptance list (section 19) on the Galaxy XR, recorded | Manual, recorded |
| Performance | Section 14.3 captures | Manual, recorded |
| Design | Section 16 reviews | Recorded |

Synthetic input replays and editor captures are reported separately from physical headset checks;
neither proves comfort, readability or sustained 90 Hz.

## 18. Milestones

Each milestone ends with its exit checks done and recorded. Estimates assume one focused engineer
with an art contributor from U6; they are planning ranges.

| Milestone | Contents | Exit | Estimate |
| --- | --- | --- | --- |
| **U0 Spike** | Section 20 | Spike report with numbers and decisions U-D1 to U-D9 | 1–2 weeks |
| **U1 Skeleton** | Project, assemblies, `AGENTS.md`, generated protocol, store, connection (development-only LAN-token join URL until B2, then pairing), greybox office from layout JSON, rig, teleport, snap turn, agents as placeholder robots with lamps and nameplates | Walk the greybox office and watch live agent states change as they do on the laptop | 2–3 weeks |
| **U2 Terminals** | Overview and focused terminals (grid, needs B5), paired keyboard, quick-answer pad, poke keyboard, scrolling and history, resize ownership, desk panel Prompt | Answer a `needs_input` agent entirely from the headset; terminal surfaces pass review | 2–3 weeks |
| **U3 Physical core** | Gloves and poses, grab, fetch, throw, poke buttons, hold-to-confirm, haptics and sounds; issue board and cards; handing cards to agents; hiring kiosk and bell; queue tray and shredder; elevator; ladder; poles; results everywhere (needs B4) | Scenarios 1–8 of section 19 pass on device | 3–5 weeks |
| **U4 Tablet and settings** | Tablet, holster, pages, back-of-hand display, every setting, lobby and pairing, failure states | Every tablet surface passes review; every setting works and persists | 2–3 weeks |
| **U5 Office depth** | PR board and stamp station, reading panels, comments, labels, close; changes clipboard; meetings v1; monitors; services; bookshelf; picture drop | Scenarios 9–12 pass on device; their surfaces pass review | 3–4 weeks |
| **U6 Life and art** | Robot art and animation set, hire arrivals and departures, needs-you behaviour, card IK, gun and revival (if U-D7), coffee (if U-D8), office and roof art, lighting bake, sound pass | Owner sign-off on look and feel on device | 4–6 weeks |
| **U7 Hardening** | Budgets, sustained 90 Hz, comfort options, accessibility, reconnect and restart cases, memory and thermal soak | Section 14 budgets met in recorded populated captures; scenarios 13–15 pass | 2–3 weeks |
| **U8 Release** | Package switch, signing with lineage, migration, release script, CI steps, guide and README sections | Installs over the current app on the owner's headset with the saved office offered; Track D can start | 1–2 weeks |

Server work (Track B) runs alongside: B1–B3 before U1 ends, B5 before U2, B4 before U3, B6
before U3's hires at unknown seats matter, B7 during U5 or later.

## 19. Acceptance scenarios

All on the physical headset, recorded, with the laptop untouched after starting `droid-office`.

1. Launch the app; it reconnects to the saved office and puts you on your last floor within 8 s.
2. Find every agent that needs you from the lamps, the ping and the tablet; press X to go to the
   next one.
3. Open a waiting agent's laptop, read the question, answer with the quick-answer pad; the agent
   continues.
4. Fetch an issue card from across the room, hand it to an idle agent; it starts working; the card
   leaves the board.
5. Hand a card to an asleep agent; it is refused with the reason on the card; wake the agent and
   hand it again.
6. Put a card on an empty desk, ring the bell; a new agent arrives and starts the issue.
7. Drop a card in the queue tray; move a queued card up; shred a finished task.
8. Ride the elevator to another floor by its buttons; climb the ladder back; slide a pole down.
9. Read a PR's checks and diff; stamp it Squash with Delete branch; the gong rings.
10. Open a worker's changes, read a diff, commit, open a pull request.
11. Put an issue card on the meeting table, start a meeting, open a seated agent's terminal and
    redirect it, stop and clear the meeting.
12. Change every setting on the tablet; quit and relaunch; all are kept.
13. Turn Wi-Fi off during a hire and back on; exactly one agent is hired and the desk shows it.
14. Restart `droid-office` on the laptop; the headset reconnects, reattaches open terminals and
    keeps its place.
15. Revoke the headset on the laptop; the headset returns to the lobby and says so.

Quality bars across all scenarios:

- 90 Hz sustained, at least 99% of frames on time over each 2-minute populated capture, terminal
  open and closed.
- Every interaction gives visual, audio and haptic feedback on its frame; server outcomes appear
  within 1 s on a healthy LAN.
- No surface fails its design review; no debug text anywhere.
- No duplicated consequential operation across any reconnect.

## 20. U0 feasibility spike

A throwaway Unity project (`native/unity-spike/`, not shipped) that answers, with measurements on
the Galaxy XR:

| # | Question | Pass |
| --- | --- | --- |
| 1 | Does the pinned stack build and run on Galaxy XR with URP, Vulkan, multiview and GameActivity? | Runs focused, no validation errors |
| 2 | Does a 90 Hz request through Display Utilities take effect, and what is the actual rate? | Actual 90 Hz reported |
| 3 | Does eye-tracked foveation work with the fine eye permission? Can its level change at runtime on Galaxy XR, given the runtime keeps a swapchain's first profile? | Gaze-centred foveation visible in a diagnostic; level-change behaviour documented |
| 4 | How long are frames for a greybox populated office (16 desks, 12 robots, 2 terminals) at the recommended eye size? | GPU at most 9 ms, CPU at most 5.5 ms |
| 5 | Which terminal path is sharper at 0.9 m: eye buffer at render scale 1.0 and 1.25, or a quad composition layer? Does the underlay and hole cut keep hands in front? | A readable 120 × 40 terminal, chosen by owner on device (U-D1) |
| 6 | Do the Touch profile bindings expose Galaxy XR's Menu, thumbstick click, face buttons and capacitive touch? | Each input logged |
| 7 | Do haptic impulses respect amplitude and duration? | Felt and logged |
| 8 | Which networking option meets section 5.5? | U-D2 decided with throughput numbers |
| 9 | Does QR code tracking from Android XR Extensions work on Galaxy XR, with which permission? | U-D6 decided |
| 10 | Do the Android plugin pieces work from Unity: discovery, Keystore, photo picker, opening URLs? | Each works |
| 11 | Can the APK be re-signed with the existing key and lineage and installed over a test install of the current app at a higher version code, keeping its files? | Old files readable after update |
| 12 | Does the glTF importer's axis conversion match `OfficeSpace`? | `macbook-base.glb` sits correctly on a desk anchor |
| 13 | How large is the APK and how long is a cold start? | Recorded |

The spike report goes in this document's section 25 when U0 ends, with the decisions it settles.

## 21. Repository layout

```text
native/unity/
  AGENTS.md                       Unity project rules (created in U1)
  Packages/manifest.json          Pinned packages
  Packages/packages-lock.json
  Packages/dev.droidoffice.android/   Android plugin (Java): discovery, keystore, pickers, URLs
  ProjectSettings/                Unity version pinned in ProjectVersion.txt
  Assets/DroidOffice/
    Protocol/Generated/Protocol.g.cs   Generated from src/shared/protocol.ts; never edited
    Layout/office-layout.json          Generated from src/shared/layout.ts; never edited
    Core/ Net/ Platform/ Settings/ World/ Workers/ Terminal/ Interaction/ UI/
    Features/{Boards,Queue,Hiring,PullRequests,Changes,Meetings,Monitors,Bookshelf}/
    Diagnostics/ Editor/ Tests/
  Assets/Art/                     Git LFS: models, textures, audio
  Reviews/<surface>/<date>/review.md
  build.sh                        Batch-mode build
  build-release.sh                Align, sign with lineage, verify, checksum
tools/headset/
  protocol-cs.ts                  C# protocol generator
  export-layout.ts                Layout exporter
  fixtures.ts                     Golden protocol fixtures from the server's tests
```

`native/unity/AGENTS.md` (U1) carries the rules future changes must follow: pinned versions;
generated files never hand-edited; no office state outside the store; no network or JSON work on
the main thread beyond the apply budget; no secrets in logs, PlayerPrefs or captures; controller
roles and physical gesture rules from section 8; no hand tracking; no WebView; every surface
through section 16; validation commands.

## 22. Track D: retiring the WebView headset

After U8 ships and the owner has used it for a week without returning to the old app:

- Delete `native/android/` (C++ renderer, WebView host, Java services and tests), the `?native=1`
  page mode and `src/client/native/`, their tests and docs (`vr-native-*.md`,
  `vr-galaxy-xr-handoff.md`), and their CI steps; move still-useful evidence into a short history
  section of this document.
- Keep the desktop browser and WebXR clients.
- Keep `native/android/build-release.sh`'s signing knowledge in the Unity release script.
- Remove the `native-graphics.json` and shared-preferences migration readers one release later.

## 23. Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Android XR support in Unity is still in developer preview | Features or bugs block a milestone | U0 checks every feature this plan needs before U1; pin versions; keep the current APK until U8 |
| Foveation level cannot change at runtime on Galaxy XR | Settings feel broken | U0 item 3; "applies on next launch" fallback with honest copy |
| Terminal text not sharp enough | The main work surface fails | U0 item 5; MSDF renderer; composition layer option; text size settings |
| Networking under IL2CPP (pinning, headers, throughput) | Connection unreliable | U0 item 8 with two implementations |
| Server changes (Tracks A and B) slip | Unity blocked | Development LAN-token path for U1 only; Track B commits are small and ordered |
| Layout drift between browser and headset | Hires at wrong seats | Generated layout JSON, hash in `welcome`, test |
| Protocol drift | Silent breakage | Generated C# types and a CI test that fails on drift |
| Art and animation effort | Schedule | Greybox-first; art replaces placeholders without touching gameplay; U6 scoped by owner sign-off |
| Repository size | Slow clones | Git LFS for art (U-D3) |
| No CI Unity licence | Unverified changes | Local runs recorded per change until U-D4 is resolved |
| Scope creep (mini-games, leisure) | v1 never ships | Section 2.4 holds until U8 |
| Two headset apps during development | Confusion | Separate development package ID until U8 |

## 24. Decisions

| # | Question | Recommendation | Settled by |
| --- | --- | --- | --- |
| U-D1 | Terminal presentation: eye buffer or composition layer | Whichever U0 shows sharper on device without breaking hand occlusion | U0 |
| U-D2 | Networking: C# or OkHttp plugin | By section 5.5 criteria | U0 |
| U-D3 | Git LFS for art | Yes, for `native/unity/Assets/Art/**` | Owner, before U6 |
| U-D4 | Unity builds and tests in CI | Yes once a licence secret exists; local until then | Owner |
| U-D5 | Gloves or controller models | Gloves (Alyx bar); controller models stay available as a setting only if the owner wants it | Owner, U3 |
| U-D6 | Pairing: code comparison only, or QR as well | Code comparison first; add QR if U0 item 9 passes | U0 |
| U-D7 | Gun and revival in v1 | Yes, off by default, in U6 | Owner |
| U-D8 | Coffee and caffeine in v1 | Yes, in U6 | Owner |
| U-D9 | Jump in v1 | Keep, as a setting, on by default (existing contract) | Owner |
| U-D10 | Smooth movement default speed | 2.5 m/s, with 4.6 m/s (today's speed) available | Owner, U3 playtest |

## 25. Spike report

### 25.1 Stack and local evidence, 2026-10-02

**U0 remains open.** The owner authorized continued implementation and delegated
Unity/version choices. The initial work was offline; a Galaxy XR subsequently became
available. Section 25.4 records its partial physical evidence. No sustained-90-Hz,
readability, comfort, haptic or first-frame cold-start acceptance is claimed.

The isolated project is `native/unity-spike/`. Unity MCP connected, and unity-cli
controlled the explicitly selected spike Editor. The stray root Unity project and
legacy `dev.droidoffice.xr` installation and data remain outside this work.

| Component | Resolved pin |
| --- | --- |
| Unity / URP | 6000.3.25f1 / 17.3.0 |
| XR Management / OpenXR | 4.7.0 / 1.17.1 |
| Android XR / Android XR Extensions | 1.3.2 / 1.4.0 at `06516b81049d6050007e7f5354c9c628d345e930` |
| Composition Layers / XRI / Input | 2.6.0 / 3.6.1 / 1.20.0 |
| glTFast / Draco / Collections | 6.19.0 / 5.4.3 / 2.6.7 |
| Newtonsoft / uGUI / Test Framework | 3.2.2 / 2.0.0 / 1.6.0 |
| OkHttp JVM / Okio JVM / Kotlin stdlib | 5.3.2 / 3.16.4 / 2.2.21, SHA-256-pinned |

**Compatibility fix:** Extensions 1.4 fails against Collections 2.6.8 because that
release removed the `Unsafe` DLL it uses. glTFast 6.20 requires Collections 2.6.8,
so pin both glTFast 6.19 and Collections 2.6.7. This compiles with .NET Standard,
without a vendor source patch. Fine Eye also requires Android XR's AR Face and
AR Session features; no hand tracking or face manager is added to the scene.

Local results:

- Final isolated EditMode rerun: **12 passed, 0 failed**, 0.0341762 s.
- Greybox: **16 desks, 12 synthetic robots, 2 terminals**, imported MacBook at
  every desk. Editor frame advancement was verified, not inferred from a still.
  This is not a live-agent scene.
- Terminal A/B: identical **2160×1200** raster source, **120×40** characters,
  **0.9×0.5 m** panels, **4 Hz** updates. This is a TMP raster reference, not the
  production cell renderer. Panel-facing and source-framing errors were corrected
  before the final spike build; owner comparison is still pending.
- Managed `ClientWebSocket` fails the self-signed synthetic WSS handshake with
  `UNITYTLS_X509VERIFY_FLAG_NOT_TRUSTED`, despite its per-socket pin callback.
  The separate SPKI hash matches OpenSSL. No global trust bypass was added.
- OkHttp's host JVM probe received **33,959,444,480 bytes in 15.014 s**, three
  connections, **2,261.791 MB/s on host loopback**. HTTPS succeeded; actual HTTPS
  and WSS handshakes rejected incorrect pins. Control-pong counts were
  **25, 25, 24**. These numbers do not measure Wi-Fi, Android JNI or headset
  main-thread cost.
- Final spike APK: **73,140,917 bytes**, 25.873 s, **0 errors / 3 warnings**.
  APK v2 signing and 16 KiB ZIP alignment pass. ARM64, Vulkan, GameActivity and
  spatial API 1 are present; microphone, face and hand permissions are absent.
  Earlier failed builds are not counted as passes.

### 25.2 All thirteen checks

| # | Evidence | Physical status |
| --- | --- | --- |
| 1 | Signed spike APK runs on Galaxy XR with Vulkan/IL2CPP; focused OpenXR session observed | Partial: missing-script warnings remain; no clean validation pass |
| 2 | Actual rate **72.00001 Hz**; native refresh request reports `XR_ERROR_FUNCTION_UNSUPPORTED` | **FAIL**, not 90 Hz |
| 3 | Owner approved fine-eye permission; gaze flag and 0.5 API readback observed | Bound profile/gaze diagnostic NOT RUN |
| 4 | 7,296 samples over 120.0137 s; CPU main median 13.913 ms/p95 27.373 ms; GPU unavailable | No budget pass; interrupted synthetic run |
| 5 | Eye 1.0, eye 1.25 and quad-underlay raster alternatives implemented | Owner readability/occlusion NOT RUN |
| 6 | Both Touch-profile controllers expose button/touch support; touch changes observed | Every physical control not yet exercised |
| 7 | Amplitude/duration impulse probes implemented | Felt feedback NOT RUN |
| 8 | Managed WSS fails; OkHttp host and Android JNI/IL2CPP HTTPS/WSS, wrong pins, pongs and reconnect pass | USB loopback measured; Wi-Fi and display-loop cost NOT RUN |
| 9 | QR API and coarse scene-understanding permission identified in pinned package; sample not integrated | NOT RUN |
| 10 | Android Keystore persisted round-trip passes; discovery resolved one office | Picker/browser visibility NOT RUN; restart persistence not yet tested |
| 11 | No release-key use or install over the owner's current app | NOT RUN |
| 12 | Mirror-Z/yaw and glTFast mirror-X adapter tests pass; imported mesh present | Browser/device visual comparison NOT RUN |
| 13 | Spike APK 73,140,917 bytes; activity COLD launch total 506 ms/wait 511 ms | First rendered-frame timing NOT RUN |

Reproduction instructions are in `native/unity-spike/Tools/DEVICE-CHECKS.md`.
Evidence, TLS fixture keys, captures and APKs are ignored. The synthetic fixture
uses no office credentials.

### 25.3 Working decisions

| Decision | Choice, with limits |
| --- | --- |
| U-D1 | Keep eye-buffer and quad-underlay alternatives until the owner reads both on device. |
| U-D2 | Prefer per-client pinned OkHttp for Android; retain a replaceable transport seam until Android throughput and stripping pass. Managed WS is usable for development loopback without TLS. |
| U-D3 | LFS for large art from U6; no repository-wide hook/LFS change here. |
| U-D4 | Local Unity checks recorded per change; no CI or licence-secret changes in this lane. |
| U-D5 | Gloves in U3; tracked proxies are diagnostics, not final art. |
| U-D6 | QR remains unproven. Reconcile admission with Track B before shipping pairing UI. |
| U-D7 / U-D8 / U-D9 | Gun off by default, coffee in U6, jump as a setting, under delegated scope decisions. |
| U-D10 | 2.5 m/s working smooth-move default; device comfort check pending. |

Track A has advanced: the current server uses loopback admission and a per-start
LAN token, not cookies. U1 snapshots actual protocol/layout sources with commit
and content hashes, starts with a development-only loopback connection, and does
not add server authentication or protocol changes. Track B's proposed generator
and exporter remain Track B-owned; temporary generators live in
`native/unity/Tools/`. They do not claim negotiated protocol-2 support.

The owner authorized implementation beyond the offline U0 report. U1 and later
phases can progress locally, but physical milestone exits and device-dependent
decisions remain open.

### 25.4 First Galaxy XR session, 2026-10-02

Device: Samsung SM-I610, Android 14/API 34. Only the separate development package
was installed. The owner deliberately approved fine-eye permission and wore the
headset for the initial focused checks, then removed it. Later ADB wake/probe
results are not owner comfort, haptic or readability evidence.

The spike CSV records **7,296 samples / 120.0137 s** at **1856×2160** and
**72.00001 Hz**. Main-thread time is median **13.912813 ms**, p95 **27.373073 ms**.
Frame intervals are median **13.8855 ms**, p95 **39.24561 ms**, with a **12.21918 s**
interruption. GPU/render counters are unavailable, not zero. Managed allocations
are median **1,916 bytes**, p95 **80,600 bytes**. This does not meet the CPU/GC/90 Hz
budgets and is not a clean sustained run or populated production measurement.

The native display request reports `XR_ERROR_FUNCTION_UNSUPPORTED` even though
the managed wrapper prints `UnqualifiedSuccess`. The measured rate takes
precedence. Fine-eye permission, gaze-allowed flags and API foveation readback do
not establish that the runtime bound the intended eye-tracked swapchain profile.
The Android performance-metrics feature is unsupported in this runtime session.

The Android OkHttp probe receives **1,649,410,048 bytes over 45.000 s**, or
**36.653 MB/s**, across three connections. HTTPS and WSS succeed, both wrong-pin
paths reject, and the server observes **74 control pongs on each connection**.
This is **USB `adb reverse`**, not Wi-Fi. The private per-client TLS context keeps
hostname verification. The Java Keystore AES-GCM persisted-file round-trip passes;
the discovery callback resolves one `_droidoffice._tcp.` advertisement without
logging its name/address. These probes do not establish production pairing.

### 25.5 Production foundation

`native/unity/` now contains a generated snapshot of **44 server / 69 client message
types and 200 DTOs**, 59 layout anchors and 36 worker seats, the bounded ordered
store/transport adapter, tracked rig and teleport foundation, worker views, terminal
overview grids and a single-draw cell renderer. Protocol 1 is explicitly a development
loopback adapter; no Track B negotiation, operation-result or full-grid capability
is claimed.

The terminal uses a baked **Static TMP SDF atlas, 192 characters / 191 glyphs**.
Dynamic TMP atlases were cleared during Android builds, causing blank/fallback
glyphs; baking before freezing fixes this, with post-build regression coverage.
Blank/space cells map to glyph zero rather than sampling atlas padding. The renderer
shares a fair 1 ms CPU update budget and a 6 m distance gate. Corrected panel facing
and clean blank cells are verified in a fixed 0.9 m Editor capture. This is not yet
the final MSDF/symbol/dynamic-grapheme/history/focused-terminal implementation.

Preferences have defaults, validated copies, bounded loads, serialized atomic
saves, and read-only preservation of corrupt/future-schema files, including a
save-before-load attempt. OfficeApp loads asynchronously and debounces saves,
flushing on pause/disable/quit. Settings UI, actual graphics application and
device quit-save completion remain open.

**54/54 EditMode tests pass**, including after the Android static-atlas build.
The isolated real-server fixture uses its own HOME, checkout and two synthetic
agent commands. Editor tests observe live 100×30 grids and worker status changes,
retain workers while disconnected, and reconnect to a new welcome without
restarting PlayMode. No owner workers or credentials are involved.

Android loader configuration now enforces **exactly one OpenXR loader**. Installed
ARCore/MockHMD packages had auto-assigned extra loaders, introducing ARCore sample
image build errors and unwanted camera/depth requirements. Disabling those loaders,
without editing/removing vendor packages, removes those requirements and build
errors. The builder rejects nonzero build-report errors even if Unity says
`Succeeded`. Package/Sentis shader warnings remain and are not labelled a clean log.
The installed Editor additions (AI Assistant 2.20.0-pre.1, Inference 2.6.1,
ARCore 6.3.5 and MockHMD 1.5.0-exp.3) are preserved; Android does not select
ARCore or MockHMD. A late Android build-input filter removes AR Foundation's
Editor-only XR Simulation settings from preloaded assets. This removes the
production startup missing-script warnings without deleting assets or patching
packages.

Development-only diagnostics accept `status` and `capture-terminal` through an
app-local file inbox. They report counts, not terminal text, worker names or
credentials. Captures are explicit and may contain terminal content; use only the
synthetic fixture for shareable evidence. The capture uses a fixed mono camera
at 0.9 m, not the headset eye, and temporarily bypasses the distance gate. No
listener, exported receiver or arbitrary evaluation is added, and the component
is compiled out of release builds.

Final production development APK: **96,552,773 bytes**, **0 errors / 355 warnings**,
12.723873 s incremental build. APK v2 signing and 16 KiB ZIP alignment pass.
Manifest inspection confirms `allowBackup=false`, cleartext disabled except the
development loopback network configuration, spatial API 1 and no camera, face,
hand or microphone requirements. Latest activity COLD launch is 650 ms total /
657 ms wait, not first-frame latency.

On-device Vulkan diagnostics observe two synthetic workers, two **100×30** grids,
loaded preferences and advancing frames/messages. The fixed-camera Android
capture renders correctly facing text and clean blank cells. Normal eye surfaces
were distance-gated at this pose; the explicit capture bypassed that gate. With
the headset unfocused/unworn, this is a renderer/integration check, not eye
readability or performance acceptance. Actual refresh remains **72.00001 Hz**.
Android XR performance-counter initialization still reports unsupported native
functions; the final startup has no missing-script warnings.

Stopping the synthetic server retains two workers/grids with `connected=false`.
Restarting it restores both grids and `connected=true`, increasing generation
from 1 to 2 with the same app process. The legacy package remains version
**0.1.340 / code 340**, with its prior update time unchanged. Only the development
package was replaced.

Validation: **54/54 production EditMode tests**, **12/12 spike EditMode tests**,
protocol/layout drift check, repository lint/typecheck and **895/895 repository
coverage tests** pass. Coverage is 88.62% lines, 84.35% branches and 76.51%
functions. Source whitespace checks pass; a whole-tree `git diff --check` reports
Unity-authored empty YAML fields with trailing spaces, which were not hand-edited.
Root dependency installation/CI and a release build were not run or changed.
Reproduction: `native/unity/Tools/DEVICE-CHECKS.md`.
