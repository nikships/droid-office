# Native Galaxy XR client

These rules govern the WebView-based app in `native/android/`. Its planned Unity replacement
follows [the Unity headset plan](../docs/unity-headset.md) instead.

Read [the native client design and acceptance evidence](../docs/vr-native-android.md)
before changing the Android/OpenXR renderer or host. The original office scene, gameplay,
windows and server protocol remain authoritative; update their existing adapters instead
of creating a second office state or a separate worker/board implementation.

- Keep head and controller rendering in the native display loop. Parse packets, decode images
  and prepare scene snapshots away from the display thread; budget uploads and pipeline creation.
- Rig presentation may interpolate only approved rig endpoints and fade, never tracked
  eye/head/controller poses or predicted movement. Apply `presentationEpoch` changes and full-black
  fade immediately; reset on focus/reference changes or stale updates. Keep original player
  collision, picking and server state authoritative.
- Preserve scene packet revisions, reset/commit boundaries, bounded drains and backpressure
  when changing the native consumer. Geometry sharing requires exact buffer semantics, not
  parameter names alone; texture scheduling must retain first-pixel priority and fair redraws.
- `office_xr.cpp` is the API-neutral session and frame loop. Everything a graphics API draws
  sits behind the coarse `WorldRenderer` seam (`world_renderer.h`); `world_vk.cpp` is the
  only installed render path. Do not add a GLES or fixed-foveation fallback. Keep GL and Vulkan
  calls out of `office_xr.cpp`, and keep API-free scene
  logic shared in `scene_stream.cpp` and `scene_frame.cpp`, not copied into a backend.
- Initialize, use and destroy graphics objects on the display thread. Stop Android Surface producers
  before ending the OpenXR session or destroying their swapchains. Clear scene callbacks
  before destroying the renderer they capture.
- Keep the status Surface producer stopped while its quad is hidden. Consume its BufferQueue
  until the UI thread acknowledges producer shutdown, including frames with invalid world
  poses or `shouldRender == false`; a hidden Canvas producer can otherwise
  block the UI thread and freeze gameplay while native FPS remains high.
- Motion controllers are the native app's only supported input scheme. Do not request hand
  tracking permissions or enable hand tracking/mesh extensions. The left controller's Menu
  button toggles APK-native settings; Office workspace opens the shared office tools. The right
  Menu button belongs to Android XR. Grip holds objects
  and never navigates the workspace. Keep WebXR controls unchanged.
  Read [the physical interaction contract](../docs/vr-native-controller-interactions.md) before
  changing button roles, climbing or weapon input. Physical gestures require a tracked grip,
  never an aim-pose fallback. Reanchor after tracking/reference changes; climb from native-space
  hand deltas, without feeding rig movement back into the next pull.
- Keep graphics settings APK-owned: Android UI updates the native snapshot directly and persists
  it off the display/UI threads. Page graphics must not overwrite host choices. Preserve legacy
  APK compatibility and read-only page mirrors. Shared office windows/terminals use the compositor
  workspace; never reject all modals or redirect a visible terminal's keyboard into the world.
- Controller geometry uploads once. Animate buttons from current native poses/input without
  bridge round trips; tracking loss must cancel interactions and suppress stale presses.
- Check extensions, function pointers and supported modes at runtime. Treat a 90 Hz request
  as a request, and report the actual refresh rate and frame timing. The OpenXR runtime owns
  foveation: use `XR_KHR_vulkan_enable2`, world colour swapchains with
  `XR_SWAPCHAIN_CREATE_FOVEATION_FRAGMENT_DENSITY_MAP_BIT_FB`, and
  `XR_META_vulkan_swapchain_create_info` with fragment-density-map offsets. Attach the runtime's
  density images to the multiview render pass. Apply the eye-tracked profile before querying
  `xrGetFoveationEyeTrackedStateMETA`, and pass per-eye offsets to `vkCmdEndRenderPass2`.
  Required extensions, eye permission, eye-tracked system support and Vulkan device features
  must fail explicitly when unavailable. Off is an explicit user setting, not an automatic
  fallback. Never write QCOM texture foveation state or foveate Android Surface panels.
  Cite the specification or working Android XR code next to foveation calls. Keep derivative
  shading and point-quad size independent of fragment density.
- World resolution is a multiplier of the recommended eye size, bounded by both runtime axes
  and Vulkan image limits. Allocate the selected eye size; do not relabel recommended resolution as
  the maximum or force default frames through maximum-size targets. Replace targets on the
  display thread with no acquired images. Report target allocation failures explicitly.
  Complete GPU image use before destroying old swapchains, including during teardown.
  The Galaxy XR runtime keeps the first profile a world swapchain receives, so every foveation
  choice is new world targets: Off is swapchains without `XrSwapchainCreateInfoFoveationFB`, a
  level is swapchains with it and that eye-tracked level's profile applied first. Create the first targets
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
  checks and both APK variants as well as the parent checks; a TypeScript build does not compile
  the Android client. Keep changing measurements in the linked evidence document.
  The Linux host run includes `native/tests/run-vulkan.sh` with Mesa and Khronos validation;
  macOS reports that suite as NOT RUN. Retain the GLES suites as reference checks, not an
  installed fallback. A passing build or software render does not prove headset eye tracking,
  sharp-screen readability or sustained 90 Hz.
