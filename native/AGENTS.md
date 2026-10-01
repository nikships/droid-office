# Native Galaxy XR client

Read [the native client design and acceptance evidence](../docs/vr-native-android.md)
before changing the Android/OpenXR renderer or host. The original office scene, gameplay,
windows and server protocol remain authoritative; update their existing adapters instead
of creating a second office state or a separate worker/board implementation.

- Keep head and controller rendering in the native display loop. Parse packets, decode images
  and prepare scene snapshots away from the GL thread; budget uploads and shader links.
- Rig presentation may interpolate only approved rig endpoints and fade, never tracked
  eye/head/controller poses or predicted movement. Apply `presentationEpoch` changes and full-black
  fade immediately; reset on focus/reference changes or stale updates. Keep original player
  collision, picking and server state authoritative.
- Preserve scene packet revisions, reset/commit boundaries, bounded drains and backpressure
  when changing the native consumer. Geometry sharing requires exact buffer semantics, not
  parameter names alone; texture scheduling must retain first-pixel priority and fair redraws.
- Initialize, use and destroy GLES objects on the GL thread. Stop Android Surface producers
  before ending the OpenXR session or destroying their swapchains. Clear scene callbacks
  before destroying the renderer they capture.
- Keep the status Surface producer stopped while its quad is hidden. Consume its BufferQueue
  until the UI thread acknowledges producer shutdown, including frames with invalid world
  poses or `shouldRender == false`; a hidden Canvas producer can otherwise
  block the UI thread and freeze gameplay while native FPS remains high.
- Motion controllers are the native app's only supported input scheme. Do not request hand
  tracking permissions or enable hand tracking/mesh extensions. The left controller's Menu
  button toggles the workspace; the right Menu button belongs to Android XR. Grip holds objects
  and never navigates the workspace. Keep WebXR controls unchanged.
  Read [the physical interaction contract](../docs/vr-native-controller-interactions.md) before
  changing button roles, climbing or weapon input. Physical gestures require a tracked grip,
  never an aim-pose fallback. Reanchor after tracking/reference changes; climb from native-space
  hand deltas, without feeding rig movement back into the next pull.
- Controller geometry uploads once. Animate buttons from current native poses/input without
  bridge round trips; tracking loss must cancel interactions and suppress stale presses.
- Check extensions, function pointers and supported modes at runtime. Treat a 90 Hz request
  as a request, and report the actual refresh rate and frame timing. The OpenXR runtime owns
  foveation: create only the world colour swapchain with `XR_FB_foveation` scaled-bin support and
  apply `XR_FB_foveation_configuration` / `XR_META_foveation_eye_tracked` profiles with
  `xrUpdateSwapchainFB`. Never write QCOM texture foveation state or focal points from the app,
  and never foveate depth, the sharp-screen layer or the Android Surface panels. Cite the
  specification or working Android XR code next to each foveation call. Never submit the
  driver's upscaled blocks: render into the foveated swapchains and draw the submitted,
  unfoveated ones with the filter pass (`foveation_filter_shader.h`), falling back to direct
  submission only when that cannot be created. Keep world-pass output independent of bin
  density: no `gl_PointSize` (points are quads) and derivative-based shading divided by the
  measured step.
- World resolution is a multiplier of the recommended eye size, bounded by both runtime axes
  and GLES limits. Allocate the selected eye size; do not relabel recommended resolution as
  the maximum or force default frames through maximum-size targets. Replace targets on the
  GL thread with no acquired images, retaining the current targets if allocation fails.
  Complete GPU image use before destroying old swapchains, including during teardown.
  The Galaxy XR runtime keeps the first profile a world swapchain receives, so every foveation
  choice is new world targets: Off is swapchains without `XrSwapchainCreateInfoFoveationFB`, a
  level is swapchains with it and that level's profile applied first. Create the first targets
  from the stored settings, report only what is bound, and destroy the foveation profile before
  the session.
- Validate performance with a visible, populated office and advancing scene packets, both
  workspace-open and workspace-closed, using focused 1–2 minute checks. An empty world, a frozen snapshot
  or compositor FPS alone cannot establish sustained application frame rate. Record visual
  approximations and synthetic input replays separately from physical headset checks.
- Keep connection, authentication and network behavior on the selected office origin.
  Do not bypass TLS certificate validation or add a privileged JavaScript interface.
- Nearby-office discovery uses `_droidoffice._tcp.` with versioned, secret-free TXT data.
  Keep discovery and bounded resolution off the display loop; stop it while connected,
  paused, hidden or destroyed, and reject callbacks from earlier discovery cycles.
  Remember an office only after a successful page load; preserve the saved choice on failure.
- Pin downloaded native dependencies and their checksums. Use the checked-in Gradle
  wrapper, SDK 35, NDK 27.2.12479018, CMake 3.22.1 and JDK 17 or 21. From the repository root,
  build with `native/android/gradlew -p native/android --no-daemon :app:assembleDebug`.
  The APK is `native/android/app/build/outputs/apk/debug/app-debug.apk`.
- Releases use `native/android/build-release.sh VERSION [VERSION_CODE]`, the pinned SDK's
  align/sign/verify tools, and private signing material outside the repository. CI builds
  both variants, signs only on `main`, and publishes the verified APK with its checksum.
  Preserve signing lineage and increasing version codes so updates retain headset app data.
- Format changed C++ and Java using `native/.clang-format`. Run the affected native host
  checks and the APK build as well as the parent checks; a TypeScript build does not compile
  the Android client. Keep changing measurements in the linked evidence document.
