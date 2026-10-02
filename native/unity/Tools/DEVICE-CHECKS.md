# Production development checks

These are integration/debug checks, not milestone acceptance. Use the synthetic
fixture, not an owner's office, for captures that may be shared.

1. Run `node native/unity/Tools/server-fixture.mjs` from the repository root.
   It binds loopback port 14600, creates its own HOME and checkout, launches two
   fake agents, and stops after 180 seconds. Check the port before starting it.
2. Build with the saved project's **Droid Office / Build Android** menu.
   `BuildSettings.RequestAndroid()` queues the same build for live Editor tooling;
   inspect `AndroidBuildState` and `Evidence/build.json`, not an old report.
3. Verify APK signing and 16 KiB alignment. Install only
   `native/unity/Builds/droid-office-unity.apk` as `dev.droidoffice.xr.unity`.
   This replaces the disposable spike development package, never the legacy
   `dev.droidoffice.xr` app. Save spike evidence first.
4. Select the connected device explicitly:

   ```sh
   adb -s SERIAL reverse tcp:14600 tcp:14600
   adb -s SERIAL shell input keyevent KEYCODE_WAKEUP
   adb -s SERIAL shell am start -W -n \
     dev.droidoffice.xr.unity/com.unity3d.player.UnityPlayerGameActivity
   ```

5. Development builds alone poll a local command inbox. Request a non-secret
   state snapshot, then pull the report after the app advances:

   ```sh
   adb -s SERIAL shell 'printf status > /sdcard/Android/data/dev.droidoffice.xr.unity/files/development-command.txt'
   adb -s SERIAL pull /sdcard/Android/data/dev.droidoffice.xr.unity/files/development-status.json native/unity/Evidence/
   ```

   Verify increasing `frame`/`appliedMessages`, `connected`, two workers and two
   100×30 grids. `actualHz=-1` means unavailable. `focused=false` cannot prove a
   worn/focused performance run.

6. Replace `status` with `capture-terminal` for a fixed mono camera render at
   0.9 m. Pull `development-terminal.png` from the same directory. This explicitly
   bypasses the normal 6 m update gate for one populated terminal; it does not
   move the rig. Check the report's `capture` field before trusting a potentially
   stale PNG. The image contains actual terminal text. It is not a headset-eye
   image, a sharpness comparison or owner readability acceptance.
7. Stop only the fixture process you launched. Request `status` and verify
   `connected=false` while both workers remain. Restart the fixture, request
   another snapshot, and verify a higher `generation`, `connected=true`, restored
   grids and the same Android app PID. Never kill the owner's server for this test.
8. Inspect the app PID's logcat separately. In the first device run, Android XR
   performance metrics were unsupported. API success/readback never replaces
   actual refresh or bound-profile evidence.
9. Stop the fixture and remove only the reverse mapping this test added:
   `adb -s SERIAL reverse --remove tcp:14600`. Do not uninstall either app or
   clear its data.

The diagnostics assembly has no release implementation, network listener or
exported receiver. Only `status` and `capture-terminal` are accepted. Evidence
stays ignored. Wear-dependent checks follow section 20 of `docs/unity-headset.md`.
