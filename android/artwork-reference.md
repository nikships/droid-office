# Web artwork reference

Source: `src/shared/companion-themes.ts`, `src/client/ui/companion-theme.ts`, `src/client/ui/theme-shaders.ts` and `src/client/style.css` at `4da17552`. These are the eight artwork entries, in source order. Each full image below is relative to `src/client/public/` and its web gallery thumbnail is `themes/previews/<id>.webp`.

| ID | Name | Artwork | Cover anchor | Stage (speed, opacity, blend) | Stage colors |
|---|---|---|---|---|---|
| `carbons-copy` | Carbon’s Copy | `themes/carbons-copy.jpg` | 30% 50% | embers (0.8, 0.7, screen) | #ff7a2b, #ffb067, #7484ff |
| `nightly-orbit` | Nightly Orbit | `themes/nightly-orbit.jpg` | 50% 80% | starfield (0.6, 0.9, screen) | #ffffff, #cbb8ff, #ffb08a |
| `neo-tokyo` | Neo Tokyo | `themes/neo-tokyo.jpg` | 60% 50% | rain (1, 0.55, screen) | #9feaff, #ff8cc0, #ffffff |
| `kyoto-firefly` | Kyoto Firefly | `themes/kyoto-firefly.jpg` | 50% 50% | fireflies (0.7, 1, plus-lighter) | #ffd76a, #c9ff7a, #ffaa3b |
| `orbital-foundry` | Orbital Foundry | `themes/orbital-foundry.jpg` | 50% 45% | embers (1.1, 0.85, screen) | #ff5a36, #ffb347, #ffe2a8 |
| `abyssal-biolume` | Abyssal | `themes/abyssal-biolume.jpg` | 50% 40% | caustics (0.7, 0.55, screen) | #2ee6d6, #7a6bff, #bafcff |
| `astral-cathedral` | Astral Cathedral | `themes/astral-cathedral.jpg` | 50% 40% | nebula (0.5, 0.5, screen) | #c39bff, #f3c46b, #ffffff |
| `sakura-mist` | Sakura Mist | `themes/sakura-mist.jpg` | 50% 50% | petals (0.7, 0.95, normal) | #ffb7cf, #ffd9e6, #ff8fb8 |

| ID | Base / glass tint | Text / muted | Accents | Hairline | Pane alpha | Terminal: foreground / cursor / background / selection |
|---|---|---|---|---|---:|---|
| `carbons-copy` | #07070a / #0a0a0e | #f2f0ed / #aaa6a1 | #ff6a1f / #7484ff | #ffffff | 0.74 | #f2f0ed / #ff6a1f / #050507 / #3a2418 |
| `nightly-orbit` | #07051a / #0b0820 | #f1eeff / #aea6cf | #a97bff / #ff7a45 | #d9ccff | 0.72 | #f1eeff / #a97bff / #05031a / #33245c |
| `neo-tokyo` | #06060d / #090914 | #f4f1ff / #aaa5c2 | #ff3f8e / #2fe0ff | #e2dcff | 0.72 | #f4f1ff / #ff3f8e / #05050c / #4a1a33 |
| `kyoto-firefly` | #04100c / #061510 | #eef6ef / #a1b8aa | #f3c45a / #4fd1a1 | #d7f0e0 | 0.72 | #eef6ef / #f3c45a / #030d09 / #2c3a1e |
| `orbital-foundry` | #0a0505 / #100707 | #fbefea / #c0a59c | #ff5a36 / #ffb347 | #ffd9cc | 0.74 | #fbefea / #ff5a36 / #080303 / #4a1d14 |
| `abyssal-biolume` | #020b14 / #03101c | #eaf8fb / #93b4bf | #2ee6d6 / #7a6bff | #c9f4ff | 0.72 | #eaf8fb / #2ee6d6 / #010910 / #0f3a44 |
| `astral-cathedral` | #0d0a16 / #120e1f | #f5f0ff / #b6aacb | #c39bff / #f3c46b | #e6dbff | 0.74 | #f5f0ff / #c39bff / #0a0712 / #3a2c5a |
| `sakura-mist` | #1a1117 / #22161e | #fff4f8 / #d2b6c3 | #ff8fb8 / #ffd1e0 | #ffe0ec | 0.84 | #fff4f8 / #ff8fb8 / #160e13 / #5a2c40 |

There are **no ID-specific CSS selectors** for these artworks. All use fixed cover artwork, an overlay stage, optional automatic dim, and a top veil. The default is live motion, frosted glass, theme wallpaper, no requested blur or dim; the web player holds a frame for reduced motion. The chrome is 0.10 clearer than the panes. The shared veil is `radial-gradient(120% 90% at 50% 40%, transparent 55%, rgba(0, 0, 0, .55) 100%)`. Sakura uses `radial-gradient(120% 90% at 50% 40%, transparent 60%, rgba(40, 18, 30, .35) 100%)`.

### Fallback gradients under the opaque images

- **Carbon’s Copy:** `radial-gradient(70% 90% at 0% 100%, rgba(255, 106, 31, .28), transparent 60%), radial-gradient(60% 80% at 100% 0%, rgba(116, 132, 255, .22), transparent 60%), linear-gradient(160deg, #0b0b10, #050506)`
- **Nightly Orbit:** `radial-gradient(90% 60% at 50% 110%, rgba(169, 123, 255, .45), transparent 65%), radial-gradient(40% 40% at 85% 15%, rgba(255, 122, 69, .14), transparent 70%), linear-gradient(180deg, #05031a, #0b0628)`
- **Neo Tokyo:** `radial-gradient(60% 70% at 85% 30%, rgba(255, 63, 142, .25), transparent 65%), radial-gradient(50% 60% at 15% 70%, rgba(47, 224, 255, .2), transparent 65%), linear-gradient(180deg, #07071a, #05050a)`
- **Kyoto Firefly:** `radial-gradient(70% 70% at 30% 60%, rgba(79, 209, 161, .2), transparent 65%), radial-gradient(40% 40% at 80% 70%, rgba(243, 196, 90, .14), transparent 70%), linear-gradient(180deg, #06140f, #020806)`
- **Orbital Foundry:** `radial-gradient(50% 60% at 55% 45%, rgba(255, 90, 54, .35), transparent 70%), radial-gradient(80% 60% at 50% 100%, rgba(255, 179, 71, .12), transparent 70%), linear-gradient(180deg, #120606, #050202)`
- **Abyssal:** `radial-gradient(60% 60% at 30% 40%, rgba(46, 230, 214, .22), transparent 65%), radial-gradient(60% 60% at 80% 70%, rgba(122, 107, 255, .22), transparent 65%), linear-gradient(180deg, #03182a, #01060c)`
- **Astral Cathedral:** `radial-gradient(60% 80% at 50% 30%, rgba(195, 155, 255, .35), transparent 70%), radial-gradient(30% 40% at 50% 60%, rgba(243, 196, 107, .14), transparent 70%), linear-gradient(180deg, #1a1230, #07050d)`
- **Sakura Mist:** `radial-gradient(70% 60% at 70% 30%, rgba(255, 209, 224, .7), transparent 70%), linear-gradient(180deg, #f4dbe6, #e6e1f2)`

## Release path (reference only)

- The only workflow is `.github/workflows/release.yml`. Pull requests run the affected checks; no PR signs, versions or publishes. A path-filtered push to `main` (not a tag) or manual dispatch runs the workflow; publishing requires a non-PR run on `main`, successful checks, and at least one app platform rebuilt. Manual runs select everything. Docs/tests alone do not release an app.
- `.github/scripts/release-changes.mjs` uses the diff plus unshipped changes since the last successful release for pushes. Version = the first two parts of root `package.json` (currently `0.1.0`) plus `git rev-list --count HEAD`. Bump the package version only to begin a new minor. CI sets the checkout's version with `npm version "$version" --no-git-tag-version --allow-same-version`; it doesn't commit a patch bump. No hand-edited changelog or release tag is required.
- The Android PR job uses Ubuntu/JDK 21 and runs `cd android && ./gradlew testDebugUnitTest lintDebug`. On the self-hosted ARM64 Mac Mini, publishing runs those checks, then `./gradlew assembleRelease -PofficeVersion=<major.minor.count> -PofficeVersionCode=<count>` (minification and resource shrinking). Defaults without properties: versionName `0.1.0`, versionCode `1`; debug adds `.debug` to the app ID and `-debug` to the version name. CI names the artifact `Droid-Office-<version>.apk`.
- Repository secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` supply the persistent Android signing identity. The workflow decodes a temporary JKS and passes its path via `ANDROID_KEYSTORE_FILE`, verifies the APK with `apksigner verify --print-certs`, rejects a debug signature when a release key was supplied, then removes the JKS. Without a keystore Gradle falls back to the machine’s debug key; that is suitable for local checks, not for updating a production install. No Play Console account, Play upload, AAB or manual signing step is used.
- When the Mac changed, CI imports `MAC_CERTS` with `CERT_PASSWORD` into a temporary keychain, runs `npx electron-builder --mac --arm64 --publish never`, signs and notarizes with `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`, checks startup, verifies signatures, notarizes/staples the DMG and restores the keychain. Root `npm run package:mac` is a local build/package script, not the publisher. There is no npm publish or separate Android publication script.
- Artifacts meet under `~/ci-artifacts/run-$GITHUB_RUN_ID`. The publish job reuses the unchanged platform’s last signed artifacts and their existing versions (tag-matched local cache or download). With the workflow token's `contents: write`, it creates a draft `v<major>.<minor>.<count>` at the target SHA with generated notes and platform flags, uploads APK, DMG, ZIP, blockmaps and `latest-mac.yml`, then marks it published/Latest. A rerun replaces assets on the existing tag; an older run does not supersede a newer release. End users get the APK from GitHub Releases or the app's updater (which opens Android's installer).
