# Android app updates

## Distribution and decision

Droid Office ships one universal, release-signed APK on each public GitHub release, not through Google Play. CI sets Android's `versionCode` to the repository's global commit count, also the last number of `v<major>.<minor>.<count>`. The signing key stays the same, so an update keeps the app's data and paired offices.

The best fit is a user-triggered **Update now** button that downloads the APK inside the app, shows progress and opens Android's installer. There is no browser download, file-picker hunt, additional app or storage permission in the normal flow. Android's install confirmation remains the final step. Updates never force the owner out of a droid's terminal.

## Options researched

| Option | Fit |
| --- | --- |
| Google Play flexible in-app updates | Excellent background-download UX for a Play-distributed app. Not usable for our GitHub distribution: the app must be available on Play and owned by the user's Play account, with matching package and signing key. Reconsider if we publish on Play; don't add a library that cannot update today's installs. |
| `PackageInstaller` self-update without confirmation | Android 12+ can waive confirmation for a self-updating app if its target SDK meets that OS's floor, install-source permission is granted, and it declares `UPDATE_PACKAGES_WITHOUT_USER_ACTION`. It is not a universal guarantee: older Android, update ownership, device policies or future target-SDK floors can require `STATUS_PENDING_USER_ACTION`. A commit can kill the app mid-task, and sessions need durable status handling. Not worth that extra machinery for an explicit update button. |
| Download in-app, then Android's installer | Chosen. Works across our Android 9+ baseline, uses the platform's trusted update confirmation, preserves data, and only needs one-time permission to install from Droid Office. It adds no dependency: OkHttp, coroutines and AndroidX `FileProvider` are already present. |
| Android `DownloadManager`, then installer | Good for large downloads that must outlive process death. Adds a system download record, completion receiver, persistent IDs and querying/recovery, then still needs the installer and permission handling. Our current APK is about 21 MB. An app-owned cancellable download is simpler; rotation/navigation do not stop it, and finished downloads are reused. |
| An external updater such as Obtainium | Useful for owners who want an app to track many GitHub APKs, but asking everyone to install and configure another app is not the best built-in UX. |
| Open the latest release in the browser | Reliable last resort, but makes the owner download, find/open an APK and authorize a different install source. Keep it available when direct updating fails or isn't supported. |

## Implemented flow

1. Check `GET https://api.github.com/repos/nikships/droid-office/releases/latest` when the app enters the foreground. Coalesce concurrent checks; throttle successful checks for an hour and failed checks for 15 minutes. Manual checks bypass that delay. OkHttp keeps HTTP cache validators, allowing conditional revalidation. There is no timer, background droid, GitHub credential or office token.
2. Ignore drafts, prereleases and version codes not higher than the installed code. Show a dismissible update snackbar once per version in the activity's saved state, plus a persistent control on the welcome screen and under **Offices → About**. A failed check never claims the app is up to date or removes an already-known update.
3. Accept only the exact `Droid-Office-<version>.apk` URL on that release in `nikships/droid-office`, with uploaded state, a sensible size and GitHub's SHA-256 digest. A newer release with incomplete/ambiguous metadata still offers the browser link.
4. Download only after **Update now**. Stream to a private `.part` file, limit the response size, verify the checksum, package, exact version, minimum Android version and installed signing certificates, then rename it to `.apk`. Errors and cancellations remove partial downloads. Never try a downgrade or a different package/key.
5. Ask for install-source permission only when an APK is ready. On returning from Settings with permission enabled, continue into Android's installer without another tap. Cancelling permission or installation leaves a retry and the browser fallback.
6. Share only the updater's private cache directory through a non-exported `FileProvider`, granting temporary read access. Updating replaces the APK without uninstalling or clearing app data. Android may close the app; the owner reopens it after installation.

The update object lives in the application's scope, not a screen. Downloads survive rotation and navigation, including **Keep using app**, but not process death. A completed cached APK is reverified and reused on the next update tap; an interrupted download restarts. Android may reclaim cache, so installation checks that the file still exists and downloads again if needed.

Debug builds have a different package (`.debug`), so they offer the latest-release link instead. Locally debug-signed release builds fail the signing-key check with an explanation, rather than leading the owner into an incompatible update. Key rotation would need an explicit signing-lineage change; today the updater requires the same current signer set.

## Limits

- GitHub's unauthenticated REST quota is 60 requests/hour per source IP. App throttling and HTTP validators reduce requests, but shared networks can still be rate limited. Failed checks are non-blocking, manual retry remains available, and the latest-release webpage is not the REST endpoint.
- There is no unattended download or installation, no forced update, and no attempt to bypass Android or a managed-device policy.
- Android's installer owns the final confirmation, cancellation and installation error UI. The app keeps a verified download ready for retry while its process is alive. It does not claim success merely because the installer opened.
- GitHub metadata/digest verification protects download integrity; Android's signature compatibility protects the installed app's identity. Neither is a substitute for protecting the release signing key.

## Sources

Official documentation researched on 2026-10-08:

- [Google Play in-app update flows](https://developer.android.com/guide/playcore/in-app-updates) and [ownership/testing requirements](https://developer.android.com/guide/playcore/in-app-updates/test).
- [How Google Play updates apps](https://developer.android.com/google/play/app-updates), including package, certificate and user-library requirements.
- [`PackageInstaller.SessionParams.setRequireUserAction`](https://developer.android.com/reference/android/content/pm/PackageInstaller.SessionParams#setRequireUserAction(int)), including self-update eligibility, SDK floors and required fallback.
- [`PackageManager.canRequestPackageInstalls`](https://developer.android.com/reference/android/content/pm/PackageManager#canRequestPackageInstalls()) and [`ACTION_MANAGE_UNKNOWN_APP_SOURCES`](https://developer.android.com/reference/android/provider/Settings#ACTION_MANAGE_UNKNOWN_APP_SOURCES).
- [FileProvider setup](https://developer.android.com/training/secure-file-sharing/setup-sharing) and [narrow-path/read-only sharing guidance](https://developer.android.com/privacy-and-security/risks/file-providers).
- [GitHub latest-release API](https://docs.github.com/en/rest/releases/releases#get-the-latest-release), [asset digests](https://github.blog/changelog/2025-06-03-releases-now-expose-digests-for-release-assets/) and [REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).
