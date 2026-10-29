# Droid Office for Android

A React Native companion for managing your office from a phone or tablet. It shares the web companion's worker hierarchy, workspace rules and management tools, while Kotlin owns pairing, the connection, notifications, photo uploads and terminal input. The desktop's first-person 3D office is separate; companions have no 3D map.

## Install and pair

Requires Android 9 or newer.

1. Download `Droid-Office-<version>.apk` from the [latest release](https://github.com/nikships/droid-office/releases/latest).
2. Open it and allow installation when Android asks.
3. On the office's computer, open **Settings → Phone & web → Pair a phone**. Scan its QR code, or paste its join link in the app.

Installing a release signed with the same key preserves your paired offices. The host must be awake and running. Use the same Wi-Fi network, or sign the phone into the host's Tailscale network.

## Workspace

- **Workers** shows the selected floor, with quick floor switching. Leads begin expanded; their real subagents nest underneath with status counts. Search and filters keep matching children's parent context. Fork ancestry and team badges do not create supervision.
- A phone shows one conversation with a quick worker switcher and previous/next controls. Wide screens keep the roster beside up to four distinct pinned, resizable panes.
- New supported local Droid panes open in **Thread**. **Raw TTY** handles shells and CLI dialogs. Existing panes remember their chosen view.
- Rows show task, status, parent, model, effort, activity and elapsed work. Local workers, board agents, shells, guests and cloud workers stay visible, with appropriate actions and explanations.
- Thread shows selectable Markdown, grouped tool activity, separate collapsible thoughts, plans, errors, earlier history and Droid's queue. **Send now** steers a running turn; **Queue** submits for a later turn. **Stop** and **Clear queue** are explicit actions.
- **Answer questions** opens a full-size workspace with complete question and option text when the transcript provides it. Radio buttons, checkboxes and custom text only edit the draft; **Submit answer** sends it. Changed questions and unsupported host versions cannot submit stale answers. Raw TTY remains available for other CLI dialogs.
- Prompts and hires support pictures. Slash commands come from Droid's built-ins and the worker's available skills and commands. Commands opening CLI dialogs reveal Raw TTY; `/quit`, `/exit` and mid-turn slash commands are refused.
- Only the active, ready terminal pane types or resizes the shared PTY. Thread reads never resize it. Other terminal consumers share the same subscription.
- Resume, fork, rebuild a lost worktree, inspect changes, open a pull request, bring in an eligible outside worker or send a worker home. Deleting a worktree requires its normal checks and confirmation. Sending a lead home never dismisses its children. Leads, not the companion UI, hire subagents.

**Floor changes preserve each floor's panes, drafts and attachments. Actual connection loss clears unsent text, question selections and attachments across every floor.** Closing a question workspace keeps its draft while that question is current. Reconnecting restores panes only, never actions. Messages already submitted to Droid's queue stay there. Layout persistence contains no drafts or pictures.

## Tools and device controls

**Tools** provides Whiteboard, issue and pull-request boards, Jira, pipelines and CI, worker changes, repository docs, AutoWiki, computers, environments, cloud sessions, floors, prompts, subscriptions, host updates and non-spatial settings. These are shared management windows in a bundled local host, not a remote dashboard.

Whiteboard cards retain their sandbox and capability checks. View cards, comment, mark up, use forms and ping eligible workers. A disconnect discards unconfirmed companion edits; reconnecting fetches current board state rather than replaying mutations. Controls restricted to the office's computer explain that restriction.

**Device** switches offices, pairs another office and opens native office management and phone settings. Native services retain notification replies, the Stay connected option, notification permissions, office renaming and app updates.

The Android updater checks public GitHub releases. It downloads only when requested, verifies the APK's digest, package, version and signing key, then opens Android's installer. Debug builds link to the release instead of replacing themselves. See [App updates](docs/updates.md).

**Tools → Host app** updates the signed Mac app running the office, not the phone APK. Installation requires confirmation. Source checkout hosts and older offices explain why remote updates are unavailable.

## Connection and security

- One native `OfficeConnection` owns the socket. It races the office's addresses, prefers Wi-Fi briefly over Tailscale, retries dropped connections with backoff and stops reconnecting when a token is revoked.
- Pairing exchanges the one-time LAN token for a device token. Older offices retain the LAN-token fallback. Forgetting the device on the host revokes access.
- Device tokens stay in the Android Keystore-backed vault. They never enter React Native state, management-page JavaScript, logs or layout files. Cloud and device-to-device backups are disabled.
- Plain HTTP is restricted to private addresses by `CleartextGuard` on the actual connected address. Public offices require HTTPS and a trusted certificate.
- Management pages load from bundled assets. Native validates HTTP methods and paths and adds authentication itself. The privileged message listener accepts only the local host's main frame, not a Whiteboard card or arbitrary iframe. Navigation, file/content access and off-policy requests are blocked.
- The bundled xterm page receives terminal output through native code. Typing uses a native Android input connection; xterm's terminal-query replies are never forwarded to the PTY.
- A warm native connection supplies an ordered state replay. A connected socket alone is not ready; actions wait for an authoritative welcome or floor arrival.

## Build

Use Node 22, npm, JDK 21 and Android SDK platform 37. Set `ANDROID_HOME`, or put `sdk.dir=<path>` in the ignored `android/local.properties`.

From the repository root:

```bash
npm ci
node tools/android-companion-tools.mjs
npm run typecheck
```

From `android/`:

| Task | Command |
| --- | --- |
| Unit tests | `./gradlew testDebugUnitTest` |
| Lint | `./gradlew lintDebug` |
| Debug APK | `./gradlew assembleDebug` |
| Release APK, bundled JavaScript and R8 | `./gradlew assembleRelease` |

Debug builds use Metro (`npm run mobile:start` from the root). Release builds bundle `index.mobile.js` and run without Metro. React Native codegen reads `src/mobile/specs/`.

Install explicitly on the intended emulator, not an unspecified connected device:

```bash
adb -s emulator-5580 install -r android/app/build/outputs/apk/debug/app-debug.apk
adb -s emulator-5580 reverse tcp:8081 tcp:8081
```

The debug package is `ai.factory.droidoffice.debug`; release is `ai.factory.droidoffice`. Pair an emulator through `10.0.2.2`, the host machine's address from Android. Never put a live pairing token in screenshots or logs.

The release build uses `ANDROID_KEYSTORE_FILE`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD` when supplied, otherwise the machine's debug key. `-PofficeVersion=0.1.123 -PofficeVersionCode=123` sets the version. Android will not install an APK over one signed by a different key; uninstalling loses its paired-office data.

After changing bundled assets, regenerate them from the root and commit the output:

- `node tools/android-companion-tools.mjs` for the management host.
- `node tools/android-terminal.mjs` for xterm vendor files.
- `node --import tsx tools/android-model-icons.mjs` for model logos, using the office's installed Chromium.

## Test and automate

Run root lint, typechecks and coverage, plus `./gradlew testDebugUnitTest lintDebug assembleRelease`. Runtime checks use a clone of the owner's real office and phone/tablet emulators. Check cold and warm startup, pairing, floor switches, four panes, notification links, keyboard input, images, disconnect cleanup and the management host's frame boundary.

React Native controls expose `testID` and accessible labels in `src/mobile/ui/`; native setup controls retain `core/Tags.kt`. Inspect actual nodes rather than using obsolete screen identifiers:

```bash
adb -s emulator-5580 shell uiautomator dump /sdcard/window.xml
adb -s emulator-5580 pull /sdcard/window.xml /tmp/companion-window.xml
adb -s emulator-5580 shell input tap <x> <y>
```

Deep links and notification intents open a worker or floor. Use the package matching the installed build:

```bash
adb -s emulator-5580 shell am start -n ai.factory.droidoffice.debug/ai.factory.droidoffice.MainActivity -a ai.factory.droidoffice.OPEN_WORKER --es office <officeId> --es worker <workerId>
adb -s emulator-5580 shell am start -n ai.factory.droidoffice.debug/ai.factory.droidoffice.MainActivity -a ai.factory.droidoffice.OPEN_FLOOR --es office <officeId> --es floor <floorId>
```

## CI and signing

The Android job in [release.yml](../.github/workflows/release.yml) installs root npm dependencies, builds the management assets, runs unit tests and lint, and compiles the release APK. Android, React Native, relevant shared/web sources, root dependency and build configuration changes trigger it. Pull requests compile without publishing or release credentials. Main releases publish the signed APK.

Repository secrets are `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`. Keep the release keystore outside the repository; a replacement key cannot update installed releases. Verify an APK with `apksigner verify --print-certs`. The release certificate (`CN=Droid Office Android, O=Droid Office, C=US`) has SHA-256 fingerprint:

```text
16:31:C7:B2:AA:27:08:2B:77:85:50:A0:CB:28:94:56:6D:D1:2F:5C:B2:45:7D:A2:11:E9:7A:79:65:DE:FB:21
```

## Source map

| Path | Responsibility |
| --- | --- |
| `../src/mobile/` | React Native workspace, session, Thread UI and native host contract |
| `../src/shared/` | Roster, workspace, tool policy, conversation and protocol logic |
| `app/src/main/assets/` | Bundled terminal, Whiteboard and management pages |
| `app/src/main/java/ai/factory/droidoffice/` | Native host, connection, pairing, security, notifications, device setup and terminal input |
| `app/src/test/` | Kotlin JVM regression tests |
| `../tests/mobile-*.test.ts` | Pure TypeScript mobile model and session tests |
| `docs/updates.md` | Android updater behavior and security |
