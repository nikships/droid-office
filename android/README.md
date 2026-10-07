# Droid Office for Android

A companion app for your phone. Pair it with your office once, and from anywhere on your Wi-Fi or your tailnet you can see every worker, hire new ones, watch their live terminals and prompt them.

<p>
  <img src="docs/home.jpg" alt="The office's workers listed by floor, each with its status, desk and what it is doing" width="24%">
  <img src="docs/worker.jpg" alt="A worker's live terminal with the composer and quick keys under it" width="24%">
  <img src="docs/hire.jpg" alt="The hire sheet: Droid or Shell, a first prompt, a model and the reasoning effort" width="24%">
  <img src="docs/notification.jpg" alt="Notifications that a worker is done and another needs you, with a reply box" width="24%">
</p>

## What it does

- **Pair with a QR code.** Open ⚙️ Settings → **Phone** in the office on your computer, choose **📱 Pair a phone** and scan the code. The app also takes the join URL's QR code from the office's terminal, a `droidoffice://pair` link, or a pasted link.
- **Every worker, every floor.** Workers are grouped by floor, the ones that need you first, with what each is doing, its desk and its branch. Pull down to refresh. Subagents sit under their lead.
- **Live terminals.** A worker's real PTY streams in, sized to fit your screen's width. Pinch to zoom, double-tap (or **Aa**) to switch between fit and zoomed, and scroll back through the history; **Latest** brings you back to the end.
- **Prompt and type.** The composer sends a prompt to a Droid worker, with up to 10 photos attached. A shell worker gets a single command line. The quick keys under it send Enter, Esc, Tab, the arrows, Ctrl+C and the rest, so you can answer a question a worker asked.
- **Hire from your phone.** Pick Droid or Shell, a first prompt, a model and reasoning effort, and whether it gets its own git worktree. The office seats it at the first free desk, then the first free bean bag, or puts it on the task queue.
- **Run the floor.** Resume a sleeping worker, ask a worker on a branch to open its pull request (or open the one it has), copy what's on its screen, or send it home (keeping or deleting its worktree and branch).
- **Notifications with replies.** When a worker needs you or finishes, the phone notifies you. Reply from the notification and the reply goes straight to that worker. Turn on **Stay connected** to keep the connection open while the app is in the background; otherwise notifications only arrive while the app is open or shortly after.
- **More than one office.** Pair a laptop and a server and switch between them under **Offices**.
- **Tablets.** On a wide screen the worker list and the terminal sit side by side.

<p>
  <img src="docs/welcome.jpg" alt="The welcome screen with Scan the office's QR code and Paste a join link" width="19%">
  <img src="docs/scan.jpg" alt="The QR scanner with a frame and a torch button" width="19%">
  <img src="docs/pair.jpg" alt="Pairing: finding the office, pairing and connecting, each with a check mark" width="19%">
  <img src="docs/terminal-zoom.jpg" alt="A zoomed-in terminal" width="19%">
  <img src="docs/unpaired.jpg" alt="The screen shown after the office forgot this phone, with Pair again" width="19%">
</p>

## Install it

You need Android 9 or newer and an office new enough to pair phones (one whose ⚙️ Settings has a **Phone** category).

1. Download `Droid-Office-<version>.apk` from the [latest release](https://github.com/nikships/droid-office/releases/latest) on your phone.
2. Open it and allow your browser or file manager to install apps when Android asks.
3. Open **Droid Office**, tap **Scan the office's QR code**, and scan the code from ⚙️ Settings → **Phone** on your computer.

Each release's APK carries the same version as the office it shipped with. Installing a newer one over the old keeps your paired offices.

## How it connects

- **Wi-Fi first, then Tailscale.** The pairing code lists the office's Wi-Fi addresses, then its Tailscale MagicDNS name and `100.x.y.z` address. Each time it connects, the app asks every address at once and uses the first that answers, but waits a moment (600 ms) for a Wi-Fi address still in flight before settling for Tailscale. It races again whenever the phone's network changes, so walking out of the house moves it to Tailscale on its own. For Tailscale, sign the phone in to the same tailnet as the office's machine.
- **Device token.** Pairing trades the office's one-time LAN token for a device token of its own (`POST /api/mobile/pair`), so the phone stays paired when the office restarts. The app sends it as `Authorization: Bearer` on every request and on the WebSocket. Against an office from before phone pairing, the app falls back to the LAN token in the link, which stops working when that office restarts.
- **Forgetting a phone.** **Forget** next to the phone in the office's Phone window, or **Forget** next to the office under **Offices** in the app, unpairs it. When the office refuses its token (a `401`, or the WebSocket closing with `4401`), the app stops reconnecting and shows **Pair again**.
- **Reconnects.** A dropped connection retries after 1 s, 2 s, 4 s … up to 30 s. The app keeps its connection while it is on screen, while **Stay connected** is on, or while it sends a notification reply, and closes it 20 seconds after the last of those ends.

## Security

- The device token is as good as a shell on the office's machine. The app keeps it encrypted with an AES-256-GCM key in the Android Keystore (hardware backed where the phone has it), and turns off Android's cloud and device-to-device backups, so a new phone pairs again.
- An office serves plain HTTP on its LAN and tailnet addresses, so the app allows cleartext, but only to private addresses: loopback, link-local, RFC 1918, Tailscale's `100.64.0.0/10` and IPv6 unique-local. `net/CleartextGuard.kt` checks the address each connection actually reached, before any of the request is sent. An office on a public address needs HTTPS. Only the system's certificate authorities are trusted.

## Build it

You need JDK 17 or newer (CI uses 21) and the Android SDK with platform 37. Android Studio provides both; on the command line, point `ANDROID_HOME` at the SDK or write `sdk.dir=<path>` to `android/local.properties`.

Run from `android/`:

| Task | Command |
| --- | --- |
| Unit tests | `./gradlew testDebugUnitTest` |
| Lint (any error fails) | `./gradlew lintDebug` |
| Debug APK (`ai.factory.droidoffice.debug`, installs next to a release build) | `./gradlew assembleDebug` |
| Install the debug APK on a connected phone or emulator | `./gradlew installDebug` |
| Release APK, minified with R8 | `./gradlew assembleRelease` |

The release APK is signed with the keystore in `ANDROID_KEYSTORE_FILE`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD` when they are set, and with the debug key otherwise. A debug-signed APK installs, but not as an update over one signed with the real key. `-PofficeVersion=0.1.123 -PofficeVersionCode=123` sets its version.

To try it against a local office from an emulator, start the office (`node bin/droid-office.js <project>`), open ⚙️ Settings → **Phone**, and pass the link to the emulator; `10.0.2.2` is the host machine:

```bash
adb shell "am start -a android.intent.action.VIEW -d 'droidoffice://pair?v=1&name=My%20Mac&t=<token>&u=http://10.0.2.2:4600'"
```

## In CI

The `android` job in [`.github/workflows/release.yml`](../.github/workflows/release.yml) runs the unit tests and lint, builds the release APK with the office's release version, and uploads it as the `android` artifact. On `main`, the publish job attaches it to the GitHub release next to the Mac app. It signs with the repository secrets `ANDROID_KEYSTORE_BASE64` (the keystore file, base64), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD` when they exist. Make one keystore and keep it: every release has to be signed with the same key to install over the last.

```bash
keytool -genkeypair -v -keystore release.jks -alias droid-office -keyalg RSA -keysize 4096 -validity 10000
base64 -i release.jks | gh secret set ANDROID_KEYSTORE_BASE64 --repo nikships/droid-office
```

## Project layout

| Path | Contents |
| --- | --- |
| `app/src/main/java/ai/factory/droidoffice/core/` | Pure Kotlin, no Android: the pairing link parser, route kinds and the route race, the WebSocket protocol, the terminal screen model, worker grouping and labels |
| `data/` | Paired offices and settings (DataStore) and the Keystore token vault |
| `net/` | The HTTP API (OkHttp), the cleartext guard and the network monitor |
| `session/` | `OfficeConnection`, the one connection to the current office (route race, WebSocket, reconnects, who holds it open), and `Pairer` |
| `notify/` | Notifications, direct replies and the Stay connected foreground service |
| `ui/` | Compose screens: `onboarding/`, `home/`, `worker/`, `offices/`, plus the theme and shared components |
| `app/src/test/` | JUnit tests for `core/` |
| `docs/` | The screenshots on this page |
