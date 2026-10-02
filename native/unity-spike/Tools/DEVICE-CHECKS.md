# U0 device checks

Partial Galaxy XR results are recorded in `docs/unity-headset.md` section 25:
the spike runs, but actual refresh is 72 Hz, not the requested 90 Hz. Android
OkHttp over USB reverse, Keystore round-trip and one discovery resolution passed.
Owner readability, haptics, bound gaze foveation, clean sustained performance,
QR/picker and upgrade-preservation checks remain open. Repeat the relevant steps
below; do not treat the checklist itself as evidence.

The spike APK is a separate app, `dev.droidoffice.xr.unity`. Nothing here replaces
the existing `dev.droidoffice.xr` app or accesses its files.

The helper commands assume this repository is the working directory. Use the
`-s SERIAL` adb selector whenever more than one device is connected.

1. Install `native/unity-spike/Builds/droid-office-u0.apk` using `adb install -r`.
2. Launch with `adb shell am start -W -n
   dev.droidoffice.xr.unity/com.unity3d.player.UnityPlayerGameActivity`.
   Record total/wait time, first rendered frame, actual device model and OS.
3. Accept **fine eye tracking** deliberately. Wear the headset, keep the app
   focused, and record actual rate/eye dimensions. A requested setting is not
   a measurement.
4. The frame recorder warms up for 10 seconds, then records 120 seconds.
   Pull CSVs from `/sdcard/Android/data/dev.droidoffice.xr.unity/files/`.
   GPU `NaN` and counters `-1` mean unavailable. Never turn them into zero.
5. Send diagnostic commands with:

   ```sh
   adb shell am broadcast -a dev.droidoffice.spike.COMMAND \
     -p dev.droidoffice.xr.unity --es command eye100
   ```

   Commands: `eye100`, `eye125`, `quad`, `foveation-off`, `foveation-low`,
   `foveation-medium`, `foveation-high`, `frames`, `network`, `keystore`,
   `discovery`, `photo`, `url`, `network-okhttp`.

6. Compare the **same** 2160×1200 source, 120×40 cells, at 0.9 m and 0.9 m width
   for eye scale 1.0, 1.25, and quad underlay. Move the tracked grip proxies in
   front. Capture each mode, ask the owner to read the ambiguous characters,
   and record preference. This is a TMP raster-reference, not the production
   terminal cell shader or a completed hand-occlusion test.
7. Log Menu, stick click, face buttons, trigger, touch support, and haptic API
   acceptance. Physically exercise every control and compare impulse strength
   and duration. API acceptance alone does not mean it was felt.
8. For C# receive throughput, run `Tools/network-fixture.mjs` on the host and
   `adb reverse tcp:9443 tcp:9443`; trigger `network`. Use the same certificate
   that was bundled as a non-secret fixture pin during scene generation.
   Record the player JSON and server control-pong counts for all 3 connections.
   Also run `network-okhttp`, which checks HTTPS and both incorrect-pin paths.
   Its host JVM baseline is not an Android JNI throughput measurement. The fixture
   binds only to host loopback and never uses office credentials.
9. `keystore`, `discovery`, `photo`, and `url` measure JNI dispatch separately.
   Verify discovery against a real `_droidoffice._tcp.` advertisement. A photo
   picker result logs only success, never its URI or image content.
10. QR is **not wired yet**. Test Google's image tracking sample separately.
    Extensions 1.4's `XRQrCodeTrackingFeature.RequiredPermission` is
    `SceneUnderstandingCoarse`, and `ARTrackedImage.TryGetQrCodeData` exposes
    decoded data. Verify that permission and payload availability on the device, then
    decide whether to include QR. Package presence does not prove scanning.
11. For foveation, capture a real density-map/gaze diagnostic. Changing the
    API readback does not prove Galaxy XR replaced its first-bound profile.
    Compare each fresh launch against in-session changes before choosing
    live changes, swapchain recreation, or "next launch".
12. Inspect the laptop's hinge and trackpad on opposite-facing desks. glTFast
    mirrors X; `OfficeSpace.GltfBasis` rotates the imported basis by 180°
    to agree with the office's mirror-Z convention. The mathematical test is
    not a visual comparison with the browser.
13. Upgrade preservation remains a separate test: use a disposable current-app
    install, the existing signing lineage and a higher version code, compare
    file checksums before/after. Never uninstall or overwrite the owner's live
    app to manufacture this evidence.

This synthetic greybox has no tablet, live agents or optimized terminal shader.
It cannot establish U7's populated live-office acceptance budgets.
