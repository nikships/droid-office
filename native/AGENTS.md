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
  button toggles the workspace; grip must not open or close it. Keep WebXR controls unchanged.
- Controller geometry uploads once. Animate buttons from current native poses/input without
  bridge round trips; tracking loss must cancel interactions and suppress stale presses.
- Check extensions, function pointers and supported modes at runtime. Treat a 90 Hz request
  as a request, and report the actual refresh rate and frame timing. Preserve full resolution
  at the tracked gaze; invalid gaze requires a central full-resolution fallback. Follow the
  [QCOM foveation contract](https://registry.khronos.org/OpenGL/extensions/QCOM/QCOM_texture_foveated.txt)
  when changing focal points or depth attachments.
- Validate performance with a visible, populated office and advancing scene packets, both
  workspace-open and workspace-closed, using focused 1–2 minute checks. An empty world, a frozen snapshot
  or compositor FPS alone cannot establish sustained application frame rate. Record visual
  approximations and synthetic input replays separately from physical headset checks.
- Keep connection, authentication and network behavior on the selected office origin.
  Do not bypass TLS certificate validation or add a privileged JavaScript interface.
- Pin downloaded native dependencies and their checksums. Use the checked-in Gradle
  wrapper, SDK 35, NDK 27.2.12479018, CMake 3.22.1 and JDK 17 or 21. From the repository root,
  build with `native/android/gradlew -p native/android --no-daemon :app:assembleDebug`.
  The APK is `native/android/app/build/outputs/apk/debug/app-debug.apk`.
- Format changed C++ and Java using `native/.clang-format`. Run the affected native host
  checks and the APK build as well as the parent checks; a TypeScript build does not compile
  the Android client. Keep changing measurements in the linked evidence document.
