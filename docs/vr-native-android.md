# Native Galaxy XR client

The current implementation targets an installed Android OpenXR app. The laptop continues
to run the existing Node office server. Both the normal desktop client and the headset
use its existing authentication, WebSocket protocol, workers, terminals, boards and floor
state. The headset uses the same first-person world and shared objects. Galaxy XR motion controllers
are now the only supported native control scheme; this supersedes the earlier hand-tracking
requirement. The left controller’s Menu button toggles the workspace. Grip must not open or
close it. The controller-only combined APK is installed on the connected headset.

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

### Display and workspace

The display path uses GLES multiview for both eyes, with 4× tile MSAA where supported.
Gaze-driven `GL_QCOM_texture_foveated` adjusts full-resolution rendering around the gaze and
reduces peripheral pixel density. Invalid gaze falls back to a fixed central fovea.
Depth attachments inherit the color attachment's foveation; they are not independently
foveated. The implementation follows the
[Qualcomm extension](https://registry.khronos.org/OpenGL/extensions/QCOM/QCOM_texture_foveated.txt).

The current gaze profile uses gain 4, fovea area 2 and minimum pixel density 0.25. Every
supported focal point is updated; an unused default focal point would keep the entire eye
at full density. The invalid-gaze profile uses a broader central fovea. These settings are
performance choices that still require headset sharpness and gaze-motion validation.

The original desktop windows, including terminals, are displayed through a 2400×1600 Android
Surface compositor layer. This preserves text resolution independently of world foveation.
Its producer stops before `xrEndSession`, following the
[Android Surface swapchain contract](https://registry.khronos.org/OpenXR/specs/1.1/man/html/xrCreateSwapchainAndroidSurfaceKHR.html).
The headset UI includes a controller-operated keyboard, larger targets and adjustable terminal text.
A smaller compositor panel carries interaction hints and feedback when the workspace closes.
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
quad is hidden and keeps consuming the quad until the UI thread acknowledges shutdown. The
WebView's scene packets and control heartbeat then continued advancing while opening and
closing the workspace. Native FPS alone would have concealed this freeze.

### Laptop-screen sharpness and refresh preference

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

Resolution choices allocate matching world targets, bounded by both eye views, OpenXR system
limits and GLES texture limits. The default does not allocate maximum-size world targets.
Slider dragging previews the choice and applies it on release; native target changes wait
250 ms for a stable choice. Replacement starts on the GL thread with no acquired world images.
Each staged swapchain then acquires and waits for one image, validates the real color/depth
attachment and tile-MSAA configuration, clears and finishes GPU work, and releases the image
before promotion. A wait timeout or failed allocation/completeness check retains the current
targets. GPU commands complete before old swapchains are destroyed. Scene assets, player state,
Android Surfaces and panel resolution are retained.

**Foveated rendering → Off** uses new unfoveated targets at the chosen world resolution.
On profiles preserve the sharp gaze region with configurable peripheral density; gaze loss
keeps the central fallback. The shader, controller and sharp-screen depth mapping use the
actually allocated world dimensions. The runtime reports foveation availability and the applied
mode. QCOM forbids disabling foveation on a texture after enabling it, so the Off transition
recreates targets instead of clearing that bit on existing images.
[QCOM texture-foveation contract](https://registry.khronos.org/OpenGL/extensions/QCOM/QCOM_texture_foveated.txt),
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

## Acceptance status

The latest published release is [v0.1.289](https://github.com/nikships/droid-office/releases/tag/v0.1.289).
Its exact published APK is installed, with retained app data and the matching laptop server
running. Earlier session, nearby-office picker and layout checks are recorded in
[published release validation](#published-release-validation-2026-09-30).
The font, sampling and resolution changes and actual device checks are recorded in
[resolution and glyph release validation](#resolution-and-glyph-release-validation-2026-09-30).
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
