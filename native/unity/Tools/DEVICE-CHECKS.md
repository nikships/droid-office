# Production development checks

These checks are integration evidence, not milestone acceptance. The owner
requires current validation against the real office and real Droid workers,
not synthetic substitutes. Keep real terminal captures local and ignored.
Synthetic fixtures remain useful only for isolated, explicitly labeled tests.

1. Verify the intended actual server on loopback 14600. Do not replace it,
   start a second server on its port, or kill owner work. Preserve its workers,
   checkout and floors. Synthetic fixture counts are not real-worker evidence.
2. Rebuild the source scene through `EnvironmentBuilder.RequestBuild()` in the
   live production Editor. Use absolute `--project-path native/unity` expanded
   to this checkout's actual path. Wait for `BuildState=Succeeded`; run the
   EditMode tests and inspect their passed/failed counts.
3. Queue `BuildSettings.RequestAndroid()` or use **Droid Office / Build Android**.
   Record the existing `Evidence/build.json` modification time first. Poll the
   new on-disk report, not the busy Editor's main thread. A Pipeline request
   timeout during a build can contaminate its error count. Require a fresh report,
   `result=Succeeded` and **zero errors**, not merely the CLI's return status.
4. Verify APK signing and `zipalign -c -P 16`. Inspect the final APK manifest:
   `android.hardware.xr.input.controller` must have `required=false`; OpenXR
   remains required. No microphone/hand-tracking input or permissions.
   Install only `native/unity/Builds/droid-office-unity.apk` as
   `dev.droidoffice.xr.unity`. Never replace or clear the legacy app's data.
5. Select the device explicitly:

   ```sh
   adb -s SERIAL reverse tcp:14600 tcp:14600
   adb -s SERIAL shell input keyevent KEYCODE_WAKEUP
   adb -s SERIAL shell am start -W -n \
     dev.droidoffice.xr.unity/com.unity3d.player.UnityPlayerGameActivity
   ```

6. Development builds poll a local inbox. Request a snapshot and wait for the
   app to advance before pulling:

   ```sh
   adb -s SERIAL shell 'printf status > /sdcard/Android/data/dev.droidoffice.xr.unity/files/development-command.txt'
   adb -s SERIAL pull /sdcard/Android/data/dev.droidoffice.xr.unity/files/development-status.json native/unity/Evidence/
   ```

   Check increasing `frame`/`appliedMessages`, `connected`, actual workers/grids,
   attached-terminal readiness, preferences and requested/actual graphics.
   The full performance acceptance workload still requires 12 agents, six
   working and two updating focused terminals; fewer workers do not establish it.
   `nativeRequestResult=0` is native request success; it is not FPS.
   Check `actualHz` and `nativeHz` separately. `-1` is unavailable.
   Check runtime recommended/maximum axes, actual eye target and applied scale.
   `focused=false` cannot establish worn/focused acceptance.

## Commands

Replace `status` in the inbox command with one of these exact strings:

| Command | Output / scope |
| --- | --- |
| `status` | Counts and graphics readbacks in `development-status.json` |
| `capture-terminal` | Fixed mono terminal at 0.9 m in `development-terminal.png`; temporarily bypasses the 6 m update gate |
| `capture-world` | Fixed mono office in `development-world.png`; not an eye image |
| `capture-settings` | Fixed mono settings in `development-settings.png`; restores panel visibility/pose, not physical input acceptance |
| `open-droid-terminal` | Opens an actual Droid and positions the debug rig nearby; not physical interaction evidence |
| `open-shell-terminal` | Same convenience for an actual shell worker |
| `capture-focused-terminal` | Fixed mono current attached terminal and shortcut buttons, `development-focused-terminal.png` |
| `open-desk-task` | Opens the actual Droid's external-keyboard task editor and positions the debug rig nearby; sends no prompt |
| `capture-desk-task` | Fixed mono current task editor, `development-desk-task.png`; not hardware input acceptance |
| `capture-issues-board` | Fixed mono actual floor issues, `development-issues-board.png`; private/read-only, not card/poke/eye acceptance |
| `capture-resources` | `development-resources.json`; explicit, timing-disrupting inventory including XR render targets |
| `capture-performance` | Ten-second warmup, focused recording up to 120 seconds, `development-performance.csv` |
| `capture-performance-30s` | Owner-authorized shorter focused check: ten-second warmup, continuous 30 seconds; not the full acceptance workload |
| `capture-performance-visible` | Same sampling but permits unfocused XR; explicitly **not acceptance** |
| `enable-movement` | Development convenience that enables and persists smooth movement |

Check the snapshot's `capture` field before trusting an old PNG. Images can
contain actual terminal content. Keep real captures private and local.
Check `capturedUtc` and advancing `frame` in snapshots/inventories too. Files
survive APK updates; a successful pull alone does not prove fresh evidence.
With no keyboard focus, `capture-focused-terminal` captures the oldest open
attached panel without taking input focus. This remains fixed-mono evidence.

## Settings and timing

The partial settings tablet toggles with left Menu; the right tracked trigger
ray changes the connected controls. Right Menu stays system-owned. Movement
is captured while the panel is open, and focus/tracking loss cancels presses.
Keep the owner's smooth-movement, Smooth-turning and Off-vignette choices.
Controller-optional startup is not hand-tracking support. Physical
grab/holster/poke and the broader tablet pages/settings are not complete.
Text input is external-keyboard-only, including Bluetooth. There is no virtual
typing keyboard. The full terminal has compact Tab, arrows, Ctrl+C, Esc,
Ctrl+Enter, Ctrl+X and Enter controls. Software key injection is not proof of
the connected Bluetooth keyboard or physical controller interaction.

For timing, request `capture-performance` while worn and focused, then pull
`development-performance.csv` only after a new `performance=Complete`.
Require a fresh `captured_utc` header, `focused_only=True`, the requested 30 or 120 seconds,
the requested build, advancing populated workload and the expected eye targets.
Interrupted warmup/recordings are not valid samples. The capture now marks
frame gaps over one second as interrupted rather than completing after sleep.
Do not include resource/image captures in a timing run.

The 2026-10-02 automated native-90 CSV has a legacy `Complete` header but an
831-second pause and 911-second duration. **Reject it for FPS acceptance**.
Do not reuse the earlier 72 Hz CSV as 90 Hz evidence.

Record workspace/tablet open and closed, with two updating focused terminals,
as section 14.3 requires. That workload is not implemented fully yet. API
foveation readback does not establish the bound eye-tracked profile. Unsupported
Android XR metrics and missing GPU/render counters remain explicit gaps.

## Reconnect and cleanup

For isolated reconnect tests, stop only the fixture process you launched. Request `status`; verify
`connected=false` with workers retained. Restart that fixture, verify a higher
generation, restored grids and unchanged app PID. Never kill the owner's server.
Inspect that app PID's logcat separately.

When finished with an isolated fixture, stop it and remove only its reverse mapping:
`adb -s SERIAL reverse --remove tcp:14600`. Do not remove other mappings,
uninstall either app or clear data.
The real server and its reverse mapping stay available while the owner is
testing. Stop an authorized recurring wake loop when its testing session ends;
never change proximity/security settings to defeat headset doff behavior.

The diagnostics assembly has no release implementation, network listener,
exported receiver or arbitrary evaluation. Evidence stays ignored. Wear-dependent
checks and section 16 surface approval remain pending until actually performed.
