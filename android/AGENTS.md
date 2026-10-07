# Android app

Droid Office for Android: Kotlin, Jetpack Compose and Material 3, one `app` module. [`README.md`](README.md) describes what it does, how it connects and how to build it; keep it current when a behaviour it describes changes.

## Commands

Run from `android/` with JDK 17+ (CI uses 21). The SDK path comes from `ANDROID_HOME` or the ignored `local.properties` (`sdk.dir=...`).

| Task | Command |
| --- | --- |
| Unit tests | `./gradlew testDebugUnitTest` |
| Lint; any error fails | `./gradlew lintDebug` |
| Build and install a debug APK on the connected device | `./gradlew installDebug` |
| Release APK (R8) | `./gradlew assembleRelease` |

CI's `android` job in `.github/workflows/release.yml` runs `testDebugUnitTest lintDebug` and then `assembleRelease`; run the same before a PR. `npm` checks don't cover this directory.

## The office is the contract

- The app speaks the office's WebSocket protocol (`src/shared/protocol.ts`) and HTTP routes (`src/server/server.ts`). `core/Protocol.kt` mirrors the messages the app uses; when the server adds or renames a field the app reads, update it and `ProtocolTest`. Unknown fields and messages are ignored (`ignoreUnknownKeys`), so an older app keeps working against a newer office.
- Pairing (`droidoffice://pair` links, `/api/mobile/pair`, `/api/mobile/hello`, device tokens, close code `4401`) is described in [docs/guide.md "Droid Office for Android"](../docs/guide.md#droid-office-for-android). `core/Pairing.kt` must keep parsing every link the office can print, including the plain join URL with `?t=`.
- An office from before phone pairing has no `/api/mobile/*`: the app falls back to the LAN token. Keep that path working.

## Code

- `core/` is pure Kotlin with no Android imports, so its JUnit tests run on the JVM. Put logic there (parsing, ordering, labels, the terminal model) and keep `ui/` to layout and state wiring.
- One `OfficeConnection` owns the socket for the current office. Screens and services `hold(tag)` and `release(tag)` it rather than opening their own.
- Tokens only ever go through `TokenVault`. Never log a token, a pairing link or a request URL that carries `t=` or `d=`.
- Plain HTTP and `ws://` are allowed only to private addresses, enforced by `net/CleartextGuard.kt` on the address actually connected. Every OkHttp client gets it as a network interceptor.
- Colours, type and shapes come from `ui/theme/` (the office's dark palette and Factory orange, Geist and Geist Mono). Icons are vector paths in `ui/theme/OfficeIcons.kt`; add one there instead of pulling in a larger icon library.
- Strings a user sees are plain sentences in the office's voice, matching the web client.
- Agents drive the app over adb by the names in `core/Tags.kt` (README "Drive it with adb"). Give every new screen root, control and readable state a name there and set it with `Modifier.tagged(...)`; never rename or reuse one, and add it to the README. A toggle row is `toggleable` with its `Switch` given `onCheckedChange = null`, and a choice is `selectable`, so a dump reports it as `checked`.
- Never move a node's bounds every frame (a rotating `graphicsLayer`, an animated offset or size) on something that loops forever: the accessibility events it sends keep `uiautomator dump` from idling. Animate in the draw phase instead.
- Fix what lint reports. Don't add `@SuppressLint` or widen `lint { disable }` to pass; the ones disabled there only flag that newer library versions exist.
- Bump a library in `gradle/libs.versions.toml`. Updating Gradle itself also updates `distributionSha256Sum` in `gradle/wrapper/gradle-wrapper.properties`.

## Pictures

`docs/*.jpg` are the screenshots `README.md` shows, taken on the emulator at 540 px wide. Replacing one is its own change.
