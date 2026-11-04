# Android Workers list

The Android companion app lists every worker on every floor of the paired office, with status, model, task and branch. The owner opens a worker to read its Thread or Raw TTY and send it prompts.

## Sub-features

- `android-home` lists workers grouped by floor (`screen.home`, `home.worker/<id>`, `home.floor/<id>`).
- `android-status` shows each worker's status as the content-desc of `home.worker.status` (`Needs you`, `Working`, `Ready`, `Done`, `Asleep`).
- `android-open` opens a worker (`screen.worker`), with `worker.view.thread` and `worker.view.tty`.
- `android-hire` hires from the phone (`hire.droid`; `hire.shell` opens a shell at once).
- `android-hire-asks` opens a shell's terminal from Asks → Hire → Shell, without switching to Office first.
- `android-hire-snackbar` opens a shell immediately even while a Droid's Open snackbar remains visible.

## How to get to it (user POV)

- Open Droid Office on the phone and choose the Office tab (`tab.office`).
- Tap a worker card to open it.
- Tap Hire on Office, or Hire on an empty Asks tab, then Shell.

## Driving it with adb and uiautomator

Preconditions:

- `adb devices` lists one device or emulator (`doctor.sh` prints the count). The Mac Mini has the `asks35` AVD: `~/Library/Android/sdk/emulator/emulator -avd asks35`.
- The debug app is installed: `cd android && ./gradlew installDebug`. Its package is `ai.factory.droidoffice.debug`, and its activity is `ai.factory.droidoffice.MainActivity`.
- The app is paired with the run's office, and a worker is hired there (`hire-shell`).

- **Unit tests and lint.** Run `cd android && ./gradlew testDebugUnitTest lintDebug`. Exit code `0`. Save the console to `$EVIDENCE/android/gradle.txt`.
- **Reach the office.** Run `adb reverse tcp:$PORT tcp:$PORT` so the device reaches the run's office on its own `127.0.0.1`.
- **Pair on loopback.** Open `droidoffice://pair?v=1&name=Office%20clone&t=loopback-verification&u=http://127.0.0.1:$PORT` with `adb shell am start -a android.intent.action.VIEW -d '<link>' -p ai.factory.droidoffice.debug`, then tap `pair.open`. The placeholder is not a real LAN token: the isolated server trusts the connection arriving through `adb reverse` on loopback. Do not use this outside the isolated run.
- **Open the list.** Run `adb shell am start -n ai.factory.droidoffice.debug/ai.factory.droidoffice.MainActivity`, then `adb exec-out uiautomator dump /dev/tty | sed 's/<node /\n<node /g' | grep 'resource-id="[^"]'`. The dump has `screen.home` and a `home.worker/<id>` whose id matches the office's worker.
- **Status.** The same dump has `home.worker.status` with the content-desc `Ready` for an idle Shell.
- **Proof.** Run `adb exec-out screencap -p > $EVIDENCE/android/home.png` and save the dump to `$EVIDENCE/android/home.xml`.

## Gotchas

- Live proof on a Pixel 9 Pro XL emulator paired through `adb reverse` with a clone of the owner's office confirmed Asks → Hire → Shell, immediate terminal navigation despite a pending Droid Open snackbar, and the non-clickable Droid label. Android exposes its selected semantics as `checked`, without a radio-button class.
- The pairing link and the device token are secrets. Do not dump them into evidence.
- `uiautomator dump` fails while a terminal is changing. Retry once it settles, or dump from the home screen.
- A debug build cannot install over a release build. Uninstalling the release forgets the owner's paired offices, so do not do it on the owner's phone.
