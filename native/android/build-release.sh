#!/usr/bin/env bash
set -euo pipefail

# Keep signing material outside the checkout. CI supplies it only for releases on main.
version="${1:?Usage: build-release.sh VERSION [VERSION_CODE]}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
version_code="${2:-$(git -C "$root" rev-list --count HEAD)}"
[[ "$version_code" =~ ^[1-9][0-9]*$ ]] || { echo 'VERSION_CODE must be a positive integer' >&2; exit 2; }
: "${ANDROID_HOME:?Set ANDROID_HOME to the pinned Android SDK}"
: "${OFFICE_XR_KEYSTORE:?Set OFFICE_XR_KEYSTORE to the private signing keystore}"
: "${OFFICE_XR_STORE_PASSWORD:?Set OFFICE_XR_STORE_PASSWORD}"
: "${OFFICE_XR_KEY_ALIAS:?Set OFFICE_XR_KEY_ALIAS}"
export OFFICE_XR_KEY_PASSWORD="${OFFICE_XR_KEY_PASSWORD:-$OFFICE_XR_STORE_PASSWORD}"

sh "$root/native/android/gradlew" -p "$root/native/android" --no-daemon --console=plain \
  :app:assembleRelease "-PofficeVersionName=$version" "-PofficeVersionCode=$version_code"
tools="$ANDROID_HOME/build-tools/35.0.0"
out="$root/native/android/app/build/outputs/apk/release"
"$tools/zipalign" -f -P 16 4 "$out/app-release-unsigned.apk" "$out/app-release-aligned.apk"
rotation=()
if [ -n "${OFFICE_XR_LINEAGE:-}" ]; then
  # Android 9+ verifies v3 and its proof of rotation. No old private key is needed for signing.
  rotation=(--lineage "$OFFICE_XR_LINEAGE" --rotation-min-sdk-version 28 --v1-signing-enabled false --v2-signing-enabled false)
fi
"$tools/apksigner" sign --ks "$OFFICE_XR_KEYSTORE" --ks-key-alias "$OFFICE_XR_KEY_ALIAS" \
  --ks-pass env:OFFICE_XR_STORE_PASSWORD --key-pass env:OFFICE_XR_KEY_PASSWORD \
  --v4-signing-enabled false "${rotation[@]}" --out "$out/droid-office-xr.apk" "$out/app-release-aligned.apk"
"$tools/apksigner" verify --verbose --print-certs -Werr "$out/droid-office-xr.apk"
"$tools/zipalign" -c -P 16 4 "$out/droid-office-xr.apk"
cd "$out"
if command -v sha256sum >/dev/null; then
  sha256sum droid-office-xr.apk > droid-office-xr.apk.sha256
else
  shasum -a 256 droid-office-xr.apk > droid-office-xr.apk.sha256
fi
echo "Signed APK: $out/droid-office-xr.apk"
