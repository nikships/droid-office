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
| Left Menu | Open or hide APK-native settings; Office workspace opens the shared office tools |
| Right Menu | Android XR system function; never bound by the app |
| Left stick | Smooth movement, when enabled |
| Left stick click, held | Sprint during smooth movement |
| Right stick left/right | Snap or smooth turning |
| Right stick forward/release | Aim/commit teleport, including with smooth movement enabled |
| X, left primary | Go to the next waiting worker |
| Y, left secondary | Open/close Find anything |
| A, right primary | Jump in the office |
| B, right secondary | Go back one workspace/settings step; return a carried card when in the office |
| Either trigger | Pointer selection, shared world actions, use a held object, or fire a held gun |
| Either grip | Grab/hold/release a nearby object, ladder, pole, back-holstered gun or a shot worker on the floor |

Movement and turning retain their hands if one controller disconnects. The left stick never
inherits right-stick teleport/turn, and the right stick never inherits left-stick movement.
The Controls window and settings describe the same roles; no other native text names a control,
as in Half-Life: Alyx, where the world and the controllers explain themselves. Grip never opens, closes or navigates
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
model muzzle and reuse desktop solid occlusion and the shared downed state. Downed workers
can be revived through the use action at the body within 30 seconds; otherwise the medics collect
them and their owned worktrees and branches are deleted without a confirmation menu.
Shot picking ignores hidden scene subtrees, invisible materials, name sprites
and glow points; visible furniture and glass still block shots. Releasing grip in the holster puts it away. Releasing elsewhere detaches it into
the world, falls to the floor and disappears after a short landing interval. Tracking/focus
loss cancels it without inventing a throw. Releasing grip suppresses a simultaneous trigger.
The native app does not draw the gun through the desktop `7` shortcut.

The held gun is lit like the hand that holds it, not only by the night office: its own fill is
the desktop first-person hands' curve (`0.25 + 0.75 × Sky.lightAt`, about half its color
indoors, near the native hand renderer's 0.55 ambient), so it reads as steel and walnut in every
frame instead of going navy with the room (`heldGunFill`, `lightHeldGun` in `world/gun.ts`).

A shot shows its muzzle flash at full brightness in its own 30 Hz update and kicks the gun model
about 15° up about the wrist (below and behind the fist) and 3 cm back in that same update. The
hand then brings it down in a critically damped return: still about 6° up 133 ms on, back on the
aim by 0.3 s and exactly home at 0.34 s on the input clock. The bullet leaves the muzzle as aimed,
before the kick. The held gun's flash light (`HELD_FLASH`) is a warm pool round the shot with no
hot spot: up to about half the surfaces' own color on the gun, what it is pointed at and the
desk under it, softening out to 1.4 m, so nothing at the muzzle clips to white and the floor and
walls beyond keep their look. Guns seen across the room keep the physical light. The holding
controller gets a full-strength 70 ms pulse. A
struck worker sprays blood back out of the contact point with a wet hit sound and reels from the
shot in the world, where the shooter is looking (below).

**A shot never opens anything in the headset.** The owner's shot design holds (`gun-spec.md`,
[medic sequence](medic-sequence.md)): a hit sends `worker.shoot`, the server starts the worker's
persisted 30-second revival window, and on expiry dismisses it, deletes its owned worktrees and
branches, and the medics collect the body. No dialog, workspace, toast, hint text or countdown
appears at any point; nothing freezes, the gun stays live and you stay free to move. What follows
plays out at the body (`native/downed.ts`, `world/casualties.ts`):

- **The hit lands at once, where it struck, and the body reels from it in view.** In the shot's
  own frame, without waiting for the server's echo, the hit snaps the worker back and throws it
  up out of its chair along the bullet, arms flung up; it staggers back away from the shot onto
  its feet beside the chair within about 0.25 s, turning to face it, then goes over backwards,
  arms flying out, and lands on its back with a thud at 0.75 s; its head bounces once and it lies
  still by about 1.05 s, face up, arms flung out on the floor (`reelTilt`, `Casualties.reel`).
  It is never driven in under its desk, and goes round the back of its chair rather than through
  it. Where its feet come down (0.85 to 1.25 m from its seat) and which way its head goes are
  chosen for the shooter's eyes (`Casualties.reeling`): rays from the headset's eyes, and from
  12 cm to either side, past its own desk and chair and the desks and workers within 3.5 m must
  reach its body and flung-out arms, nothing may stand over it, and of those it prefers near
  where it sat in the shooter's view, lying across the view rather than end on, nearest its
  chair. So from a standing shot 1-1.5 m beside a seated worker no part of the reaction strays
  further from the middle of a view on the target than the seated worker itself, and in a level
  view it never sinks lower than it sat; from behind, it goes out sideways round the desk, within
  40 degrees of the middle (`tests/native-shot-reaction.test.ts`). `PendingShots` keeps that local
  fall standing through unrelated updates until the downed state arrives, and lets the body get
  back up if it never does, after `SHOT_ECHO_MS`. Other clients, which know no bullet, see the
  desktop's sideways tumble when the server's state reaches them. A trigger at a downed worker's
  desk opens and says nothing.
- **The body keeps the window's time.** Its heartbeat, heard up close and felt in a controller
  whose grip comes within about 0.7 m of its chest, starts at a beat every 0.75 s and drags out
  to one every 2 s while fading to a quarter of its strength as the server's deadline
  (`downedUntil`) nears. The worker's own status light, the lamp on its seat's nameplate (the
  headset app floats no antenna bulb over it), flashes red with each beat over an ember that dims
  with the time left, like a monitor by the body, and its body swells slightly with the beat.
  The blood pool spreads to 40% in two seconds, then creeps out to full size exactly at the
  deadline. When the window closes the heart stops and the lamp goes dark; the siren and the
  medics follow. The server's dismissal toasts for a worker shot on this floor are left out on
  this client (they are tagged with its `workerId`); warnings still show.
- **Reviving is the use action at the body.** The trigger of a free hand (not holding the gun
  or a card) revives the worker when its tracked grip is within `REVIVE_TOUCH` (0.45 m) of any
  part of the body, or when its pointing ray passes within 0.3 m of the body no more than
  `REVIVE_RANGE` (2.4 m, the owner's walk-up distance) away. Physical gestures never use the
  aim-pose fallback: the hand's grip must be tracked and stable. A hand arriving at a body feels a
  soft tick (and from there its heartbeat), and the aim words stay away while a hand is at one.
  On the trigger the hand gets a firm pulse, the
  worker gasps and stirs, `worker.revive` goes out, and when the server confirms the body gets
  back up into its chair over 0.7 s and hops, its session untouched. A refused or unanswered
  revival lets it slump back down within 2.5 s. Revival through the gun hand is impossible: its
  trigger fires.

Desktop and WebXR keep the owner's flow unchanged: E within 2.4 m, with the countdown hint.

The gun model is shared with desktop. The desktop wrist no longer adds a large resting tilt
to its bore. Native attachment rendering uses actual display-loop grip transforms, rather
than presenting a controller-held model at the bridge's lower scene update rate. Removing
the attachment tag on a drop returns it to ordinary world transforms. While a controller holds
a placed attachment (`SceneRenderer::attachedHands`), its Samsung model is not drawn: the gun
takes the controller's place in the hand instead of the controller poking through its trigger
guard, on exactly the display frames the gun is drawn.

The page's control packets arrive about every 33 ms, but on the headset they regularly arrive
250–500 ms apart while the page works (`controlAgeMs` 495 ms measured). An attachment therefore
stays at its grip for up to 1.5 s without a packet (`kAttachmentStaleNs`); a grip-held object
still hides on the display frame its squeeze is released, tracking loss hides it at once, and
a page navigation resets the controls.

## Hands in front of compositor panels

The workspace panel and the status card are compositor quads, which the compositor cannot
depth-test against the controllers. While the workspace is open, the display loop submits the
panel (and its pointer reticles) beneath the world layer and gives the world layer
`XR_COMPOSITION_LAYER_BLEND_TEXTURE_SOURCE_ALPHA_BIT`. `PanelCutout` cuts a hole the panel's
shape (inset 4 mm against reprojection seams) into the world layer after the world pass:
alpha 1 everywhere first, then transparent black and the panel's own depth inside the hole,
over whatever the world drew there. The held gun (`SceneDrawSet::Attached`), controllers and
rays are drawn afterwards with the depth test, so they show in front of the panel where they
are nearer than it and stay behind it otherwise; the world never covers the panel. When the
sharp-screen layer is drawn, `seal` writes the near plane's depth inside the hole so no
screen is drawn over the panel, and the comfort fade writes color only, leaving the panel
unfaded as before. With the workspace closed the layers and passes are unchanged.

The status card is a head-locked quad over the world. With
`XR_KHR_composition_layer_color_scale_bias` it fades out (0.1 s) while a drawn controller or
the bounds of what it holds lie between the eyes and the card (`layer_occlusion.h`), and back
in (0.25 s) once clear. It is still submitted at opacity 0, so its Surface keeps being
consumed. Without the extension it stays drawn over the hand.

## Capture puppet (debug builds only)

Physical controllers are not tracked while nobody holds them, so a headless capture shows no
controllers, held gun or hand at a button. Debug builds accept synthetic controllers from the
page (`window.__office.puppet`, `src/client/native/puppet.ts`): `set`, `update`, `clear` and
timed `script` steps give each hand grip and aim poses in LOCAL_FLOOR, head, heading or world
space, plus trigger, squeeze, stick and buttons. The page sends them in the control packet's
`puppet` field. `capture_puppet.h` fills only the slots the runtime reports as untracked, in the
display loop with that frame's head pose, before the controller models, rays, button animation,
attachments, panel pointer and the page's samples read the frame; native marks those samples
`puppet: true`. A tracked controller always wins. The puppet counts as a tracked grip only in
debug builds. It disappears at once with focus or pose loss, a page navigation or a control
packet without it, and after 1.5 s without a fresh packet (`kPuppetStaleNs`, never longer than
`kAttachmentStaleNs`): at 250 ms it vanished for 10–333 ms about six times a minute, because
the page's packets regularly arrive that far apart, and a held gun flickered out of captures.
Every `set`, `update` and `script` call may pass `{ label }`; `state()` reports the latest
(`label`) and every staging call since the puppet appeared (`staging`), so a capture names
exactly what staged it. Calls without a label are recorded as `__office.puppet.set` and so on.

The native `OFFICE_CAPTURE_PUPPET` definition comes only from the Gradle debug build type, and
the Java host must also pass `BuildConfig.DEBUG`; native reports `puppet: true` in its frame
events only then. Release builds never parse the field or apply a puppet
(`capture_puppet_release`). Captures that use it are synthetic input, not physical evidence.

## Validation status

Implemented replay checks cover asymmetric buttons, teleport without hand fallback, physical
contact/rearming, rails/rungs, batched one-/two-hand climbing, invalid tracking, pole turning,
weapon muzzle transforms, menu suppression, holster/drop and simultaneous grip/trigger release.
The original desktop climb tests also pass. These checks are synthetic input evidence.

The shared gun model and display-loop attachments are integrated. Attachment host/GLES checks
cover tracked grip, focus, stale snapshots and release-frame hiding without hiding ordinary
attachments on the same controller. The GLES suite also draws a frame with the workspace open
the way the display loop does (`panelUnderlayChecks` in `render.cpp`): the world is cut inside
the hole even where it is nearer than the panel, a gun held in front of the panel stays opaque
there, one behind it stays hidden, and the seal keeps anything drawn later out of the hole.
`layer_occlusion_test.cpp` covers the hole's corners against `panelHit` and when the status
card yields. Browser captures at 1600×1019 and 1280×720 show clean,
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
The shot-in-the-world flow is covered by `tests/native-downed.test.ts` (the heartbeat slows
and fades with the server's deadline and stops there, the bulb flashes and goes out, the pool
reaches full size at the deadline, touch and pointing reach rules, the stir, rise and slump, a
window closing under a stirring body, pending local falls, the desktop unchanged, and a real
worker resting flat on the floor for 16 falls), `tests/native-shot-reaction.test.ts` (real
workers at three real desks shot from both sides and both back diagonals at 1, 1.25 and 1.5 m:
out of the chair by 0.3 s, a thud at 0.75 s, still by 1.1 s, away from the shooter and within
1.5 m of the seat, at least 80% of it in plain sight past the furniture round it, the view
bounds above, the arms flung up, out and back in, and a reeled body collected by the medics),
`tests/native-physical.test.ts` (the use action
at a body through tracked grips only, never through the gun hand, an open workspace or a refused
revival) and `tests/native-shot-stage.test.ts` (real office desks against a stand-in for the
server's window: the trigger path drops a practice target from five sides at 4 cm to 2.2 m and
sends only `worker.shoot`; staged shots go by listed worker ids, never by name: an unlisted shell
named `Target <n>` is refused, and so is a listed agent or worktree shell, while a listed plain
shell by any name can be staged; a free hand revives by touching or pointing; nothing revives
after the window) and `tests/practice-targets.test.ts` (the office names only a plain shell hired
with `target: true` `Target <n>`; the staging hires one at the desk clearest of real work, lists
its id, and sends only listed targets home, never while one lies inside its window). A debuggable build can hire a practice
target and stage a shot or a revival on the headset through the same paths; see
[debug staging](vr-native-android.md#debug-shot-staging).
A wearer still needs to
confirm comfortable holster reach, rung acquisition, pole release and striking feel. No synthetic
replay or browser render establishes physical headset ergonomics or worn-view sharpness.
