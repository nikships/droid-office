# Port one Android artwork

Android ships all eight themes in the [web artwork inventory](artwork-reference.md). See the [complete picker](../docs/android-themes/screenshots/picker.png) or the applied themes: [Carbon’s Copy](../docs/android-themes/screenshots/carbons-copy.png), [Nightly Orbit](../docs/android-themes/screenshots/nightly-orbit.png), [Neo Tokyo](../docs/android-themes/screenshots/neo-tokyo.png), [Kyoto Firefly](../docs/android-themes/screenshots/kyoto-firefly.png), [Orbital Foundry](../docs/android-themes/screenshots/orbital-foundry.png), [Abyssal](../docs/android-themes/screenshots/abyssal-biolume.png), [Astral Cathedral](../docs/android-themes/screenshots/astral-cathedral.png) and [Sakura Mist](../docs/android-themes/screenshots/sakura-mist.png). There are no shader-only or gradient-only entries. With no selected ID the app uses the [original Android palette](../docs/android-themes/screenshots/original.png) and does not allocate a backdrop.

The native app is the Kotlin/Compose Material 3 `android/:app` module (min SDK 28, compile/target 37). It receives office state via `OfficeConnection` and keeps device choices in the `offices` Preferences DataStore via `OfficeStore`; paired-office credentials stay in `TokenVault`. Appearance is a device preference (`artwork_theme`), not a server setting or shared browser preference. Missing or unknown IDs resolve to Original. There is no wire protocol change.

1. **Stay in the theme’s file.** The eight ports mirror `src/shared/companion-themes.ts` at `4da17552`. Each has one `Artwork` definition under `app/src/main/java/ai/factory/droidoffice/ui/theme/artwork/`; [Carbon’s Copy](app/src/main/java/ai/factory/droidoffice/ui/theme/artwork/CarbonsCopy.kt) is the reference. All eight slots are populated and `Artworks.all` lists them in web order. Updating a theme needs **no registry edit**. For a new artwork, add its own file and register its symbol once in the gallery order.
2. **Encode both sizes.** From the repository root, set `id` below to the web ID. Use its full-resolution source, never a screenshot, a pre-cropped portrait or the gallery preview. The `drawable-nodpi` resources preserve pixel dimensions on phones and tablets; only the chosen theme decodes the 2048px wallpaper. The picker decodes only 480px previews.

   ```bash
   id=nightly-orbit
   name=${id//-/_}
   src="src/client/public/themes/$id.jpg"
   res=android/app/src/main/res/drawable-nodpi
   cwebp -quiet -mt -resize 2048 0 -q 85 "$src" -o "$res/art_$name.webp"
   cwebp -quiet -resize 480 0 -q 82 "$src" -o "$res/preview_$name.webp"
   ```

3. **Map the appearance.** Copy the ID, display name, blurb, palette, glass fraction, four terminal colors and CSS cover anchor (as fractions). Use opaque ARGB for Compose colors. The bundled opaque image covers the fallback gradient; the solid page color shows while loading. `ArtworkBackdrop` applies the cover crop, your `stage`, optional black `shade`, the shared elliptical vignette and readable glass in order. Carbon’s chrome is 64% tint and its default panes are 74%. Popup surfaces stay opaque. Use Sakura’s own veil instead of the default. Match `pictureShade(theme, 'frosted', brightGray(pixels))` using a 96px-wide thumbnail of the source when it needs dimming.
4. **Draw your overlay.** Read the named overlay in `src/client/ui/theme-shaders.ts`. Supply `speed` from the registry; the stage already receives scaled seconds. Approximate its colors, movement, opacity and blend mode with `DrawScope`. Put the stage helper in **your file**. Foundry can reuse `embers(hot, light, cool, opacity)`. Precompute particles once; do not allocate images, launch effects or update layout every frame. Keep system status, error and diff colors meaningful.
5. **Test and capture.** Add `app/src/test/java/ai/factory/droidoffice/artwork/<Name>Test.kt` covering your theme’s values and crop. The shared registry test picks up all populated slots automatically. Run from `android/` with JDK 21, Android SDK 37 and the emulator on adb:

   ```bash
   ./gradlew testDebugUnitTest lintDebug assembleRelease
   ANDROID_SERIAL=emulator-5554 ./gradlew installDebug
   adb -s emulator-5554 shell am start -n ai.factory.droidoffice.debug/ai.factory.droidoffice.MainActivity
   ```

   Use your actual serial from `adb devices`. Open Appearance (no pairing required), choose your entry, verify its selected state, tap Done, and confirm the colors and cover crop. Force-stop and reopen without clearing data; the selection must survive. Choose Original, confirm the wallpaper disappears, then reselect your theme. Compare portrait and landscape. Capture from the repository root after dismissing system dialogs:

   ```bash
   adb -s emulator-5554 exec-out screencap -p > "docs/android-themes/screenshots/$id.png"
   ```

   Each port owns its slot, two WebPs, test and screenshot. Update the shared picker screenshot once after integrating gallery changes.

At repository root, the normal gates are `npm ci`, `npm run lint`, `npm run typecheck`, `npm run test:coverage` in that order. `npm test` also exercises Android WebView JavaScript. `assembleRelease` above is a **local R8 check**, not a publication; do not bump a version, tag, push or run a release workflow to port artwork.
