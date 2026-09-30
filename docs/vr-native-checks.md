# Native XR checks

The native Galaxy XR app in `native/android` ([vr-native-android.md](vr-native-android.md))
has two kinds of automated checks: host tests that need no headset, and the Android debug
and release builds. Both run in CI. Neither replaces the on-device acceptance checks in
vr-native-android.md.

| Command | Needs | Checks |
| --- | --- | --- |
| `native/tests/run-host.sh` | A C++17 compiler with ASan and UBSan, `curl`, `unzip`, `glslangValidator`, Node and the repository's installed npm dependencies and Chromium | Host C++ tests, scene packet/replay/GLES suite and required shader pixel comparison |
| `native/tests/run-host.sh --android-sdk DIR --require-java` | The above, plus JDK 17 or newer and `platforms;android-35` in `DIR` | All host checks and Java rules tests |
| `cd native/android && ./gradlew --no-daemon :app:assembleDebug` | JDK 17 or 21, and SDK platform 35, build tools 35.0.0, NDK 27.2.12479018 and CMake 3.22.1 | The installable debug APK |
| `cd native/android && ./gradlew --no-daemon :app:assembleRelease` | The same pinned Android toolchain | The unsigned optimized release APK |

Run the commands from the repository root, except the Gradle build. None of them uses `adb`
or a connected headset.

Install the existing npm dependencies with `npm ci` and the Chromium revision selected by
the locked `playwright-core` package with `npx --no-install playwright-core install chromium`.
On Linux, use `npx --no-install playwright-core install --with-deps chromium` to install its
system dependencies too, and install `glslang-tools` with the system package manager. On
macOS, `brew install glslang` supplies `glslangValidator`. A missing browser, validator or npm
dependency fails the shader suite; the pixel comparison cannot silently drop out. To use an
already installed local Chrome on macOS, set
`OFFICE_XR_BROWSER_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'`.

The GLES render check is required too. Linux uses Mesa EGL/GLES with
`EGL_PLATFORM=surfaceless` and software rendering. macOS needs host EGL/GLES libraries and
headers: set `ANGLE_LIB` to the directory containing `libEGL.dylib` and `libGLESv2.dylib`,
and `GL_HEADERS` to the directory containing `EGL/`, `GLES3/` and `KHR/`. Missing libraries
or headers fail the suite. Driver-global leak reporting is disabled only for the GLES
process; address and undefined-behavior sanitizers remain active.

## Host tests

`native/tests/run-host.sh` compiles each C++ test together with the production sources it
covers, using `CXX` (default `c++`), and runs it:

- `native/tests/bridge_state_test.cpp` with `bridge_state.cpp`: pose math, panel rays, bridge
  packet validation, pointer events and frame metric percentiles.
- `native/tests/xr_performance_test.cpp` with `xr_performance.cpp`: a fake OpenXR runtime
  checks the performance-metrics counter flags, units and capacities, and the performance
  settings hints.
- `native/tests/rig_presentation_test.cpp` for the header-only `rig_presentation.h`: rig and
  fade interpolation, discontinuities, stale focus and rotation handling.
- `native/tests/graphics_controls_test.cpp` for the header-only graphics control rules:
  supported settings, quality selection and input bounds.
- `native/tests/refresh_policy_test.cpp`: bounded 90 Hz re-requests, focus loss, actual-rate
  recovery and invalid observations.
- `native/tests/hand_mesh_test.cpp` retains standalone checks for the historical mesh code:
  bounded data, weighted bind-pose transforms and invalid joints. That renderer is no longer
  part of the controller-only app build.
- `native/tests/controller_model_test.cpp` with `controller_model.cpp`: both bundled Samsung
  meshes, malformed asset rejection and animated button transforms.

Two registered suites are required on every host run:

- `native/android/app/src/test/cpp/run.sh` generates a fixture from the original office and exporter,
  checks packet/model rules and replay, and renders it through the production GLES renderer.
  Mono, two-pass stereo and implicit preparation must agree; framebuffer, viewport and scissor
  bindings must survive first-time shadow allocation. Multiview comparison runs when the host
  driver exposes it. Before comparing pixels, every renderer must have drawn a state with
  no pending uploads, waiting state, shader compilation or queued texture work, within a
  bounded frame count. Each failed check is named again in the final summary. The fixture
  uses placeholder gradients for DOM canvas images; actual
  text and material pixels are compared in the browser shader suite.
- `native/android/app/src/test/cpp/shaders/check.sh` compiles the shader generator, checks
  uniform block layouts and generated-program contracts, validates and links every generated
  stage with glslang, and compares seven material cases against the original three.js code.
  Its strict block parser and contract checks self-test malformed declarations before reading
  the generated programs; malformed text must fail rather than be skipped.

The shader suite accepts `CXX`, the suite output directory and sanitizer flags just like the
other suites. It also cross-compiles the generator when the pinned NDK is present at
`ANDROID_NDK_HOME` or under `ANDROID_HOME`. The separate complete Android build remains
required in CI.

Chromium uses ANGLE Metal on macOS and ANGLE SwiftShader on Linux, where a hardware GPU is
not required. For toon, unlit, points and sky cases, generated sRGB pixels with both native
and three.js shadow maps, and opaque pixels in the linear-output variant, must differ by at
most 8/255 per channel. Every case must execute; malformed results, browser errors and
uniform/framebuffer diagnostics fail the comparison. The Standard case must also match
within 8/255 when supplied with three.js's DFG lookup table. The native analytic DFG
approximation is measured separately. Blended pixels in the linear-output variant remain
recorded diagnostics because sRGB framebuffer hardware blends in linear space while three.js
blends the comparison image in encoded space. `report.json` records both outputs, the opaque
subset, browser version/backend and all diagnostics, beside the comparison PNGs in the suite
output directory.

The tests use `-std=c++17 -Wall -Wextra -Werror=return-type`, as the Android build does, with
`-fsanitize=address,undefined -fno-sanitize-recover=all`. The tests check with `assert()`, so
the script always undefines `NDEBUG`. A sanitizer report, a failed assertion or a nonzero exit
fails the test.

With `--android-sdk DIR`, the script also compiles `NativeStatusPanelRulesTest` and
`OfficeWebServicesRulesTest` (in `native/android/hosttest`) against
`DIR/platforms/android-35/android.jar`. It then runs them on a plain JVM without
`android.jar`. The `Rules` classes must therefore make no Android calls, because the
`android.jar` stubs would not be there to answer them. `JAVA_HOME` selects the JDK;
otherwise `javac` and `java` come from `PATH`.

Without `--android-sdk`, the summary lists the Java tests as `NOT RUN`. With
`--require-java`, a missing `--android-sdk` is an error rather than a smaller run. CI passes
`--require-java`.

Options:

| Option | Effect |
| --- | --- |
| `--android-sdk DIR` | Also run the Java rules tests |
| `--require-java` | Fail unless `--android-sdk` is given |
| `--suite FILE` | Also run a suite script (repeatable), as described below |
| `--build-dir DIR` | Cache and output directory, default `native/android/build/host-tests` |
| `--timeout SECONDS` | Limit for each compile, test or suite step, default 300 |

The script exits 0 when every check passed, 1 when any check failed and 2 for a usage or
setup error. Examples of setup errors are a missing compiler, a failed download or a hash
mismatch. Each step prints one line, or the last 60 lines of its log when it fails, and the
run ends with a summary. The full logs stay in `native/android/build/host-tests/out`. A step
that runs past the timeout is stopped with its child processes and fails.

### Pinned dependencies

The script downloads the headers the Android build uses and checks their SHA-256 before
using them:

| Dependency | Source | SHA-256 |
| --- | --- | --- |
| nlohmann/json 3.12.0 `json.hpp` | the URL in `native/android/app/src/main/cpp/CMakeLists.txt` | `aaf127c04cb31c406e5b04a63f1ae89369fccde6d8fa7cdda1ed4f32dfc5de63` |
| OpenXR loader for Android 1.1.63 (prefab headers only) | `org.khronos.openxr:openxr_loader_for_android:1.1.63` on Maven Central, as in `app/build.gradle` | `622419d2f6741c3443a3beb4779af0764318edd01830de967f24c741ebcded73` |
| stb `stb_image.h` at commit `f58f558c120e9b32c217290b80bad1a0729fbb2c` | the URL in `CMakeLists.txt` | `594c2fe35d49488b4382dbfaec8f98366defca819d916ac95becf3e75f4200b3` |

`json.hpp` is available both as `"json.hpp"` and as `<nlohmann/json.hpp>`, as CMakeLists.txt
provides it.

The downloads are kept in `native/android/build/host-tests/cache`, which `.gitignore`
covers through `native/android/**/build/`. A cached file with the wrong hash is downloaded
again. When `CMakeLists.txt` or `app/build.gradle` moves to a new version, update the version,
URL and hash at the top of `run-host.sh` in the same change.

### Adding a test

Every test file must be registered in `run-host.sh`. A test that exists but is not
registered fails the run, and so does a registered test whose files are missing. Nothing is
skipped because a file happens to be absent.

- A C++ test named `native/tests/<name>_test.cpp` goes in `CPP_TESTS` as
  `"<name>|tests/<name>_test.cpp|<production sources>"`. For a header-only subject, leave the
  sources empty.
- A Java rules test named `<Class>Test.java` in package `dev.droidoffice.xr` goes in
  `JAVA_TESTS` as `"<Class>Test|<ProductionClass>"`. The source goes in `native/android/hosttest`
  or `native/android/app/src/test/java`, but not both.
- A suite with its own build goes in `SUITES` as a path from the repository root. Every
  `run.sh` or `check.sh` anywhere below `native/android/app/src/test`, and every
  `native/tests/*.sh` other than `run-host.sh`, that is not in `SUITES` fails the run.
  `--suite FILE` runs a suite
  once without registering it. Registering a suite in `SUITES` makes it required in CI as well.

### Suite contract

A suite is a bash script that `run-host.sh` runs from the repository root, with its output
captured, under the same timeout. It must exit nonzero when any of its checks fail, and print
a final line that says what passed. It receives:

| Variable | Contents |
| --- | --- |
| `CXX` | The compiler the host tests use |
| `OFFICE_XR_CXXFLAGS` | The host test flags, including the sanitizers (space separated) |
| `OFFICE_XR_JSON_INCLUDE` | The directory containing the verified `json.hpp` and `nlohmann/json.hpp` |
| `OFFICE_XR_OPENXR_INCLUDE` | The directory containing the verified `openxr/openxr.h` |
| `OFFICE_XR_STB_INCLUDE` | The directory containing the verified `stb_image.h` |
| `OFFICE_XR_SOURCE` | `native/android/app/src/main/cpp`, as an absolute path |
| `OFFICE_XR_TEST_OUT` | An empty directory, recreated each run, for its binaries and logs; its captured output goes to the `.log` file beside it |

A suite that needs another dependency pins and verifies it itself. It must not reach outside
the repository, the output directory or its own verified downloads.

## Android build

The Gradle wrapper pins Gradle 8.13 through `distributionSha256Sum` in
`gradle-wrapper.properties`. Android Gradle Plugin 8.9.2 supports JDK 17 and 21. The build
reads `ANDROID_HOME`, or `sdk.dir` in an untracked `native/android/local.properties`. The
first build downloads the OpenXR loader from Maven Central, and CMake downloads `json.hpp`,
checking its hash. The result is `native/android/app/build/outputs/apk/debug/app-debug.apk`,
containing `liboffice_xr.so` and `libopenxr_loader.so` for `arm64-v8a`.

## CI

`.github/workflows/release.yml` runs on changes under `native/**`, among its other paths. After
the existing lint, typecheck, coverage, pack and install steps, it:

1. Installs Temurin JDK 17 with `actions/setup-java@v6`, caching Gradle's downloads, keyed on
   the files in `native/android`.
2. Installs an Android SDK into the runner's temporary directory. The job downloads Android SDK
   Command-line Tools 19.0 for Linux (`commandlinetools-linux-13114758_latest.zip`) and checks
   its SHA-256, `7ec965280a073311c339e571cd5de778b9975026cfcbe79f2b1cdcb1e15317ee`. That
   archive's SHA-1 matches the Android SDK repository manifest. `sdkmanager` then accepts the
   licenses and installs `platforms;android-35`, `build-tools;35.0.0`, `ndk;27.2.12479018` and
   `cmake;3.22.1`, verifying each archive against the repository manifest. The job prints each
   installed package's revision and fails if one is missing. Command-line Tools 20.0 and later
   replace `sdkmanager` with a wrapper that downloads the Android CLI at run time without a
   pinned version, so the job stays on 19.0. Moving to the Android CLI means pinning that
   download too.
3. Installs `glslang-tools`, `libegl1-mesa-dev` and `libgles2-mesa-dev`, and runs `npx --no-install playwright-core install --with-deps
   chromium`, using the browser revision selected by the existing locked npm dependency.
4. Runs `native/tests/run-host.sh --android-sdk "$ANDROID_SDK" --require-java`, including all
   two required scene/shader suites. `ANDROID_NDK_HOME` selects the pinned NDK.
5. Checks the Gradle wrapper jar's SHA-256 and compiles both `:app:assembleDebug` and
   `:app:assembleRelease` with `ANDROID_HOME` pointing at that SDK. APK version names match
   the desktop release, and version codes use the commit count.
6. On `main`, signs and verifies the release APK with `native/android/build-release.sh`.
   The Publish step attaches `droid-office-xr.apk` and its SHA-256 file alongside the desktop
   package. Pull requests compile the unsigned release variant without access to signing keys.

The job does not use the Android SDK preinstalled on the runner image. The image's NDK and
CMake versions differ from the pinned ones, and its contents change with each image
release. The job clears the image's `ANDROID_NDK*` variables so the build uses the pinned NDK.
Release signing requires repository Actions secrets `OFFICE_XR_KEYSTORE_BASE64`,
`OFFICE_XR_STORE_PASSWORD` and `OFFICE_XR_KEY_ALIAS`. `OFFICE_XR_KEY_PASSWORD` is optional
when the key and store passwords match. `OFFICE_XR_SIGNING_LINEAGE_BASE64` optionally contains
the public proof of signing-key rotation. The workflow decodes files only in the runner's
  private temporary directory and removes them when signing finishes. Private keys and passwords
must never be checked in.

The release builder points `ANDROID_SDK_ROOT` at the selected `ANDROID_HOME` and clears
inherited NDK overrides. The signing step must use the same pinned SDK as the compile step;
Gradle rejects a runner's conflicting preinstalled SDK path even when its APK was already built.

Each check starts only after the previous step succeeds. A failure in the office checks
therefore stops the native checks, and a native failure stops the job before the Publish step.

### Linux-only parts

The SDK installation and the workflow steps run only on Linux. They use `sha256sum`,
`GITHUB_ENV` and the Linux command-line tools archive. To reproduce them on macOS, run the
three commands at the top of this page against a local SDK with the same packages installed.
On the Ubuntu runner, `c++` is GNU g++; on macOS it is Apple Clang. The tests pass with
both, but a sanitizer report can appear with only one of them.

AddressSanitizer does not run in an x86_64 container emulated on an Arm Mac. Every
instrumented binary stops at startup with `AddressSanitizer: CHECK failed:
sanitizer_allocator_primary32.h`, before any test code runs. To reproduce the host tests on
Linux from an Arm Mac, use a native `linux/arm64` container. The SDK installation and Gradle
build do work under emulation, but slowly.
