# Droid Office for iOS

The iPhone and iPad companion (iOS 17+) runs the Android app’s Compose screens: **Office**, **Workers**, **Board** and **Me**. Pair it with your Mac to move between floors, hire workers, answer questions, use Thread or Raw TTY, and open Whiteboard cards. **Me → Appearance** has the same artwork and typography as Android.

## Pair a device

1. Connect your Mac and phone to the same Tailscale network and keep the Mac awake. In Droid Office on the Mac, open **Settings → Phone & web → Pair a phone**.
2. In the companion, tap **Scan the office’s QR code** or **Paste a join link instead**. Keep the link private: it grants access to the office.
3. When the pairing screen says **Ready**, tap **Open the office**. Use **Me** to manage paired offices, appearance and notifications.

Each office credential is scoped to its paired origin and stored in this device’s Keychain. Revoke a lost phone from the Mac’s paired phones list. Physical iPhones require HTTPS; the simulator also accepts HTTP loopback for local testing. iOS can finish receiving updates briefly after the app backgrounds, but cannot keep Android’s foreground service running while suspended. Beta app updates come from TestFlight, not the Android release feed.

## Build and test

Use an Apple Silicon Mac, Xcode with an iOS simulator runtime, JDK 21 and the [Android build prerequisites](../android/README.md#build-it). Open `DroidOffice.xcodeproj`, select the **DroidOffice** scheme and an iOS simulator, then Run. Xcode builds `OfficeMobile` from `android/mobile`, including the shared screens, session and `android/core`, and bundles the Android artwork, fonts and offline WebView assets. No project generator or prebuilt framework is needed.

From the repository root, set `SIM_UDID` to a simulator from `xcrun simctl list devices available`, then run:

```sh
xcodebuild test -project ios/DroidOffice.xcodeproj -scheme DroidOffice \
  -destination "platform=iOS Simulator,id=$SIM_UDID" -parallel-testing-enabled NO
```

Run the welcome test on an unpaired simulator. To check saved pairing and the four main tabs, pair a second simulator to [an isolated office clone](../.agents/skills/office-clone/SKILL.md), set `TEST_RUNNER_OFFICE_TEST_PAIRED=1` and select `-only-testing:DroidOfficeUITests/PairingTests/testPairedOfficeTabs`.

## TestFlight

The bundle ID is `com.nikships.droid-office.ios`. Use the matching iOS app record in App Store Connect, select the developer team and archive **Release** for **Any iOS Device (arm64)** with an unused build number. Distribute the archive to App Store Connect. After processing, add the build to a TestFlight group. A public install link requires an external group, Beta App Review and an enabled public link. Never publish a private office pairing link as the TestFlight link.
