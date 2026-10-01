# Native Galaxy XR client

The current implementation targets an installed Android OpenXR app. The laptop continues
to run the existing Node office server. Both the normal desktop client and the headset
use its existing authentication, WebSocket protocol, workers, terminals, boards and floor
state. The headset uses the same first-person world and shared objects. Galaxy XR motion controllers
are now the only supported native control scheme; this supersedes the earlier hand-tracking
requirement. The left controller’s Menu button opens the APK-native settings. Its Office workspace
button opens shared office tools; using an occupied desk opens that worker's terminal. Grip must
not open or close panels. Dated installation and device results are recorded below.

## Current Vulkan renderer

Debug and release builds draw the office exclusively through `world_vk.cpp` and
`VkSceneRenderer`. There is no GLES or fixed-foveation fallback. The GLES sources and their
host checks remain a rendering reference, not an installed path. The dated device evidence
below describes the builds tested on those dates; it does not establish acceptance of the
Vulkan office renderer.

The Vulkan renderer uses `XR_KHR_vulkan_enable2`, a two-eye multiview render pass and
4× MSAA resolved in the subpass. Runtime-generated office material shaders compile with the
pinned NDK's shaderc, and Vulkan Memory Allocator 3.1.0 manages scene allocations. Packet parsing
and scene snapshots stay shared with the reference renderer in `scene_stream.cpp` and
`scene_frame.cpp`.

With foveation enabled, world colour swapchains carry
`XR_SWAPCHAIN_CREATE_FOVEATION_FRAGMENT_DENSITY_MAP_BIT_FB`. The META Vulkan swapchain chain
requests `VK_IMAGE_CREATE_FRAGMENT_DENSITY_MAP_OFFSET_BIT_QCOM`, plus subsampled images when the
device requires them. Runtime-provided density images are attached to the render pass. Each
frame updates the eye-tracked profile, queries `xrGetFoveationEyeTrackedStateMETA`, and ends
the pass with per-eye offsets using `vkCmdEndRenderPass2`. Off explicitly creates unfoveated
Vulkan targets. Missing required extensions, device features, eye permission or eye-tracked
system support are errors, not reasons to select a different renderer or fixed profile.
See the [Android XR extension reference](https://developer.android.com/develop/xr/openxr/extensions)
and the [OpenXR foveation specification](https://registry.khronos.org/OpenXR/specs/1.1/html/xrspec.html#XR_FB_foveation_vulkan).

Settings exposes the runtime profiles directly, in increasing order:

| Foveation setting | Runtime profile |
| --- | --- |
| Off | World swapchains without foveation support |
| Low | `XR_FOVEATION_LEVEL_LOW_FB` |
| Medium (default) | `XR_FOVEATION_LEVEL_MEDIUM_FB` |
| High | `XR_FOVEATION_LEVEL_HIGH_FB` |

The selected world resolution remains the eye-image size for every profile. The runtime chooses
the full-density gaze region and peripheral density; these levels do not specify a percentage or
expose a separate peripheral-resolution setting
([profile parameters](https://registry.khronos.org/OpenXR/specs/1.1/html/xrspec.html#XR_FB_foveation_configuration)).
Saved page settings and new native metrics use `off`, `low`, `medium` and `high`. Older saved
names migrate one-to-one (`clarity` → `low`, `balanced` → `medium`, `performance` → `high`).
Older APKs still receive version-one control packets with the older wire spellings. Hosts reporting
`nativeSettings: true` own their graphics choices; their control packets omit page graphics and the
page only mirrors the native values. The native host accepts both stored spellings and uses the
runtime names.

GPU timestamp pools reserve both views at each boundary. This avoids the observed Mesa
lavapipe crash when multiview query expansion outlives a render pass, while retaining GPU
timing in the host and headset renderers.

The renderer draws native controllers, rays, fade and the workspace cutout. Android Surface
panels remain compositor layers. The separate maximum-resolution sharp-screen layer is not
implemented in this Vulkan path: metrics report `sharpScreens: false`, and laptop screens
remain part of the world draw. The historical GLES sharp-layer measurements below must not
be presented as Vulkan capability or acceptance. Required checks remain populated-office
rendering, physical controller/panel behavior, eye-following foveation, laptop readability
and focused 1–2 minute timing runs with scene packets advancing.

Native lamps have no camera-facing additive bulb halos. `world/sky.ts` does not create their
point geometry, materials or halo texture on `/?native=1`; the physical bulbs, emissive
materials and room-lighting uniforms remain unchanged. Desktop and WebXR retain the original
halos. This removes the ceiling-lamp glow that appeared to turn with head movement without
removing the lamps' actual lighting.

## APK settings and shared office UI

Graphics settings belong to the APK, not the office server or its WebView. Android controls on the
compositor Surface update the native graphics snapshot directly and retain the settings in private
app storage. The renderer applies target changes on its display thread; a page reload, slow page or
stale page control packet cannot replace the selected native values. UI values and target application
are separate: changing a choice updates the control immediately, while native metrics report the
actually bound target/profile.

The local WebView retains the original office actions, authentication and server protocol.
Terminals, boards, task queue, meetings, changes, recovery dialogs and other office windows open on
the compositor workspace; native mode does not reject all modals or force its panel closed. A
trigger at an occupied desk opens the shared terminal, including its wake/recovery path. A paired
keyboard reaches the visible terminal or field instead of being redirected to a world laptop.
Single-choice dropdowns keep their choices inside the compositor Surface, preserving their original
input/change handlers. Physical grabs, climbing, the gong and gun remain native world actions.
Desktop-camera games (golf, basketball and the arcade) still need headset-specific controls.

World-space canvas images, including the hire menu and laptop screens, use a per-scene worker to
encode immutable ImageBitmap snapshots as compressed PNG/JPEG. Encoding and blob reads stay off the
WebView's window event loop; image bytes transfer back without copying. The bounded encode queue,
first-pixel priority, round-robin redraw fairness and packet backpressure remain in place. A worker
failure releases pending jobs; the immediate compressed fallback does not wait for window canvas
idle callbacks. Revisions describe the encoded snapshot, not a newer canvas repaint.

## Why the browser was struggling

The previous investigation found about 48–53 fps in the populated office on Chrome 153.
The GPU was heavily occupied, and browser rendering required separate eye draws plus a
4× MSAA renderbuffer resolve. The browser did not expose multiview or tile MSAA, and ignored
projection-layer fixed foveation. These measurements and their caveats are recorded in
[the WebXR handoff](vr-galaxy-xr-handoff.md).

A visually modest scene can still spend its frame budget on rendering overhead, transparent
surfaces, shader work and layer handling. A more detailed native game can use a different
rendering path and carefully budget those costs. Its appearance alone does not establish
that the browser should render this office at the same speed.

The 72 Hz limitation was observed in the tested browser configuration. It is not the
headset's maximum: the connected Galaxy XR advertises 60, 72 and 90 Hz to the native app,
and accepts its 90 Hz request. Android XR provides OpenXR 1.1 and vendor extensions, including
refresh-rate, hand, controller and gaze capabilities. Applications must check runtime
availability rather than assuming every listed extension works on every graphics path.
[Android XR extension reference](https://developer.android.com/develop/xr/openxr/extensions).

## Alternatives considered

Keeping WebXR would retain the existing code with the lowest maintenance cost. The tested
browser does not satisfy the mandatory 90 Hz target, so it is not the acceptance path.

Unity or Godot with OpenXR can produce an installed application with native rendering and
engine tooling. That route would require porting the office scene, interaction behavior and
desktop windows, or building an adapter to preserve them. It remains a reasonable fallback
if the renderer implemented here cannot meet its visual or sustained performance target.

The selected path keeps the existing scene authoring and office behavior, and moves the
headset display loop to OpenXR. This gives direct access to the tested device's rendering
features while preserving the server and desktop behavior. The tradeoff is responsibility
for a native scene renderer and its conformance to the scene features the office uses.

## Rendering and connection

`OfficeActivity` hosts the original office page at `/?native=1` in an Android WebView.
The page retains the original scene, player collision logic, networking and desktop windows.
It exports scene assets and changes; the native renderer draws them using the current
OpenXR eye poses. The WebView does not draw the main office world.

OpenXR owns the 90 Hz frame loop. Java pulls batches of native input and advances the
office's gameplay and scene updates at approximately 30 Hz. Parsing and scene preparation
run away from the render thread. Head and controller rendering use current native poses each
display frame rather than waiting for JavaScript's next update.

`office_xr.cpp` runs the API-neutral session: the instance, system and session, the reference
spaces, the Android Surface panels, input, the refresh preference, layer composition and the
metrics lines. Everything a graphics API draws sits behind one coarse seam, `WorldRenderer`
(`world_renderer.h`). `world_vk.cpp` is the installed renderer and owns the Vulkan binding,
world targets, scene and native input drawing. `world_gles.cpp` retains the GLES reference
implementation and is not compiled into the installed app.

The GLES scene renderer (`scene_renderer.cpp`) keeps only its GPU work. Two GL-free parts are
shared with the Vulkan renderer:

- `scene_stream.cpp` is the bridge side: packet apply, publish, reset requests and
  backpressure, with the texture changes queued in order.
- `scene_frame.cpp` is the frame planner: frustum culling and three's draw order, the
  controller-attached items, the laptop-screen plan and the prepare budget. It asks the backend
  what is on its GPU through `SceneResidency`.

### Locomotion presentation

The source now interpolates approved player-rig translation and rotation each display frame
between JavaScript updates. The interval follows native control receipt timing, bounded to
11.1–50 ms; normal 30 Hz locomotion gains approximately 33 ms of presentation latency.
Only the rig and fade use this presentation step. The latest OpenXR eye, head and controller
poses remain current each display frame. Original player collision, picking and server
positions remain authoritative, and the presenter never predicts beyond the last endpoint.

Teleports and snap turns carry a `presentationEpoch` discontinuity and take effect immediately,
including small teleports. Focus/reference-space changes, stale or interrupted updates and
legacy large jumps also reset interpolation. Full-black fade takes effect immediately;
world-space hover and teleport markers stay anchored through the same presented rig.
Held world-object transforms still arrive through the approximately 30 Hz scene stream and
are not smoothed by this helper.

Pure C++ tests exercise constant 30 Hz updates presented at 90 Hz, quaternion wrap, resets,
fade and invalid inputs with address/undefined-behavior sanitizers. Native compilation and
control regression checks passed. The combined APK containing this presenter is installed
on the headset and has produced fresh populated-office 90 Hz windows. The earlier two-minute
baseline below predates this change; it is retained as a comparison.

### Scene exporter

The exporter still samples the complete current scene. It caches geometry identity, versions
and shape signatures, inspects each source once per capture, and compares supported live
material fields before serializing changes. Geometry sharing requires exact buffer equality;
built-in parameter names alone cannot identify a shape. The corrected comparison keeps
differently buffered geometry distinct while retaining unchanged aliases after an edit.

Initial texture pixels take priority over re-encodes; loaded dynamic textures receive fair
round-robin updates. Failed encodes retry with backoff, and source changes during an encode
remain queued. Packet revisions, partial updates, bounded drains, reset/commit semantics and
backpressure are unchanged. All 32 native-scene tests and targeted lint/type checks passed.

In a host-only office fixture with 1,195 objects, DOM drawing and image compression stubbed,
mean capture-plus-drain cost fell from 2.471 to 1.168 ms. This sequential host measurement
does not establish Galaxy XR timing or encoding performance. The exporter improvements are
included in the installed combined build. Device measurements still include image encoding
and the rest of the application; the host-only improvement should not be read as a device speedup.

### Historical GLES display and workspace

The GLES-specific rendering and foveation details in this subsection describe the reference
implementation and earlier headset builds. The current Vulkan path is described above.

The display path uses GLES multiview for both eyes, with 4× tile MSAA where supported.
Foveated rendering is owned by the OpenXR runtime, as described in
[Runtime foveation](#runtime-foveation). Depth attachments inherit the colour attachment's
foveation; they are not independently foveated
([QCOM_texture_foveated](https://registry.khronos.org/OpenGL/extensions/QCOM/QCOM_texture_foveated.txt) issue 5).

### Runtime foveation

This subsection records the earlier GLES implementation, including its filter and fallbacks.
Neither is used by the installed Vulkan render path.

The app no longer computes focal points or writes `GL_QCOM_texture_foveated` state. Earlier
builds steered app-side focal points from the eye-gaze interaction pose with invented gain,
area and density values. The current build uses fixed runtime foveation, the OpenGL ES path
Android XR documents: its Unity "Foveation (Legacy)" feature "also supports … OpenGL ES" with
only the three FB extensions below, while its eye-tracked foveated rendering is Vulkan-only
([Develop with Unity](https://developer.android.com/develop/xr/unity)). Each extension is enabled
only when advertised
([OpenXR extensions](https://developer.android.com/develop/xr/openxr/extensions)):

1. `XR_FB_swapchain_update_state`, `XR_FB_foveation` and `XR_FB_foveation_configuration`.
   Only the world colour swapchain is created with
   `XrSwapchainCreateInfoFoveationFB{XR_SWAPCHAIN_CREATE_FOVEATION_SCALED_BIN_BIT_FB}`, the flag
   the registry defines for OpenGL with `QCOM_texture_foveated`. Depth, the sharp-screen layer
   and the Android Surface panels stay unfoveated.
2. A profile (`XrFoveationProfileCreateInfoFB` → `XrFoveationLevelProfileCreateInfoFB`, static,
   vertical offset 0) is applied with `xrUpdateSwapchainFB` right after the swapchain is created,
   as Meta's GLES sample (`ovrRenderer_Create`, then `ovrRenderer_SetFoveation`) and Godot
   (`on_main_swapchains_created`) do, and the same profile once more after `xrBeginSession`.
3. Every foveation choice creates new world targets, through the same staged replacement as a
   resolution change. On Galaxy XR the runtime keeps the first profile a world swapchain
   receives: in the 2026-10-01 headset run, Off as the empty profile left
   `GL_TEXTURE_FOVEATED_FEATURE_BITS_QCOM` at 3 and the foveated pattern unchanged, and Balanced
   to More headroom gave identical density maps, until the targets were recreated.
   `GL_QCOM_texture_foveated` also says foveation "cannot be disabled" on a texture once enabled.
   So Off creates swapchains without `XrSwapchainCreateInfoFoveationFB`, which have no foveation
   support (`XR_FB_foveation`), and a level creates them with it and applies that level first.
4. No eye tracking. Earlier builds chained `XrFoveationEyeTrackedProfileCreateInfoMETA` and
   called `xrUpdateSwapchainFB` and `xrGetFoveationEyeTrackedStateMETA` every frame. On Galaxy XR
   that query returned `XR_ERROR_RUNTIME_FAILURE` on 13,092 of 13,092 frames of a GLES session,
   and the runtime logged `Using static model` for the eye-tracked profile: its GL client
   compositor has no eye-tracked state and applies the level only. So the GLES renderer neither
   enables `XR_META_foveation_eye_tracked` nor queries it, and reports `mode: "fixed"`. Eye-tracked
   foveation needs the Vulkan world renderer (fragment density map offsets).
   `XR_EXT_eye_gaze_interaction` stays bound as an interaction pose for the metrics.
5. The profile is destroyed before the swapchains and the session.
6. Reduced regions are filtered, not submitted in blocks. `GL_QCOM_texture_foveated` renders a
   scaled bin at reduced density and "finally upscal[es] the subregion to the native texture
   resolution" (issue 2); on Galaxy XR that repeats each low-density pixel, which the
   2026-10-01 headset captures showed as 4–8 px stair-steps and hard tiles in the periphery.
   Android XR documents bilinear filtering of low-density regions only through a subsampled
   layout ("Reduces aliasing in peripheral areas through bilinear filtering",
   [Android XR Extensions settings](https://developer.android.com/develop/xr/unity/performance/androidxr-extension-settings)),
   and OpenXR offers that only for Vulkan swapchains. So a level creates two sets of world
   swapchains of the same size: the foveated set above, which the world renders into
   (`XR_SWAPCHAIN_USAGE_SAMPLED_BIT` as well), and the submitted set without foveation support.
   The last draw into the foveated image writes, per axis, which block of the driver's upscale
   each pixel belongs to into its alpha, which the opaque projection layer ignores: the block
   width from `dFdx`/`dFdy` of `gl_FragCoord` (issue 4 leaves them uncorrected, so the step is
   1/density) and where blocks start, from `gl_FragCoord` itself (issue 4 scales it to the
   invocation's full-resolution position). Widths of 1, 2, 4 and 8 pixels and every start fit
   in four bits per axis; the Galaxy XR diagnostic view showed steps of 1, 2 and 4 or more
   almost everywhere (the view now marks any other width in blue).
   A full-screen pass then draws the submitted image: full-density pixels are copied unchanged,
   and every pixel of a reduced bin takes one linear tap between its own block and the nearer
   neighbouring block, placed so its weight is the distance between the blocks' centres. That is
   exactly a bilinear upsample of the bin's low-density pixels, on each axis separately, so a
   bin reduced on one axis is only resampled along that axis. A block the code cannot describe
   (another width, or a start off the pixel grid) is smoothed [1 2 1] / 4 instead. The runtime
   still chooses the density everywhere and places the fovea; the app never writes QCOM state.
   The pass costs one extra read and write of the eye images and doubles the world swapchain
   memory. If the filter's programs do not compile, or the second set cannot be created, the
   foveated set is submitted directly for the rest of the session (fallback `filtered targets
   rejected`).
7. Priming. Applying a profile only stores it with a Galaxy XR GLES swapchain: the runtime writes
   `GL_TEXTURE_FOVEATED_FEATURE_BITS_QCOM` and the focal points of all of a swapchain's images when
   that swapchain is submitted in a projection layer (its projection layer registers the
   swapchain, and the GL client compositor's layer commit applies the profile, in
   `libopenxr_android.so`). A foveated set that is never submitted is never foveated: the
   2026-10-01 headset run read 0 bits on every image of it, and the filter never ran. So each pass
   reads the bits of the foveated image it has acquired, until that image is foveated, and
   submits it directly while it is not (`FOVEATION_PRIMED` when an image first reads foveated).
   Such an image is drawn at full density, so the frame looks the same; the first submission
   foveates every image of the set, and from the next frame on the pass is filtered. Foveation
   "cannot be disabled" on a texture once enabled (`GL_QCOM_texture_foveated`), so an image read
   as foveated is not read again. If eight direct submissions leave the set unfoveated, the
   targets fall back to unfiltered ones (`filtered swapchain not foveated`).
8. Nothing else in the world pass changes from bin to bin. QCOM issue 4 also leaves
   `gl_PointSize` unscaled, so GL points changed size and dropped out between bins, which showed
   as rectangles of missing lamp and pumpkin glow. Points are drawn as instanced quads of the
   same square instead (indexed points, which the office does not use, stay GL points).
   Derivative-based shading (the Standard material's geometry roughness, the toon fallback ramp)
   divides by the measured step, so it matches across bins.

In these builds the page owned the settings and the native host mirrored them into
`files/native-graphics.json`. The installed APK owns them instead, as described in
[APK settings and shared office UI](#apk-settings-and-shared-office-ui); it still creates the
first world targets from that file, so a stored Off starts without foveation.

| Setting | World targets |
| --- | --- |
| Off | Created without foveation support: full density everywhere, no filter pass |
| Wider sharp area (`clarity`) | `XR_FOVEATION_LEVEL_LOW_FB`, filtered |
| Balanced (default) | `XR_FOVEATION_LEVEL_MEDIUM_FB`, filtered |
| More headroom (`performance`) | `XR_FOVEATION_LEVEL_HIGH_FB`, filtered |

The level mapping is the app's choice; Godot uses the same order. The runtime levels have no
density parameter, so the earlier peripheral-detail setting is gone. Pages still send
`peripheralDensity: 0.25` because APKs up to v0.1.301 reject graphics without it; current APKs
ignore it. If something fails, the app degrades one step for the session: filtered targets
that cannot be created, or whose foveated set the runtime never foveates, fall back to
unfiltered ones, and a level the runtime rejects falls back to world swapchains without
foveation support (full resolution everywhere).

`FRAME_METRICS` carries `foveationSupported`, `foveationEnabled` and `foveationLevel` for the
bound targets. The details are a separate `FOVEATION_METRICS` line, because together they
exceeded Android's 1024-byte log record, and the page receives them as `foveation`: `setting`,
the bound `level` (`none`, `low`, `medium` or `high`), `mode` (`fixed` or `off`), `eyeTracked`
(always false), `filtered` and `filterAvailable` (the reconstruction above), the window's world
passes by how they were submitted (`filteredFrames`, `primingFrames`, `underlayFrames` for the
workspace panel beneath the world), `primed` (every foveated image is foveated), `pending` (the
setting asks for other targets, which follow within about 250 ms), the profile
`create`/`update` results, the probed texture state and `fallback`. New targets also update the
page's copy at once, without waiting for the next window. The log also has
`FOVEATION_CAPABILITY`, `FOVEATION_FILTER` and `GRAPHICS_START` (the stored settings) at startup,
`VIEW_FOV` (each eye's field of view in degrees) after focus, `FOVEATION_PROFILE` for every
applied profile, `WORLD_TARGET` (with `filtered`) for new targets, `FOVEATION_PRIMED` and
`FOVEATION_TEXTURE` for each image the world renders into. The texture line reads
`GL_TEXTURE_FOVEATED_FEATURE_BITS_QCOM`, `_MIN_PIXEL_DENSITY_QCOM` and the focal-point count
back from the image on its second frame (the first frame of a new image read 0 bits on the
headset although every frame was foveated): 0 bits for Off, and bits of 0 at a level mean the
runtime does not foveate this GLES swapchain.

**Graphics & performance → Show rendering detail (diagnostic)** draws a full-screen pass into
the foveated world target, before the filter's step pass. Its fragments run at the runtime's
actual density: green, yellow,
orange and red mark a neighbour step of one, two, three and four or more full-resolution pixels
(from `dFdx`/`dFdy` of `gl_FragCoord`, which QCOM issue 4 leaves uncorrected), blue marks blocks
the filter's code cannot describe and only smooths, and a one-pixel checker can only be resolved
at full density (the filter rebuilds it elsewhere). On foveated targets a white ring marks the
image centre (NDC 0, 0, `GL_QCOM_texture_foveated`'s default focal point); it is computed, not
measured. Reading density
from derivatives is derived from the QCOM text, not a documented debugging aid. The view is
not saved and turns off when the app restarts. Pages can also switch it with
`officeNative.graphics.set({ foveationDebug: true })`.

Not documented anywhere, and so still headset checks: that the first direct submission foveates
every image of the foveated set (`FOVEATION_PRIMED` … `complete=1`, then `filteredFrames` and no
`primingFrames` in `FOVEATION_METRICS`), where in its block a reduced bin's `gl_FragCoord` sits
(the code accepts the block centre and the centre of its first pixel), and that the bins' widths
are ones the code describes (no blue in the diagnostic view). The 2026-10-01 headset runs showed
that the runtime foveates GLES scaled-bin swapchains it is given in a projection layer (bits 3 at
every level; app GPU frame time 32.5 ms with Off and 7.1 ms with Balanced at 116% resolution,
measured with each state on freshly created targets, before the filter ran), keeps the first
profile of each swapchain, and leaves a never-submitted one at 0 bits.

The original desktop windows, including terminals, are displayed through a 2400×1600 Android
Surface compositor layer. This preserves text resolution independently of world foveation.
Its producer stops before `xrEndSession`, following the
[Android Surface swapchain contract](https://registry.khronos.org/OpenXR/specs/1.1/man/html/xrCreateSwapchainAndroidSurfaceKHR.html).
The headset UI has larger targets and adjustable terminal text, and no on-screen keyboard: a
keyboard paired to the headset types into the open terminal or the focused field, because
`OfficeActivity.dispatchKeyEvent` forwards its keys to the page. Only the sign-in page docks a
controller keyboard, for the office password (`src/client/login.ts`).
Every launch and page reload starts in the office with the workspace closed. Nothing opens Home
by itself; the left controller's Menu button does (`native/ui.ts`, `tests/native-launch.test.ts`).
Before the office page sends its first packet, the panel shows the app's own connection screen,
and that packet closes it.
With the workspace closed, one small Android Surface shows only the FPS counter, when that
Graphics setting is on, and each toast while it lasts. The renderer shows its two columns as
separate head-locked quads (`status_layout.h`). A toast sits in a card fitted to its text,
1.4 m ahead and about 16 degrees below the line of sight. The counter has no card: it is faint
text, 0.7 degrees tall (Android XR's 14 dp minimum), facing the eyes from the lower-left edge of
the view. It starts about 31 degrees left of the line of sight, on a line 27 degrees below it,
so it never lands on the face of a worker the player looks at. It hides while a tracked
controller is in front of it, so no text is drawn across the player's hand, and returns 0.3 s
after the hand moves away. The native page names no controls:
no aim labels, carry, climbing or gun hints, "press E" toasts, key legends or world signs
(`controlHintsShown` in `src/client/native/mode.ts`). Boards state only what is so: the empty
Services board says that no web servers are running, without the desktop line on how it fills,
and the DroidProxy refresh key on the machine monitor carries only its ↻ glyph. The Controls
window, opened on purpose, still lists the controller roles. Desktop and WebXR keep their hints.
No name, status bubble, task card, light or pitch floats over a character either
(`floatingTagsShown`): a worker wears no antenna or status bulb, and its headset band runs from
ear cup to ear cup. A worker's name and engine are engraved on its seat's nameplate
(`src/client/world/nameplate.ts`), lit by the room like the desk or chair it is on: a brass
plate on each sloped face of a wooden name block lying on its desk (one toward the chair and the
aisle behind it, one toward the desk's front), or a brass plate on the back of its bean bag or
meeting chair. A status lamp beside it, a lit dome in a steel collar, glows in the worker's status
color, breathing while it works and blinking while it waits on someone: on the desk in front of
the block's end, on the plate's top edge, or on the kiosk counter's front corner. The title bar
across the top of its laptop's screen says the rest, as a terminal window's does: its name and
engine on the left, and what it's on and its state, a colored dot and a word ("READY"), on the
right (`Laptop.setTitle` in `src/client/world/laptop.ts`). A teammate wears a name badge on their
shirt. A board agent's kiosk has a screen set into its front instead, and no "Ask me" sign: its
screen shows the agent's name, its board and its state. The first trigger pull
at the kiosk greets the agent, which looks up while the screen says what it does; the screen goes
back to the nameplate once you ask it something or walk away, and the next pull opens the ask
form.
The office's signs are printed objects too (`signsPrinted`, `textPlane` in
`src/client/world/toon.ts`): each is a plate on a board fixed to a wall, a shelf, a beam, a post or
a rail, its face lit by the room with a little light of its own so it reads in the dark, its
board's steel or wooden edge showing round it, and its words without emoji ("↑ floor-beta" on the
wall beside the ladder). A sign that is a black tag with white words on the desktop is white enamel
with dark letters (`enamel`), which shows the room's light and shade as a black face can't. None hangs in the air: the boards' titles sit flat on the wall over them,
the bookshelf's "Docs" board stands on the shelf's crown, the fire pole's sign is strapped under its
railing's top bar, and the golf hole's sign spans both its posts (`tests/native-nameplates.test.ts`
casts rays behind and under every sign). An exit sign stays lit from inside. Desktop and WebXR keep
their flat glowing labels.
A board's problem says only what is wrong (`worldNotice`), never what to type to fix it.
While the workspace is open, its layer is composited beneath the world layer, which shows it
through a hole so the player's controllers, rays and held gun stay in front of it, and the toast
card fades while a hand is in front of it (see
[Hands in front of compositor panels](vr-native-controller-interactions.md#hands-in-front-of-compositor-panels)).
While the panel is beneath the world layer, the foveation filter pass is left out
(`filterFrame` in `foveation.h`): it keeps its density codes in the world image's alpha and
submits opaque pixels, which would cover the panel, so those frames submit the foveated world
image as drawn, with the driver's blocky periphery and the same GPU savings, until the workspace
closes.
On Galaxy XR, the workspace's virtual display also requests 90 Hz using Android's
[virtual display configuration](https://developer.android.com/reference/android/hardware/display/VirtualDisplayConfig.Builder).
The connected headset reports that display at 90 Hz; its previous default was 60 Hz.

### Controllers and Surface lifecycle

The installed combined APK uses motion controllers only. It does not enable hand tracking or mesh
extensions, request hand permission, bind hand interactions or compile the hand renderer into
the app. Earlier hand-mesh source and host checks remain as historical work; they are not an
available native control scheme. WebXR retains its existing hand controls.

The controller renderer uses the actual Samsung Galaxy XR left and right controller assets
from the MIT-licensed WebXR input profiles repository, pinned at commit
`f4992299601614adbfefd398dc8e281556bb7444`. The bundled attribution and conversion inputs are
under `native/android/app/src/main/assets/controllers/samsung-galaxyxr/`. Grip poses, trigger,
grip and thumbstick animation use current native input. The installed runtime loaded both
meshes and their shaders. Controller appearance and ergonomics still need explicit physical
confirmation.

The controller-only workspace uses controller rays, trigger press, drag,
hover and stick scrolling through the original Android pointer path. Tracking loss cancels contact.
Host replay checks cover these transitions; a replay does not establish physical comfort.
The 37 controller regression tests pass, including grip/menu mapping, ignored hand packets,
button latches on reconnect, a 400 ms tracking-loss grace period for carried objects, and
cancellation of a stick teleport when its controller disappears. Mutation checks showed that
restoring each reported bug makes its regression fail. Focus loss still returns a carried card
immediately. Carried object poses still travel through the 30 Hz scene stream.

Held board cards keep the original card geometry and text, with a 28 cm width, positioned
5 cm above and 6 cm forward of the controller grip. Their text face points back along the
controller's grip axis toward the holder in a neutral forward-pointing pose. The card follows
wrist pitch, yaw and roll; it does not rotate itself toward the headset. Both physical near
grabs and ray/window pickups use the same grip-relative placement. The carry message sends
the grip's world pose so peers apply that placement once. A post-release review found and
fixed ray/window pickups sending the already-offset card pose, which placed peers' copies
another 5 cm up and 6 cm forward. Both new left/right regressions failed before the fix and
passed after it, comparing owner and peer positions and rotations across wrist poses.
These checks establish transform consistency. Readability at a comfortable holding angle,
controller occlusion and the feel of the 30 Hz held-object stream still need physical review.

| Controller action | Office behavior |
| --- | --- |
| Left Menu | Toggle the workspace |
| Trigger | Use the aimed worker, board, elevator button or panel control |
| Grip | Grab a nearby object, or return a carried issue card; never toggle or close a panel |
| Thumbsticks | Original VR locomotion/turn settings; scroll while pointing at the workspace |

The native bindings use the runtime's Touch controller profile for Galaxy XR, with a simple
controller fallback. Both profiles bind the physical Menu action on the left controller only.

A real UI freeze was traced to the hidden status panel's Canvas producer filling an unconsumed
BufferQueue and blocking Android's UI thread. The installed fix stops that producer while its
quads are hidden and keeps consuming the Surface until the UI thread acknowledges shutdown. While
the producer runs, at least one status quad is submitted: the toast column, transparent without a
toast, does that alone while the counter is off or covered and while the workspace is open. The
WebView's scene packets and control heartbeat then continued advancing while opening and
closing the workspace. Native FPS alone would have concealed this freeze.

### Laptop-screen sharpness and refresh preference

The separate sharp-screen pass described here belongs to the historical GLES renderer.
The Vulkan office renderer does not yet implement this pass.

On 2026-09-29 the owner physically wore the headset and reported that the office looked good,
except for pixelated worker laptop terminal screens even at the highest graphics settings.
Those screens already use lossless 2048×1360 canvases, and the native exporter preserves that
size. Increasing the source bitmap alone would not establish a fix. The default world render
uses the runtime's recommended 1856×2160 eye size, below its 3152×3682 maximum, with gaze foveation.
A separate full-resolution, unfoveated, depth-occluded pass for nearby laptop screens is
installed. It keeps the original screen contents, placement and picking, and must not
render screens through walls or the motion controllers. Physical text readability and
consistent 90 Hz in required views remain acceptance checks.

The sharp pass uses the original screen geometry and lossless texture at the runtime's maximum
eye resolution. The original world screen remains as a fallback. Only nearby, visible screens
with resident textures and linked shaders qualify; selection is capped at 16 within 6 metres.
The pass samples the original world depth, including controllers, and preserves glass in front
of a screen. Its extra drawing is bounded to the screens' projected area. The high-resolution
swapchain is separate from world foveation and resolution settings, and is used only when
qualifying screens are visible. Debug builds probe resolved world depth once before using it;
device occlusion and GPU cost remain part of acceptance.
The graphics menu now includes a persistent **Sharper laptop screens** checkbox, enabled by
default. Turning it off uses the original world screen and allows a direct comparison of the
extra layer's cost. Existing saved settings default to enabled. This control is available in the
installed setting-enabled APK; disabling it is not a substitute for meeting the sharp-screen
90 Hz requirement.
Host framebuffer checks cover matching original screen/glass colors, lower-resolution depth,
oblique lids, a 3.5 cm foreground occluder, two depth-array layers, fade and scissor restoration.
The screen pass currently redraws transparent meshes and sprites, but not transparent points,
lines or instances; rain or snow particles in front of a screen can therefore differ from the
world pass. The layer also remains limited by the detail in the original source canvas.

### Maximum world resolution and terminal glyphs

On 2026-09-30 the owner captured two defects while wearing published `v0.1.284`: Nerd Font
symbols collided or clipped in the workspace terminal, and the physical laptop screen looked
blurry at the highest settings. The settings' old 100% ceiling meant recommended eye resolution,
not the runtime maximum. The graphics panel now has a controller-operated slider, 1% step
buttons and **Recommended** / **Maximum** presets. It reports selected and applied eye pixels,
the recommendation and runtime bounds. At this headset's reported limits, the uniform multiplier
reaches approximately 169.8%, or 3152×3668 per eye, within the 3152×3682 runtime limit.
These are OpenXR render-image dimensions, not a claim of one render pixel per physical panel pixel.

The GLES implementation described in this subsection allocates matching world targets,
bounded by both eye views, OpenXR system
limits and GLES texture limits. The default does not allocate maximum-size world targets.
Slider dragging previews the choice and applies it on release; native target changes wait
250 ms for a stable choice. Replacement starts on the GL thread with no acquired world images.
Each staged swapchain then acquires and waits for one image, validates the real color/depth
attachment and tile-MSAA configuration, clears and finishes GPU work, and releases the image
before promotion. A wait timeout or failed allocation/completeness check retains the current
targets. GPU commands complete before old swapchains are destroyed. Scene assets, player state,
Android Surfaces and panel resolution are retained.

**Foveated rendering** choices, including Off, allocate new targets the same way
([Runtime foveation](#runtime-foveation)). The shader, controller and sharp-screen depth mapping
use the actually allocated world dimensions. The native app reports foveation availability and
the bound targets.
[OpenXR swapchain destruction](https://registry.khronos.org/OpenXR/specs/1.1/man/html/xrDestroySwapchain.html).

The log windows adjacent to the blurry-laptop screenshot already had a resident, active
3152×3682 unfoveated screen layer, valid gaze, 103 textures and no pending uploads. The original
2048×1360 PNG was preserved and sharp at its source size. Its 130×31 terminal grid used a
25.93 px source font, with a right prompt extending to column 129; the captured eye minified
that texture by approximately 1.4–1.5×. Raising world resolution alone cannot establish a fix
for this capture. The [terminal glyph correction](terminal-glyphs.md) fits the bundled Nerd
Font icons to Geist Mono's 0.6em cells and waits for fonts before measuring terminals.
The actual captured terminal grid replay now preserves `main` and its adjacent symbols;
idle laptop canvases repaint after font loading. The original terminal content, right
prompt, placement and picking stay authoritative. Browser replay verifies the source glyph
correction; it does not establish worn-headset text readability.

The [sharp-screen sampling check](vr-native-screen-sampling.md) adds a conservative half-mip
bias only to original laptop textures in the separate sharp layer. It retains anisotropic
mip filtering at oblique angles and distance; world draws and transparent overlays keep their
existing sampling. Fine-glyph framebuffer fixtures measure a modest contrast improvement,
with unchanged unaffected pixels and filtered distant checkers. This is a sampling correction,
not evidence that the owner's worn-headset blur report is fully resolved.

The combined Node 22 checks passed lint, typechecking and all 646 coverage tests
(84.55% lines, 80.66% functions). Actual graphics-panel browser fixtures passed at 1600×1019
and 1280×720, including a 300 px keyboard boundary, the exact maximum endpoint and allocation
failure feedback, with no overlapping rows or horizontal overflow. Controller pointer targets
remain at least 44 px. Sampling framebuffer checks passed on macOS ANGLE and Linux Mesa 25.2.8
with ASan/UBSan: the captured minification range gained modest fine-glyph contrast while world
and overlay pixels remained unchanged within one channel level. These checks do not replace
native resolution/foveation transitions and focused timing measurements on the Galaxy XR.
All twelve combined native host checks and both Android build variants passed; the release
candidate's signature and 16 KB APK alignment were verified with the existing signing lineage.
The exact published APK is now installed. Actual headset resolution/foveation transitions,
loaded-font measurements and Android panel captures passed; the device evidence and remaining
physical acceptance checks are recorded below.

### Refresh preference and connection boundaries

The app already requests 90 Hz at startup, session start and restored focus. A bounded,
persistent 90 Hz preference is now in source: it polls the actual rate once per second and
re-requests 90 after a drop, backing off to at most one request per 30 seconds. Pure host tests
cover retries, focus and recovery. That change is installed; the runtime reports 90 Hz during
the current focused checks. Recovery from a real subsequent 72 Hz switch still needs evidence.
The API returns request acceptance, not a guarantee that Android XR will honor the requested
rate; the app continues to display and record the actual rate. See the
[refresh request contract](https://registry.khronos.org/OpenXR/specs/1.1/man/html/xrRequestDisplayRefreshRateFB.html).
The bridge also reports live session focus, so a sleeping headset shows a paused session instead
of presenting its last frame-rate window as a current reading.

The owner accepts ordinary Galaxy XR thermal throttling and does not want cooling pauses.
Keep thermal/clock counters as diagnostic evidence, without attributing a mode change to
thermal state alone or stopping the app to cool it. Use focused 1–2 minute checks.

The WebView loads only the office origin the user selects. There is no privileged JavaScript
interface and no certificate-error bypass. User-selected external issue, PR and documentation
links open through Android's browser. Microphone requests require the chosen office origin,
recent user input and Android permission.

### Vulkan eye-tracked foveation spike (debug builds)

This Android XR runtime gives eye-tracked foveation only to Vulkan sessions: its OpenGL ES
compositor fails `xrGetFoveationEyeTrackedStateMETA` on every frame and always uses its static
model. Debug builds also contain a separate Vulkan test session (`vk_spike*.cpp`,
`shaders/vk`). It renders a world-locked test room, never the office, and connects to no office.
The default debug and release route is the Vulkan office renderer. Release builds do not compile
the test-room session (`OFFICE_VULKAN_SPIKE` is set only for the debug build type) and ignore the
test-room switch; shared Vulkan GPU and shader support is compiled into both variants.

It follows Godot's working Vulkan path:

- `XR_KHR_vulkan_enable2` creates the instance, device and session.
- The world swapchain carries `XrSwapchainCreateInfoFoveationFB{FRAGMENT_DENSITY_MAP}` and
  `XrVulkanSwapchainCreateInfoMETA{FRAGMENT_DENSITY_MAP_OFFSET}`.
- Each runtime density image is attached to the multiview render pass.
- Each frame runs acquire, wait, `xrUpdateSwapchainFB` and `xrGetFoveationEyeTrackedStateMETA`,
  records the pass, and ends it with per-eye offsets in `vkCmdEndRenderPass2`.

A density overlay colours each fragment by its `gl_FragSizeEXT` area: green 1 px, yellow 2, orange
4, red 8, magenta larger. A white cross marks the map's centre: the eye's optical axis (from its
asymmetric field of view, not the image centre) plus the applied offset. The
Android Surface workspace panel and status card are still created in the Vulkan session; the
panel describes the overlay (it names no controls, as nothing in the headset app does) and the
status card shows the live eye state.

Start it (the app must be stopped first, because the activity is `singleTask`):

```bash
adb shell am force-stop dev.droidoffice.xr
adb shell am start -n dev.droidoffice.xr/.OfficeActivity --es xr_renderer vulkan-spike \
  --es vk_msaa 4 --es vk_offsets eye --es vk_level high
```

| Extra | Values (default first) |
| --- | --- |
| `vk_msaa` | `4` (resolved in the subpass), `1`, `4ms` (`VK_EXT_multisampled_render_to_single_sampled`, when the device has it) |
| `vk_offsets` | `eye`, `none` (count 0), `sweep` (synthetic offsets, 3 s per point) |
| `vk_level` | `high`, `medium`, `low`, `none` |
| `vk_overlay` | `1`, `0` |
| `vk_fixed` | `0`, `1` (profile without the META eye-tracked struct) |
| `vk_foveation` | `on`, `off` (no foveation struct on the swapchain) |
| `vk_flip` | `none`, `x`, `y`, `xy` (axis of `foveationCenter`) |
| `vk_profile` | `live` (one profile re-applied each frame), `per-frame` (Godot's create, update, destroy) |
| `vk_subsampled_probe` | `0`, `1` (create a subsampled swapchain once and log the result) |

Controllers change modes live: right trigger cycles the level, right A the offsets mode, right B
the overlay, left trigger switches eye-tracked and fixed, left X the status card, left Y the flip
and left Menu the panel.

The log lines, all with tag `OfficeXR`:

- `VK_CAPS` gives the extensions, the FDM, offset and multiview features, the texel size, the
  offset granularity, lazily allocated memory and the instance layers.
- `FOVEATION_VK_SWAPCHAIN`, `FOVEATION_VK_IMAGES` and `FOVEATION_VK_GATES` give the create
  results, the density image size and what blocks the eye-tracked path.
- `FOVEATION_VK_PROFILE` gives each profile's create and update results.
- `FOVEATION_VK` runs per frame, rate-limited: every change, the first frames after a mode change,
  and one per second. It gives the update and state results, flags, `valid`, both centres and the
  applied offsets.
- `FRAME_METRICS` has `renderer` and `msaa` besides the keys `harness/metrics.sh` reads.
  `FOVEATION_METRICS` has the window summary (queries, successes, valid frames, last result,
  centres and their spread, offsets); the page receives it as `foveation`. In M1 the summary
  sat inside `FRAME_METRICS`, which then passed Android's 1023-byte log record and lost its world
  size. `RUNTIME_METRICS` and `SCENE_METRICS` keep the shape `harness/metrics.sh` reads.
- `VIEW_FOV` gives each eye's field of view in degrees and its optical axis in pixels, after
  focus.

Eye-tracked foveation is proven only when all of these appear together:

- the runtime logs `[FoveationManager] Using eye tracked model with level N` (not `static model`);
- `FOVEATION_VK ... state=0 ... valid=1` appears on nearly every frame;
- the centres change when the wearer looks around;
- the overlay's green patch follows the eyes.

The runtime sets `valid` whenever eye-tracked foveation is enabled, so `valid=1` on an unworn
headset proves nothing about tracking. The offset sign, the eye index and whether the runtime
or `VK_LAYER_ANDROID_foveation` already moves the map are measured with `sweep`, `none` and a
wearer. They are not assumed.

## Build and install

The Android project uses Gradle 8.13, JDK 17 or 21, Android SDK 35, NDK 27.2.12479018 and
CMake 3.22.1. The first build downloads the pinned OpenXR loader and native dependencies.

```bash
npm ci
npm run build
native/android/gradlew -p native/android --no-daemon :app:assembleDebug
adb install -r native/android/app/build/outputs/apk/debug/app-debug.apk
```

Set `ANDROID_HOME` and `JAVA_HOME` for the installed SDK and supported JDK if needed.
The app is `dev.droidoffice.xr`; its launcher name is **Droid Office XR**. Select the
laptop under **Nearby offices**, then sign in with the normal office account or password.
The laptop must run a build containing the native page adapter.

### Connect to your laptop

1. Start the current Droid Office server on your laptop: `droid-office /path/to/project`.
   Its normal default listens on the LAN at port 4600. Keep the laptop awake and use the same
   Wi-Fi network on the laptop and headset.
2. Open **Droid Office XR** on the headset. Under **Nearby offices**, point at your laptop
   and press the controller trigger. The picker includes the laptop name and server address.
3. Sign in with the server's existing office password or account. The installed app retains
   the normal office session and player profile.

After a successful page load, the app saves that office and automatically opens it on its next
ordinary launch. **Change office** returns to the picker, and **Reconnect to last office** retries
the saved address. A failed or offline connection returns to the picker without replacing that
saved office. If the laptop's IP changes, select its newly discovered address; a new origin may
require signing in again.

**Enter an office address** reveals the controller keyboard for a manual connection, for example
`http://192.168.1.26:4600`. Use your laptop's actual LAN address and port. This also works with older
servers or networks that block discovery. **Search again** restarts a nearby scan. A server bound
only to `127.0.0.1` is reachable through the USB forwarding setup below, rather than through Wi-Fi.
Nearby connections use the resolved LAN IP. For HTTPS with a certificate issued to a hostname,
enter that hostname manually unless the certificate also covers the displayed IP; certificate
validation stays enabled.

The laptop advertises `_droidoffice._tcp.` using DNS-SD; the headset uses
[Android network service discovery](https://developer.android.com/develop/connectivity/wifi/use-nsd).
The announcement contains a display name, address and port, with TXT `v=1` and `scheme=http|https`.
Passwords, session tokens, project paths and worker details are absent. Discovery stops on
connection, app pause, hidden XR session and destruction; callbacks and resolutions are bounded
and run outside the rendering loop. The picker scrolls, and its manual keyboard stays collapsed
until requested. `--no-discovery` or `DROID_OFFICE_DISCOVERY=0` disables the laptop advertisement.

The existing `npm run vr` QR code opens the browser WebXR route. It does not launch or pair the
installed app; the native app's nearby picker avoids the need for camera scanning.

### Release APK

Releases on `main` include **droid-office-xr.apk** and **droid-office-xr.apk.sha256** alongside
the desktop package. The release variant is optimized, has WebView debugging disabled, and
omits the development-only depth readback. Install it with `adb install -r droid-office-xr.apk`.
Its version name matches the desktop package; its version code increases with the commit count.

For a local signed build, export the signing variables documented in `.env.example`, set
`JAVA_HOME` and `ANDROID_HOME`, then run:

```bash
bash native/android/build-release.sh 0.1.270
```

This builds, aligns, signs and verifies the APK and writes its checksum under
`native/android/app/build/outputs/apk/release/`. Keep signing material outside the checkout.
The local release key and password are retained with private permissions under
`~/.config/droid-office/xr-signing/`; the matching Actions secrets support repeatable releases.
The public signing lineage links this machine's development certificate to the release
certificate, allowing an upgrade without clearing the headset's app data. Other machines'
unrelated debug certificates are not part of that lineage. See Android's
[APK signing and rotation documentation](https://developer.android.com/tools/apksigner).

For development over USB, start the laptop office on port 4600 and forward it:

```bash
adb reverse tcp:4600 tcp:4600
adb shell am start -n dev.droidoffice.xr/.OfficeActivity \
  --es server_url http://localhost:4600
```

For Wi-Fi, use the laptop's reachable hostname or LAN address. The server must listen on
that interface, and both devices must be able to reach it. Voice requires a secure WebView
origin: localhost for USB, or HTTPS for Wi-Fi. The app trusts system CAs and CAs explicitly
installed by the device owner, so a development certificate can use normal Android trust
instead of bypassing verification.

### Debug shot staging

A debuggable build (`assembleDebug`) passes `{"debuggable":true}` as the fourth argument of
each `officeNative.frame` call; a release build passes `false`. Only then do the page's
`window.__office.stageTarget(options)`, `allowTargets(ids)`, `stageShot(options)`,
`stageRevive(options)` and `dismissTarget(worker)` do anything; otherwise they resolve
`{ ok: false }`. They are for headset captures over the WebView DevTools socket, and change no
normal gameplay.

**Every shot is real.** A hit sends `worker.shoot`, which starts the server's 30-second revival
window; when it runs out the worker is dismissed and its owned worktrees and branches deleted.
`stageShot` and `dismissTarget` therefore go by a list of **worker ids, never by name**
(`TargetAllowlist` in `src/client/native/stage.ts`): the practice targets this page hired with
`stageTarget`, and the ids a capture harness lists from its own target list with `allowTargets`.
A listed worker must still be a plain shell (no agent, no worktree, no other repositories, no
meeting). The office names a `worker.spawn` with `target: true` `Target <n>`
(`src/shared/targets.ts`), but that name only tells the office's answer to the hire apart on the
floor; it never lets anything be shot. A capture goes:

```js
const t = await __office.stageTarget();            // { ok, worker: 'Target 1 🐚', workerId, desk, clearance }
__office.allowTargets(['93e35222c41a']);           // or list a harness's target ids: { ok, targets }
await __office.stageShot({ worker: t.workerId });  // or the capture puppet's draw and trigger
await __office.stageRevive({ worker: t.workerId }); // or releaseShot(), well inside the window
await __office.dismissTarget(t.workerId);          // { ok, gone: true }; off the list again
```

`stageTarget` hires one at `desk` (a free desk or bean bag), or by default at the free desk
farthest from every other worker on the floor (the nearest of equally clear ones), so a bore aimed
at it crosses nobody else; `clearance` is the meters to the nearest other worker. It resolves once
the target sits there, or with the office's refusal (`timeoutMs`, `8000`), and lists its id.
`dismissTarget` sends home only a listed target, and refuses one lying shot inside its revival
window: revive it first.

`stageShot` scripts one controller's samples inside `NativeControls`: a back-holster draw, a
raise to a pose aimed at the named worker, and one trigger pull. The draw, trigger, muzzle ray,
local fall, `worker.shoot` and effects therefore run the code a held controller drives. The head
remains the headset's own; the rig is turned and placed so the worker is in front of it. The
staged gun is drawn at its scripted world pose, because no real grip is under it. Without
`angle` or `pitch`, the first approach whose line of fire reaches the worker before anything else
is used. Options:

| Option | Meaning (default) |
| --- | --- |
| `worker` | Id or name of a worker on this floor, in any case (`target 1` finds `Target 1 🐚`); its id must be listed |
| `gap` | Meters from the muzzle to the body surface along the bore (`1.2`) |
| `angle` | Degrees around the worker from in front of its face, positive toward its left (`70`, then other clear sides) |
| `pitch` | Degrees the shot slopes down (so the gun sits just under the headset's eye line) |
| `reach` | Meters from the headset back from the gun's fist (`0.42`) |
| `height` | Aim point in meters up a seated worker's own body (`0.62`) |
| `hand` | `'right'` or `'left'` (`'right'`) |
| `freezeMs` | Stop advancing gameplay this long after the shot, holding that frame (none) |
| `holdMs` | Keep aiming this long after the shot when not frozen (`1500`) |
| `timeoutMs` | Resolve `{ ok: false, reason }` if no shot fires by then (`8000`) |

It resolves after the shot, or once frozen, with `hit`, `struck`, `outcome` (`'miss'`, `'down'`
when `worker.shoot` went out, or `'hit'` for a worker already down), `solid`, `distance`,
`angle`, `pitch`, `muzzle`, `surface` and `frozenAfterMs`, or `{ ok: false, reason }`. A worker
already down is refused.

`stageRevive` scripts the other hand (`left` by default) reaching a worker lying on the floor and
pulling the trigger, the use action, through `NativePhysical.useAtBody`: with `how: 'touch'`
(default) the rig stands half a meter off its chest on the open floor beside it and the hand
comes down onto it; with `how: 'point'` it stands `distance` (`1.4`) meters back and points at
it from waist height. Options: `worker`, `hand`, `how`, `distance`, `holdMs` (`1200`), `freezeMs`
(after the trigger) and `timeoutMs`. It resolves once the hand is handed back (or once frozen)
with `roused` (the use action landed: it stirred and `worker.revive` went out) and `revived` (the
server confirmed and it is getting back up). A worker past its window is refused.

`__office.releaseShot()` unfreezes, hands the controller back (a staged gun goes away; a gun
held in the other hand stays) and asks the server to revive the staged worker if it is still
down within its window; pass `false` to leave it down. A freeze releases itself after 15 seconds,
well inside the window.

## Acceptance status

### APK-native settings, 2026-10-01

The data-preserving `0.1.304-native-ui` update (version code 304), signed with the release
lineage, and its browser build were tested on the SM-I610. A temporary instrumentation package
opened the APK settings view and clicked its own Android buttons on the UI thread. Off, Low,
Medium, High, one world-detail step down and the FPS toggle each changed the native snapshot in
6–33 ms. After each foveation choice the renderer created new world targets within about 0.4 s:
Off without a density map, each level with one, and native metrics then reported the matching
eye-tracked profile. The world-detail step reallocated 2504 × 2916 targets as 2412 × 2808 per
eye. No graphics errors were logged.

An FPS choice made in the view survived a full process restart: the new process logged
`GRAPHICS_STORED restored=1` and `GRAPHICS_START owner=host … fps=1` before the page loaded. With
the page loaded, `officeNative.graphics.set()` from the page changed no native setting and created
no targets, and the page's read-only mirror returned to the native values within 3 s. The
instrumentation package was removed afterwards; the settings were left at 135%, High and FPS
counter on.

This check bypassed the physical left Menu edge and controller pointer events. Opening the view
with the controller, switching to Office workspace, terminal use while the view is closed, FPS
counter readability and sustained frame rate with the view open still need a worn, focused
headset check.

Lint, client/server typechecking, all 876 tests, the client build, 17 native host C++ tests,
4 Java host test classes (57 checks) and both APK variants passed. The macOS host run did not
run the Linux Mesa renderer suite.

### Runtime profiles and lamp halos, 2026-10-01

The data-preserving `0.1.303-runtime-profiles` update (version code 303) and its browser
build were tested on the SM-I610. The Settings menu cycled Off → Low → Medium → High; native
metrics reported `none` for Off, then the matching eye-tracked `low`, `medium` and `high`
profiles, without graphics errors. Every choice retained the selected 150% target size,
2784 × 3240 per eye. The test retained the original High choice. The live page reported zero lamp
halos and no scene-export errors; native metrics showed 1,719 scene objects, advancing packets,
zero rejected packets and zero failed programs. This verifies profile binding and halo
omission, not a physical visual-comfort or sustained-90-FPS acceptance run.

Lint, client/server typechecking, all 871 tests with coverage, the client/server build,
native host checks and both APK variants passed. The macOS host run did not run the Linux
Mesa renderer suite; its Vulkan shader checks passed. Lamp tests cover unchanged desktop
and WebXR halos, retained native bulb emission and room lighting, and camera movement.

### Vulkan office validation, 2026-10-01

The locally signed `0.1.302-vulkan-dev` debug APK (version code 302) was tested with retained
app data. Its signature and 16 KB alignment use the existing release key and signing lineage.
The installed office renderer initializes on the Adreno 740 with a two-eye multiview pass,
4× MSAA, runtime density images and fragment-density-map offsets. Focused device logs report
`renderer: "vulkan"`, eye-tracked foveation with valid changing centres, and no graphics error.

The populated office has 1,713 scene objects and 97 resident textures. Scene sequences advance
with no rejected packets, pending uploads or failed programs. Initial focused windows at
1856×2160 per eye measured approximately 89.6–89.8 submitted fps at an actual 90 Hz refresh.
The latest 60.245-second focused sample at 2784×3240 per eye (150%) measured
79.658–85.834 submitted fps per window and 286 missed periods. Its scene sequences advanced
through 13,936, and eye-tracked queries remained valid. These are different resolution/view
conditions, not a controlled performance comparison or a sustained-90 pass.

Node 22 clean install, lint, typecheck and coverage pass (866 tests). The complete macOS
ASan/UBSan native host run, seven static Vulkan shader stages and four links, all generated
Vulkan material shader stages/links, and both Android variants pass. Linux Mesa renders the
real-office fixture at 1× and 4× MSAA with GPU timing and no Khronos validation messages;
the ASan/UBSan run also passes both variants. The host fixture exercises the same default
multiview renderer construction as the installed app.

Physical visual confirmation, the required workspace-open/closed performance views, sustained
90 Hz and the separate sharp-screen pass remain open. The Vulkan path reports
`sharpScreens: false`; the scene also reports one unsupported object. No GLES or fixed-profile
fallback is installed.

The dated release checks below include
[v0.1.289](https://github.com/nikships/droid-office/releases/tag/v0.1.289), whose exact published
APK was installed with retained app data and a matching laptop server.
Earlier session, nearby-office picker and layout checks are recorded in
[published release validation](#published-release-validation-2026-09-30).
The font, sampling and resolution changes and actual device checks are recorded in
[resolution and glyph release validation](#resolution-and-glyph-release-validation-2026-09-30).
Vulkan office acceptance is not established by these earlier GLES results.
Physical terminal readability, held-card comfort, required-view performance and recovery from
an actual runtime change to 72 Hz remain open acceptance checks. The dated measurements below
preserve earlier experiments and should not be read as the current release pointer.

### Controller-only and sharp-screen installation, 2026-09-29

The combined APK was installed at 21:56 local device time, process 19601, against the isolated
laptop server on port 4761. The manifest requires Galaxy XR controllers and contains no hand
tracking permission. Startup reports `INPUT_SCHEME motion_controllers handTracking=0
workspace=left_menu`, a runtime layer limit of 16 and an unfoveated 3152×3682 sharp swapchain.
The actual 4× MSAA world-depth probe reported 255 covered samples, zero zero-depth samples and
no GL error. A device screenshot shows the live shell laptop screen in this separate layer.
It establishes rendered pixels, not the owner's worn-headset sharpness assessment.

An in-page replay on the installed headset used the real controller adapter: neutral, left
grip, right Menu and a held left Menu did not cause extra toggles; the first left Menu press
opened the workspace and the next fresh press closed it. A legacy hand packet caused no action.
These are synthetic controller samples, not physical button-use evidence.

**Sharp-layer performance remains open.** At the close laptop view, with 103 textures resident
and scene sequences advancing, the first post-wake layer window measured 81.329 submitted fps
and 45 missed periods. Later Clarity windows were approximately 89.4–90.02 fps with 0–3 missed
periods per five seconds. A later Balanced sample reached only 85.624 fps with 22 missed periods;
runtime app GPU time was 24.8 ms while the scene timer reported 5.0 ms. The scene timer excludes
some work outside its draw calls, including implicit framebuffer stores and other GPU clients.
This is not a stable 90 fps pass. A focused optimization of high-layer rendering/submission is
in progress; its resolution and occlusion must be preserved. No cooling pause was used.

The headset sleeps after removal (`xr_doff`). Focused tests use a wake/reopen and exclude stale
pre-sleep metrics. The installed live-focus fix correctly reports the paused state between runs.

Validation after the combined change passed in CI order on Node 22: `npm ci`, lint, typecheck
and coverage (511 tests, 83.54% lines, 78.19% functions). The APK build and all registered native
host checks passed with JDK 21, SDK 35, ASan/UBSan and host ANGLE, including 2,684 shader stages,
1,342 programs and required framebuffer/pixel comparisons. Release installer/startup smoke
also passed. These checks do not replace the remaining physical controller and text audit.
After adding the sharp-screen setting, the 24 affected graphics, performance and panel tests,
client typecheck, and ASan/UBSan bridge validation passed. The bridge rejects incorrectly typed
values and defaults omitted values to enabled. The full-suite results above precede this
setting and the pending renderer optimization. A subsequent Node 22 lint, typecheck and
coverage run also passed after adding the setting (511 tests, 83.55% lines).

The setting-enabled APK was installed at approximately 22:20 local time, process 9158. Its
48 px checkbox target fits the headset workspace. A 37-second interleaved comparison at the
same close laptop view used Balanced, 100% world resolution and 0.25 peripheral detail. All
four snapshots were focused, at actual refresh 90 Hz, with no queued uploads and advancing
scene sequences (3,524 to 4,167). Sharp off/on/off/on runtime GPU times were 6.93/9.49/7.11/9.43 ms.
Both enabled snapshots reported approximately 90.21 submitted fps and zero missed periods;
the initial disabled window had one missed period and the next had none. Six sharp draws were
active when enabled and zero when disabled. This establishes a roughly 2.5 ms incremental
cost in that run; it does not explain away the earlier drops or complete acceptance. The
high-resolution pass is enabled again, and further bounded optimization is in progress.
The device workspace screenshot shows both new and existing checkbox rows, descriptions and
footer without overlaps or clipping. Clarity, 100% resolution, low peripheral detail and the
persistent FPS counter were restored after comparison, and the workspace was closed.
Read-only Android settings inspection also reported `user_refresh_rate=90`; the app's measured
runtime refresh was 90 Hz throughout the comparison. Recovery from an actual subsequent
runtime switch to 72 Hz still needs device evidence; the bounded retry policy has host tests.

On 2026-09-30 the owner superseded the earlier deferred-rebase instruction and requested an
immediate commit, push and rebase. All native changes were published, the remote desktop
merge was integrated, and the branch was rebased onto `origin/main` at `5ac10be`. Conflict
resolution retained the complete native implementations instead of temporary desktop-build
stubs. The desktop parity audit now includes command-palette access, categorized settings,
board filtering, remembered locations and worker actions; new minigame controls stay deferred.

The pending crop optimization selects projected screen vertex bounds once per frame, preserves
the full-resolution viewport and depth mapping, and submits a matching cropped OpenXR image
rectangle and field of view. It clears a guarded region and discards unused world depth. Host
pixel checks match the prior full-image layer, including occlusion, oblique screens, separate
eye crops and stale-plan rejection. All 11 registered host checks and APK compilation passed;
Android XR's cropped projection behavior and the actual performance saving still need device
validation beyond the measurements below.

### Rebased build and crop comparison, 2026-09-30

The branch was pushed at `5ec0718`, with a clean tree after conflict resolution. Node 22 clean
install, lint, typecheck and coverage passed: 599 tests, 84.31% lines, 80.49% functions. The
rebased environment check retains Grok and Muse's existing configuration-variable handling.
The cropped APK was rebuilt and installed at approximately 00:22 local time, process 19475.
After the interruption the owned test server was restarted on port 4761; the original shell
and office state remained available.

A focused 45-second sharp off/on/off/on comparison used Balanced, 100% world resolution and
0.25 peripheral detail at the same laptop view. All snapshots reported actual refresh 90 Hz,
advancing scene sequences (3,446 to 4,322), no queued uploads and six sharp draws when enabled.
Off/on/off/on runtime GPU times were 7.66/12.72/7.94/8.85 ms. The first enabled window dropped
to 83.02 fps with 34 missed periods; it followed the one-shot debug depth probe (254 covered,
zero zero-depth samples, GL error zero). That timing association does not prove the probe was
the cause. The final enabled window reported 89.82 fps and zero missed periods. Its submitted
screen rectangles covered 3.55 million pixels across both eyes, with a 5.50 million-pixel clear
region, versus the original full image's 23.21 million pixels. The steady sample suggests
less overhead, but the first activation and runtime crop alignment remain open checks.

An actual-page synthetic palette replay exposed a native-only integration bug: Shift-selecting
the owned shell closed the palette but never opened the terminal because desktop walking was
disabled. Replacing the `vr.active` guard with `headsetActive()` follows the original WebXR
immediate-action behavior. Replaying the same action opened the original shell terminal; no
terminal input was sent. The native terminal Picture button reuses the desktop upload path
and Android's existing picture chooser. An actual WebView replay uploaded an owned 68-byte
PNG to the isolated server and pasted its bracketed path into the shared shell without
executing it; the test then cleared the shell's input. The real button also launched Android's
`PhotoPickerActivity`. Selection and return from the system picker still need validation.

The final panel replay passed 11 checks on the actual Android WebView: Home's palette action,
opening the owned shell, terminal Ctrl+K passthrough, explicit palette access with terminal
focus, the original hire form, and the panel's single-choice fields. The fields retained
disabled and hidden options, duplicate-value indices, exactly one input/change notification,
cancel/focus behavior and removal of stale choices. Browser checks at 1600×1019 and 1280×720
showed 52 px option rows above the panel keyboard without overlapping text. A separate
controller-packet replay passed left Menu toggle/hold/release, rejected right Menu and grip
as menu actions, and rejected legacy hand input. These are synthetic input checks.

A reload retained a valid remembered standing position. A deliberately blocked test position
returned to the elevator under the original desktop collision guard; it was not a native
position-restoration defect. Node 22 clean install/build, lint, typecheck and coverage passed
with 607 tests (84.32% lines, 80.52% functions).

The signed release candidate `0.1.270-rc` (version code 270) upgraded the connected headset at
02:07 device time on 2026-09-30 with `adb install -r`. The package retained its app ID and
original first-install time, and no longer had the DEBUGGABLE flag. After launch on the same
office origin, a separate authenticated server observer saw the original Galaxy XR profile
and remembered floor/position without another headset sign-in. Startup loaded both Samsung
controller models, enabled the unfoveated sharp-screen layer and successfully requested
90 Hz. The headset was unworn and the session remained idle; this verifies release startup
and preserved connection data, not focused performance or visual acceptance.

After integrating the incoming desktop mouse-capture and lost-worktree changes, Node 22
checks passed again with 609 tests (84.45% lines, 80.48% functions). XR Home now labels lost
workers and opens the existing recovery dialog. Nine browser checks passed, including repair
access for running workers, disabled actions until recovery and access to an existing PR.
Opening and closing recovery sent no worker mutation. The recovery dialog and its 44 px
buttons stayed above the keyboard at both panel check sizes; no worktree was rebuilt or
deleted by these layout checks.

The Linux CI harness failures were reproduced and corrected without changing production C++,
sanitizer flags or pixel thresholds. A strict shader block tokenizer replaced the libstdc++ 13
regex path that failed compilation under `-Werror`; old and new parsing agreed on all 2,684
generated stages. The scene comparison now waits for every renderer's uploads and compilation
to finish, with a bounded frame count and named failures. The fixed harness passed all seven
C++ tests and both required scene/shader suites on native Linux/arm64 Mesa. All 11 registered
checks, including Java and the NDK cross-compile, passed on macOS. The Linux container needed
a longer host-test timeout. Ubuntu PR CI then passed all 11 checks, with the scene and shader
suites finishing in 172 and 89 seconds under the unchanged 300-second bound, and compiled
both Android variants. PR #45 merged into `main` as `602ad1a`. The first main release run
passed those checks too, then exposed a conflicting inherited `ANDROID_SDK_ROOT` during
signing. The release builder now normalizes both SDK variables to the selected pinned SDK.

### Nearby-office validation (2026-09-30)

The published signed `0.1.284` APK (version code 284) upgraded the headset without clearing its
data. Fourteen checks operated the real Android widgets through temporary signed
instrumentation: ordinary launch reopened the saved office, Wi-Fi DNS-SD found the laptop,
selection stopped discovery and retained the successful origin, HTTP 500 and a silent server
returned to the picker, both failures preserved the saved office and manual draft, and sixteen
long office rows fit without overlapping or clipped text. A synthetic 1280×720 Android viewport
also wrapped long office names and remained scrollable. The silent-server watchdog fired at
approximately 15 seconds before any document committed. The instrumentation package was removed
afterward; no test interface or privileged JavaScript bridge is part of the app.

Captured native picker, failure-message and manual-keyboard layouts were reviewed. The
long-office list and compact viewport used synthetic fixtures in the real Android view;
discovery and failure checks used live Wi-Fi services.
This establishes Android layout and connection behavior, rather than physical controller comfort
or compositor text sharpness. The restored headset joined the existing office under its original
profile, floor and position alongside the existing shared shell. The laptop server runs detached
from the agent's terminal so closing that pane no longer stops the office.

Node 22 clean install/build, lint, typecheck and coverage passed with 641 tests (84.49% lines,
80.56% functions); packed release installation, CLI startup and native sign-in redirect passed.
All twelve registered native host checks passed; after the final navigation guards, the affected
Java checks passed with 638 WebView-service checks and 96 discovery checks. Both Android variants
compiled and the local release APK's signing verification passed. Navigation failure handling
checks the current document and generation, remembers a committed successful document, and cancels
invalid TLS without closing the office for an unrelated external image failure.

### Resolution and glyph release validation (2026-09-30)

[v0.1.289](https://github.com/nikships/droid-office/releases/tag/v0.1.289), from `733d7d3`,
publishes the combined terminal-font correction, sharp-screen sampling and actual world
resolution/foveation controls. Its [CI run](https://github.com/nikships/droid-office/actions/runs/36774073302)
passed all 646 desktop tests, all twelve native host checks, the packed-release installer
smoke test, both Android builds, signing and publication. The exact published APK was
downloaded and verified: version `0.1.289`, code 289, debugging disabled, 16 KB alignment
and the existing release certificate/lineage. Its SHA-256 is
`57c71e6cd487cc1df0b9beb8013ff875c81e17c210a7026cb1d5bced68b0aefc`.
The desktop package and HTTP-served replacement font match the checked-in font checksum.

The matching published desktop package is installed and runs detached on port 4761.
SIGTERM replaced only the preceding server; both floor PTY hosts and their existing shell
and Droid processes retained the same PIDs. An authenticated observer verified server
version `0.1.289`, the existing Galaxy XR profile on `floor-alpha` and the same shared shell.
The headset reconnected over Wi-Fi without another sign-in. No paid worker was resumed.

After the owner reconnected USB, `adb install -r` installed the published APK at 16:59
device time. Pulling the installed `base.apk` reproduced the published SHA-256 exactly.
Version/code are `0.1.289`/289, debugging remains disabled, the release certificate is
unchanged and the original 2026-09-29 first-install timestamp is retained. Existing office
selection and sign-in survived the update.

A temporary signed diagnostic exercised the real graphics UI without typing into workers.
Recommended On/Off allocated 1856×2160, Maximum On/Off allocated 3152×3668, and slider
minimum On/Off allocated 1392×1620. All transitions reported the correct applied dimensions
and foveation state, valid gaze, empty graphics error and `gl_error=0`. Original preferences
were restored exactly (100%, More headroom, Low detail, sharp screens and FPS counter on),
and the ordinary launch confirmed recommended-size targets. These are interaction checks,
not steady performance acceptance: the sampled maximum windows submitted 58.68 fps with
Balanced foveation and 45.007 fps with foveation Off while display/compositor remained 90 Hz.
Maximum is a runtime allocation limit, not a 90 FPS preset.

On the actual headset WebView, the replacement font loaded and `M`, Git and branch icons
each measured 11.99998 px at 20 px. The worker's original 2048×1360 source canvas preserved
the full `main` prompt and adjacent icons. A PixelCopy capture of the actual Android panel
after terminal snapshot rendering showed the same unclipped icons and clean rows; the
graphics panel capture had no overlapping rows or horizontal overflow. Source/panel images
cannot establish physical in-world laptop sharpness through the headset optics.

An ordinary-launch two-minute capture contained 60.125 seconds of focused five-second
windows before Android's idle shutdown paused the session. Those windows submitted
89.218–90.017 fps, with 18 missed predicted periods; actual refresh and compositor were 90 Hz,
scene packets advanced, no GL errors occurred and textures were still loading (9–73 resident).
Paused windows are excluded. No fully resident required-view timing result is claimed, and
the sharp laptop pass was inactive in this view. The diagnostic package and its device capture
directory were removed, then the regular app was relaunched. The owner's worn-headset review
of both text issues, active-screen performance and actual 72 Hz recovery remain open.

### Published release validation (2026-09-30)

[v0.1.284](https://github.com/nikships/droid-office/releases/tag/v0.1.284), from `3187867`,
publishes the matching desktop package, signed headset APK and checksum. Its
[main CI run](https://github.com/nikships/droid-office/actions/runs/36743257188) passed 641
desktop tests, all twelve native host checks, both Android builds, signing verification and
publication. The published APK's SHA-256 is
`a2ad385096bbddd30f1ac4f51358cfcad64793bde30c027cfbcaba6533839315`.

The exact published APK was installed with `adb install -r` at 12:34 device time. Its installed
bytes matched that checksum; version name/code are `0.1.284`/284, debugging is disabled and
the original first-install time and app data are retained. The released desktop package was
installed separately and runs detached from the agent's terminal. After an ordinary headset
launch without a server-address override, an authenticated desktop observer saw the original
Galaxy XR profile, remembered floor/position and existing shared shell on that `0.1.284` server
without another headset sign-in. The fourteen on-device connection checks above used this
published APK and matching server. The temporary instrumentation package and failure-test
servers were removed afterward. No paid worker was resumed.

Startup loaded both Samsung controller meshes, enabled the full-resolution unfoveated screen
layer and successfully requested 90 Hz. Thirteen populated five-second windows, ending at
12:40:55–12:41:55 device time, measured actual refresh and compositor FPS at 90, with zero
reported compositor drops. An initial empty-world window is excluded. Submitted FPS was
86.023–90.225; 21 predicted periods were missed in the first populated window and four later,
for 25 in total. Following the first populated window, submitted FPS was 89.620–90.225.
Runtime app GPU time was 8.16–9.46 ms and maximum window CPU p99 was 19.04 ms. The scene
contained 1,713 objects, packet sequence advanced from 245 to 2,035, and no packets were
rejected or GL errors reported. Textures continued becoming resident, from five to 60.

Gaze was invalid and the sharp-screen layer submitted no draws in this stationary view,
although its setting was enabled. This establishes a live release connection with actual
90 Hz and the misses above. It does not establish fully resident, perfectly steady 90 FPS,
worn-session gaze behavior, terminal readability or physical controller comfort.

#### Earlier v0.1.280 measurement

[v0.1.280](https://github.com/nikships/droid-office/releases/tag/v0.1.280), from `6096760`,
publishes the desktop package, signed headset APK and checksum. Its
[main CI run](https://github.com/nikships/droid-office/actions/runs/36681471280) passed the
609 desktop tests, all 11 native host checks, both Android builds, signing verification and
publication. The published APK's SHA-256 is
`9db8a2fe0efc5fa3c4ce985a7dffaecaaea49e2de22d3fa81837018ba6496d18`.

The exact published APK was installed with `adb install -r` at 03:15 device time. Its installed
bytes matched that checksum, version name/code were `0.1.280`/280, debugging was disabled,
and the app ID and original first-install time were retained. The matching released desktop
package was installed separately and started on the laptop with the existing integration
projects. After waking and launching the headset, an authenticated desktop observer saw the
original Galaxy XR profile, remembered floor/position and existing shared shell on that
`0.1.280` server without another headset sign-in. No paid worker was resumed by the check.

Startup loaded both Samsung controller meshes, enabled the full-resolution unfoveated screen
layer and successfully requested 90 Hz. A wake-and-launch check then produced 12 focused
five-second windows ending at 03:25:20–03:26:15 device time. Actual refresh and compositor FPS
were 90 throughout, with zero reported compositor drops. Submitted FPS was 89.150–90.235;
the windows recorded ten missed predicted periods in total, including startup. Runtime app
GPU time was 7.12–8.73 ms and maximum window CPU p99 was 12.43 ms. The scene contained 1,713
objects, and packet sequence advanced from 250 to 1,757 without rejected packets or GL errors.
Textures continued becoming resident during this check, from seven to 59.

Gaze was invalid throughout, and the sharp-screen layer submitted no draws in this view,
although its setting was enabled. This establishes a live populated release connection at
90 Hz, with the measured misses above; it does not establish final worn-session performance,
sharp-screen alignment/readability or physical controller behavior. Those acceptance checks
remain open. Completed worker panes, browser sessions and temporary Docker resources were
cleaned up; the paired laptop server and headset app remain available for the next review.

The APK now draws the original populated office on the real Galaxy XR. The optimized build
has produced 90 Hz windows with advancing scene packets while connected over Wi-Fi to the
laptop. Use focused 1–2 minute performance checks as UI and controls change. Final acceptance
is still open: required views and interactions, sharp-text review and physically worn
controller validation remain necessary.

The initial display-only run held approximately 90 submitted fps, 90 compositor fps and no
measured missed predicted periods. It included compositor panels and native input rendering
but no office geometry, so it establishes only the display foundation. The first populated
build, without native optimization, stalled during startup and then fell below the target;
the runtime switched from 90 to 72 Hz. A later virtual-display-detachment experiment rendered
a frozen scene after page updates stopped and is excluded from acceptance.

The current build adds `-O2` to native code and keeps the WebView's Surface attached when
the workspace closes. The DOM hides and CSS animations pause while gameplay and scene export
continue. The original login/profile flow joined the isolated server over LAN at
`http://192.168.1.26:4761`; the server listened on `0.0.0.0`. In closed-workspace samples from
18:39:18 to 18:39:48 on 2026-09-29 (device log time), submitted fps was 90.005–90.018 with
actual refresh 90 Hz, zero missed predicted periods and compositor fps 90. Runtime app GPU
time was 6.31–6.50 ms and CPU p99 was 3.46–6.23 ms. The scene sequence continued at about
29 updates per second. The sampled view contained 1,741 objects, 134 color draw calls and
64 additional shadow draw calls when shadows updated. A device screenshot showed the office's
desks, chairs, boards, text, lamps and night shading. This short run supports the native
approach; it does not establish performance across the whole experience.

A later two-minute check, 18:53:15–18:55:10 on the same date, measured 90.003–90.019
submitted fps, actual refresh 90 Hz and zero missed predicted periods. All 105 textures
were resident, with 1,770 scene objects, no rejected packets and no pending uploads.
Scene sequence advanced from 26,641 to 30,032. Runtime app GPU time was 6.50–6.87 ms;
the maximum window CPU p99 was 5.77 ms. This is the populated-world baseline for subsequent
UI, graphics-setting and interaction checks, rather than a claim about every scene or setting.

The native scene currently reports one material approximation: `GlassDark` clearcoat is
represented by roughness. The export reports no errors. Further conformance work must retain
these diagnostics and verify full texture residency before final visual acceptance.

The isolated laptop integration run has verified a normal desktop first-person client and
the native headset in the same server session. The headset keyboard typed into a shared shell
and the desktop received the same terminal output. A task added through the headset's queue
window appeared in the desktop's queue while execution was paused. Adding a second project
through the headset's elevator window created its floor. Replayed hand fingertip contact and
controller trigger/ray samples on the actual physical elevator buttons each changed floors,
and the desktop received the headset's new floor. These input replays verify the application
path; they do not establish the feel of physically wearing and using the headset.
The headset has also refreshed a populated GitHub issues board and opened an issue's detail
and comments through the original desktop flow. No external issue or PR was changed by that
read-only check.

`XR_ANDROID_performance_metrics` now supplies runtime compositor FPS, dropped frame count,
app/compositor GPU time, utilization and motion-to-photon latency. The foundation has reported
90 compositor fps and zero compositor drops. The full set of counters is available to the
page in `officeNative.metrics.runtime`; the critical display counters are logged in bounded
`RUNTIME_METRICS` records.

`FRAME_METRICS.fps` counts focused submitted frames over each measurement window.
`missedPeriods` counts gaps in successive predicted display times; CPU timing spans the
native frame after `xrBeginFrame` through `xrEndFrame`, excluding the normal `xrWaitFrame`
wait. `SCENE_METRICS` reports the renderer's last sampled frame and a delayed GPU timer result,
not a percentile or the cost of every GPU client. Runtime app GPU time covers more than the
scene timer. Compositor fps and compositor dropped-frame count describe the compositor;
the failed first world run still reported zero compositor drops while application frames
were missed. Neither proves that the application rendered a fresh office frame each period.

Acceptance recordings must include actual refresh, submitted frame cadence, missed periods,
runtime GPU counters, thermal/clock state, scene packet advancement, upload backlog and visible
world screenshots. Check both open and closed workspace states, floor changes and populated
worker/board views, including valid-gaze movement and invalid-gaze fallback. Keep synthetic
input replay evidence separate from physical headset use.
Performance hints request sustained CPU/GPU levels, but cannot guarantee that the runtime
will maintain 90 Hz. See the [OpenXR performance-level API](https://registry.khronos.org/OpenXR/specs/1.1/man/html/xrPerfSettingsSetPerformanceLevelEXT.html).

### Controller and medic wrap-up (2026-09-30)

The final locally signed v0.1.301 APK (code 301) is installed on Galaxy XR `R3GYB022DBM`.
Its SHA-256, reproduced by pulling the installed `base.apk`, is
`361c511efdcacba365886a61bfe52abf52939c001efa7a94a76bd8e9e831593a`.
Release signing verification and 16 KB alignment passed with the existing certificate and
lineage. The original first-install timestamp, selected office and sign-in were preserved.
Launch loaded the updated laptop-served client, both Samsung controller meshes and the
recommended-resolution foveated world/sharp-screen targets; requesting 90 Hz succeeded.
This launch smoke check does not establish a new sustained FPS measurement.

The controller/shot fixes and medic redesign are documented in
[controller interactions](vr-native-controller-interactions.md) and
[medic sequence](medic-sequence.md). Local lint, typecheck, 703 tests with coverage and
production build passed; the final camera-less shot refinement then passed its 21 affected
regressions and a rebuild. No pipeline completion was awaited, as requested by the owner.
The office server on 4761, its hook listener and Vite on 4762 were shut down at wrap-up.
The staged final client remains in
`/tmp/office-xr-toolchain/release-v0.1.297/local-desktop/dist/public`; the local signed APK
and installation evidence are in `/tmp/office-xr-toolchain/release-v0.1.301/`.
