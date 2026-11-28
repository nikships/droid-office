# Android app

The Android `app` and iOS `mobile` targets compile the same Compose screens and session code against `core`. Keep platform calls in platform-specific files rather than forking a screen. See [iOS build and simulation](../ios/README.md). Update [README.md](README.md) whenever user-visible behavior or adb tags change.

## Commands

Run from `android/` with JDK 17+ (CI uses 21; SDK from `ANDROID_HOME` or `local.properties`). Before a PR touching Android, run `./gradlew testDebugUnitTest :core:testAndroidHostTest lintDebug :core:lint assembleRelease` (`assembleRelease` exercises R8, which CI runs only on `main`; root `npm test` covers the WebView JS assets):

| Task | Command |
| --- | --- |
| Unit tests (JVM) | `./gradlew testDebugUnitTest :core:testAndroidHostTest` |
| Shared core for iOS (Mac with Xcode and an iOS simulator runtime) | `./gradlew :core:compileKotlinIosArm64 :core:iosSimulatorArm64Test` |
| Android Lint (warnings as errors) | `./gradlew lintDebug :core:lint` |
| Install debug APK on connected device | `./gradlew installDebug` |
| Release APK with R8 | `./gradlew assembleRelease` |

## Office contract

- Mirror messages and fields read by the app in `core/Protocol.kt` (`src/shared/protocol.ts`, `src/server/server.ts`) and cover changes in `ProtocolTest`. Keep `ignoreUnknownKeys` enabled so older APKs tolerate newer servers.
- Pairing (`droidoffice://pair`, `/api/mobile/pair`, `/api/mobile/hello`, device tokens, close code `4401`) follows [docs/guide/android.md](../docs/guide/android.md). Keep `core/Pairing.kt` parsing every link the office prints, including `?t=` join URLs, and keep the LAN-token fallback for servers without `/api/mobile/*`.

## Architecture and code

- **Shared `core/` vs `ui/`**: `core/` is the `:core` Kotlin Multiplatform module the iOS companion shares (parsing, ordering, labels, terminal model in `core/src/commonMain/`); keep `ui/` to Compose layout and state wiring. Keep commonMain free of Android and JVM APIs (no `java.*`): put what needs the platform in `Platform.kt`, with the JDK call as the `androidMain` actual and Foundation as the `iosMain` one. Android-only code in the `core` package (APK updates, on-disk receipts) stays in `app/src/main/java/ai/factory/droidoffice/core/`. Put platform-independent contracts in `core/src/commonTest/` so Android and iOS run them both; JVM-only tests and Node-shared golden files belong in `core/src/androidHostTest/`. Kotlin won't smart-cast a `:core` property in `app`, so copy it to a local `val` first. Share the single `OfficeConnection` via `hold(tag)` and `release(tag)`. Show the worker list on every screen size, with a side-by-side detail pane on wide screens.
- **WebViews**:
  - Terminal (`app/src/main/assets/terminal/` ↔ `ui/worker/TerminalPage.kt` via `core/TermPage.kt`): put DOM-free logic in `input.js` (`tests/android-terminal.test.ts` checks `input.js`). Regenerate `terminal/vendor/` with `node tools/android-terminal.mjs` (see [tools/AGENTS.md](../tools/AGENTS.md)). Keep the page offline and suppress the renderer's PTY query replies (the office's terminal already answers PTY queries).
  - Whiteboard (`app/src/main/assets/whiteboard/` ↔ `ui/board/CardPage.kt` via `core/WbPage.kt`): frame cards with `CARD_SANDBOX` and `CARD_ALLOW` over `src/shared/whiteboard-bridge.ts`, accepting messages only from the wrapper page's origin. Keep DOM-free logic in `marks.js` (`tests/android-whiteboard.test.ts`) and update the wrapper whenever the web Whiteboard bridge changes.
  - Rich blocks (`app/src/main/assets/richblock/` ↔ `ui/worker/RichBlock.kt` via `core/RichPage.kt`): draws a reply's Mermaid diagrams (sanitizing the SVG as `src/client/ui/diagram.ts` does) and `$$` equations (KaTeX) offline; `core/TexMath.kt` finds math as `extractMathSegments` in `src/client/ui/thread-markdown.ts` does, so keep the two aligned. Keep DOM-free logic in `logic.js` (`tests/android-richblock.test.ts`) and regenerate `richblock/vendor/` with `node tools/android-richblock.mjs`.
- **Security**: Route all tokens exclusively through `TokenVault`, and scrub tokens, pairing links and `t=` / `d=` query params from logs. Attach `net/CleartextGuard.kt` as a network interceptor on every `OkHttpClient` so cleartext `http://` and `ws://` connect only to private IPs.
- **Theme, copy & adb tags**: Use `ui/theme/` tokens (dark palette, Factory orange, Geist / Geist Mono), add vector paths to `ui/theme/OfficeIcons.kt` rather than importing an icon pack, and match the web client's plain sentence-case voice. Register every new screen root, control and readable state in `core/Tags.kt` (`Modifier.tagged(...)`, documented in `README.md`), keeping existing tag names stable. Wire toggle rows with `toggleable` (`Switch(..., onCheckedChange = null)`) and choices with `selectable` so `uiautomator dump` reports `checked`. Run infinite animations in the draw phase so layout bounds stay still and `uiautomator dump` idles.
- **Lint, dependencies & screenshots**: Fix lint findings in code rather than adding `@SuppressLint` or widening `lint { disable }`. Manage dependencies in `gradle/libs.versions.toml` (update `distributionSha256Sum` in `gradle/wrapper/gradle-wrapper.properties` when bumping Gradle). Capture `docs/*.jpg` (540px wide) on a real paired phone and replace screenshots in a dedicated change.
