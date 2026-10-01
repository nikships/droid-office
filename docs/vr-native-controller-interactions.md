# Galaxy XR controller interactions

The installed client uses Galaxy XR motion controllers. Its world, workers, boards, collision,
floor transitions and action confirmations come from the same client and server as the desktop.
This document records the native control design and its acceptance evidence. WebXR keeps its
existing controls. Hand tracking is outside the native app's supported input scheme.

## Research and button roles

Research checked on 2026-09-30:

- [Meta's Touch mapping guidance](https://developers.meta.com/horizon/blog/tech-note-touch-button-mapping-best-practices/)
  puts object grabbing/releasing on grip, selection/fire on trigger, application menus on Menu,
  and movement and turning on different sticks. Face-button actions depend on the application.
- [Meta's locomotion input guidance](https://developers.meta.com/horizon/design/locomotion-input-maps/)
  treats a held object and stick locomotion as separate controls. This supports moving while
  holding a tool rather than spending the face buttons on duplicate locomotion shortcuts.
- [Valve's Half-Life: Alyx updates and locomotion discussion](https://store.steampowered.com/news/posts/?appgroupname=Half-Life%3A+Alyx&appids=546560&enddate=1592263154&feed=steam_community_announcements)
  document continuous movement alongside teleport choices and separation of movement and weapon hands.
- [Unity's Climb Provider](https://docs.unity3d.com/Packages/com.unity.xr.interaction.toolkit@3.2/manual/climb-provider.html)
  moves the body counter to a selecting controller's motion, with axis constraints. Droid Office
  uses that principle on its vertical ladder. Averaging two held grips is our design choice;
  Unity's provider instead uses the most recently selecting interactor.

The following mapping is Droid Office's choice, rather than an asserted universal game mapping:

| Control | Native action |
| --- | --- |
| Left Menu | Open or hide the workspace |
| Right Menu | Android XR system function; never bound by the app |
| Left stick | Smooth movement, when enabled |
| Left stick click, held | Sprint during smooth movement |
| Right stick left/right | Snap or smooth turning |
| Right stick forward/release | Aim/commit teleport, including with smooth movement enabled |
| X, left primary | Go to the next waiting worker |
| Y, left secondary | Open/close Find anything |
| A, right primary | Jump in the office |
| B, right secondary | Go back one workspace step; return a carried card when in the office |
| Right stick click | Show/hide keyboard while workspace is open |
| Either trigger | Pointer selection, shared world actions, use a held object, or fire a held gun |
| Either grip | Grab/hold/release a nearby object, ladder, pole, back-holstered gun or a shot worker on the floor |

Movement and turning retain their hands if one controller disconnects. The left stick never
inherits right-stick teleport/turn, and the right stick never inherits left-stick movement.
The controls panel and settings describe the same roles. Grip never opens, closes or navigates
a menu, and no longer returns a ray-picked issue card.

## Physical interactions

`native/input.ts` and `xr_input.cpp` distinguish tracked grip poses from pointer aim poses.
Physical gestures reject the aim fallback, invalid head tracking, stale samples and pose jumps.
Fresh controller connections seed all button latches; held buttons never synthesize a fresh
draw, click or jump. Workspace navigation pauses world gestures and weapon firing.

The **merge gong** uses a swept controller contact against the disc's fixed rest surface,
including fast approaches that cross it between samples. A minimum approach speed separates
a strike from a resting hand. Moving away rearms it; the disc's animation cannot. The shared
`hitGong()` path retains its network event and 500 ms limit. Trigger activation is removed in native XR.

The **ladder** accepts grip near a rendered rail or rung, not its walk-up target. Downward hand
motion lifts the body; upward motion lowers it. Native-space deltas avoid a feedback loop from
the rig rising. Two held grips average their motion; alternating hands retains the remaining
grip. Still hands produce no motion. Reacquisition reanchors before consuming another delta.
The existing `Climber` applies each queued displacement once and preserves rung sounds,
hatches, top/bottom limits, floor travel, arrival and safe release. Stick direction and trigger
no longer climb or release it in native XR.

The **fire pole** requires held grip near the pole. Tangential counter-motion turns the body;
the tracked head is never forced into a canned spin. Bottom-floor twirls remain held until
release. Slides retain the original gravity and floor transition, continuing through floors
while held; releasing steps off at the next available floor or lands on the bottom mat.
Brief tracking loss pauses hand-driven motion. Already committed floor arrivals still finish.
Native XR no longer automatically grabs a pole merely by walking into its hole.

The **gun** draws on a fresh grip in the back holster. Either hand may hold it; grip must stay
held. Its shared model uses metres, a fist-centred origin, +Y up and a +Z bore. Native XR derives
the grip-local rotation from the runtime's aim and grip orientations, mapping the bore to aim -Z
while keeping the handle at the grip origin. The live display-frame grip still places the gun.
The runtime defines aim as the controller's pointing direction, distinct from grip; see the
[controller pose reference](https://developers.meta.com/horizon/documentation/unreal/unreal-controllers-overview/).
Shots start at the transformed
model muzzle and reuse desktop solid occlusion. Shot picking ignores hidden scene subtrees,
invisible materials, name sprites and glow points; visible furniture and glass still block
shots. Releasing grip in the holster puts it away. Releasing elsewhere detaches it into
the world, falls to the floor and disappears after a short landing interval. Tracking/focus
loss cancels it without inventing a throw. Releasing grip suppresses a simultaneous trigger.
The native app does not draw the gun through the desktop `7` shortcut.

A shot shows its muzzle flash at full brightness in its own 30 Hz update and kicks the gun model
up about the fist and back, settling within 0.24 s on the input clock; the bullet leaves the
muzzle as aimed, before the kick. The holding controller gets a full-strength 70 ms pulse. A
struck worker sprays blood back out of the contact point with a wet hit sound, and the shot
shoves it along the bullet at once before it sprawls out on the far side of its chair. It lands
with its length flat along the floor, resting on it.

**A shot never opens anything in the headset.** The desktop's bleed-out dialog (kill or revive)
is not used in native mode: no dialog, workspace or toast appears, nothing freezes, and the gun
stays live. What happens next is a physical act at the body (`native/downed.ts`):

- **A stray shot only drops a worker.** It lies on the floor with its session running for as
  long as it is left there, with a heartbeat heard up close (and felt in a controller whose grip
  comes within about 0.65 m of its chest) that slows as it bleeds. Several workers can be down at
  once, each in its own casualty scene. A trigger at a downed worker's desk opens nothing.
- **Finishing it off takes a second, aimed shot into the body** once it has lain still for
  `FINISH_AFTER` (0.8 s). A double or triple tap only drops it: pulls as fast as the revolver
  allows need at least `FALL_TIME + FINISH_AFTER` (about 1.55 s). That shot stops its heart and
  sends the ordinary `{ t: 'worker.kill', workerId }` once, with the office's default worktree
  handling (a worktree that has work on it is kept). The siren, elevator and medic carry
  ([medic sequence](medic-sequence.md)) are the confirmation, when its removal arrives; the
  server's send-home and worktree toasts for that worker are left out on this client.
- **Reviving is done by hand.** A fresh grip with a tracked controller within 0.4 m of the body
  takes hold of it (never through the aim-pose fallback). The body comes up toward its chair with
  the hand's rise in native space (rig motion never lifts it), measured from the lowest point
  the grip reached, with a haptic tick each quarter. At `HAUL_LIFT` (0.42 m) it is back in its
  seat with its session untouched, gasps and hops, and the hand gets a firm pulse. Letting go
  earlier, losing tracking for `LOST_MS` or a floor change drops it back to the floor (a thud
  when dropped from 30% of the way or more). A finished body cannot be hauled.

Workers still down go back to their seats quietly on a floor change, a lost connection or
entering WebXR; a body already finished off stays down for its medics. Desktop and WebXR keep the
dialog.

The gun model is shared with desktop. The desktop wrist no longer adds a large resting tilt
to its bore. Native attachment rendering uses actual display-loop grip transforms, rather
than presenting a controller-held model at the bridge's lower scene update rate. Removing
the attachment tag on a drop returns it to ordinary world transforms.

## Validation status

Implemented replay checks cover asymmetric buttons, teleport without hand fallback, physical
contact/rearming, rails/rungs, batched one-/two-hand climbing, invalid tracking, pole turning,
weapon muzzle transforms, menu suppression, holster/drop and simultaneous grip/trigger release.
The original desktop climb tests also pass. These checks are synthetic input evidence.

The shared gun model and display-loop attachments are integrated. Attachment host/GLES checks
cover tracked grip, focus, stale snapshots and release-frame hiding without hiding ordinary
attachments on the same controller. Browser captures at 1600×1019 and 1280×720 show clean,
scrollable control rows with the keyboard open. Native login captures at 1280×720 and 1024×600
also keep the submit button above the keyboard; the compact card now scrolls when necessary.
The controller release passed all 689 tests with coverage, 13 native host checks, both Android
variants and [CI](https://github.com/nikships/droid-office/actions/runs/36798298291). The final
locally signed v0.1.301 is installed with retained app data; its installed bytes match the local
artifact and its signing identity matches the earlier release. The laptop-served client was
updated before the office/test servers were stopped at the owner's request. CI completion for
this wrap-up was not awaited. The owner has reviewed the controls. Their first gun capture exposed an upward
barrel caused by treating grip and aim orientations as identical; aim-relative attachment
regressions now cover both hands, wrist pitch/yaw/roll, handle position and shot alignment.
A second wearer capture showed muzzle smoke without a worker reaction. The shared raycast
now filters invisible blockers and UI billboards, with regressions for hidden workers and
real furniture/glass occlusion. The headset log confirmed every trigger pull threw a null
`matrixWorld` error in the camera-dependent sprite raycast. Shot picking now collects visible
solid meshes before intersecting, so a direct muzzle ray never visits a sprite at all. Native
shots also set the shared ray camera and record the chosen solid locally for diagnosis.
The camera-less muzzle regression passes; the fix still needs wearer confirmation.
The shot-in-the-world flow is covered by `tests/native-downed.test.ts` (a single shot and
rapid pulls never send a kill, the aimed second shot sends exactly one, several bodies keep their
own state, the heartbeat stops when finished, hauling and slumping, a real worker resting flat
on the floor for 16 falls) and `tests/native-shot-stage.test.ts` (real office desks: the trigger
path drops a seated worker from five sides at 4 cm to 2.2 m and sends nothing; staged finishes
only for disposable Target workers; a staged haul revives through the grip path). The grip
haul's tracking, loss and release rules are in `tests/native-physical.test.ts`. A debuggable
build can stage a shot or a haul on the headset through the same paths; see
[debug staging](vr-native-android.md#debug-shot-staging).
A wearer still needs to
confirm comfortable holster reach, rung acquisition, pole release and striking feel. No synthetic
replay or browser render establishes physical headset ergonomics or worn-view sharpness.
