#!/usr/bin/env bash
# Runs the native checks that need no headset and no Android build: the host C++ tests under
# AddressSanitizer and UndefinedBehaviorSanitizer, the plain-JVM rules tests when an Android SDK
# is given, and any registered suite scripts. A registered check either passes or fails the run,
# and a test file that exists but is not registered also fails it. See docs/vr-native-checks.md.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: native/tests/run-host.sh [options]

Runs the host C++ tests and the registered suites. With --android-sdk it also runs the Java
rules tests.

Options:
  --android-sdk DIR   Also compile the Java rules tests against DIR/platforms/android-35/android.jar
                      and run them on a plain JVM (JDK 17 or newer, from JAVA_HOME or PATH).
  --require-java      Fail unless --android-sdk is given. CI passes it so the Java tests can't drop out.
  --suite FILE        Run an extra check script as well (repeatable), under the suite contract.
  --build-dir DIR     Download cache and output directory (default: native/android/build/host-tests).
  --timeout SECONDS   Limit for each compile, test or suite step (default: 300).
  -h, --help          Show this help.

Environment:
  CXX                 C++ compiler (default: c++).

Exit status: 0 when every check passed, 1 when a check failed, 2 for a usage or setup error.
EOF
}

# Pinned to the versions the Android build uses: CMakeLists.txt downloads this json.hpp and
# stb_image.h, and app/build.gradle depends on this OpenXR loader, whose prefab headers are used here.
JSON_VERSION=3.12.0
JSON_URL="https://raw.githubusercontent.com/nlohmann/json/v${JSON_VERSION}/single_include/nlohmann/json.hpp"
JSON_SHA256=aaf127c04cb31c406e5b04a63f1ae89369fccde6d8fa7cdda1ed4f32dfc5de63
STB_COMMIT=f58f558c120e9b32c217290b80bad1a0729fbb2c
STB_URL="https://raw.githubusercontent.com/nothings/stb/${STB_COMMIT}/stb_image.h"
STB_SHA256=594c2fe35d49488b4382dbfaec8f98366defca819d916ac95becf3e75f4200b3
OPENXR_VERSION=1.1.63
OPENXR_URL="https://repo1.maven.org/maven2/org/khronos/openxr/openxr_loader_for_android/${OPENXR_VERSION}/openxr_loader_for_android-${OPENXR_VERSION}.aar"
OPENXR_SHA256=622419d2f6741c3443a3beb4779af0764318edd01830de967f24c741ebcded73
ANDROID_PLATFORM=android-35

# Host C++ tests: "name|test source|production sources (space separated, may be empty for a
# header-only subject)|extra compiler flags (optional)", relative to native/. Every
# native/tests/*_test.cpp must appear here. A test may be registered twice with different flags.
CPP_TESTS=(
  "bridge_state|tests/bridge_state_test.cpp|android/app/src/main/cpp/bridge_state.cpp"
  "xr_performance|tests/xr_performance_test.cpp|android/app/src/main/cpp/xr_performance.cpp"
  "rig_presentation|tests/rig_presentation_test.cpp|"
  "graphics_controls|tests/graphics_controls_test.cpp|"
  "foveation|tests/foveation_test.cpp|"
  "refresh_policy|tests/refresh_policy_test.cpp|"
  "hand_mesh|tests/hand_mesh_test.cpp|"
  "controller_model|tests/controller_model_test.cpp|android/app/src/main/cpp/controller_model.cpp"
  "controller_attachment|tests/controller_attachment_test.cpp|"
  "vk_spike_logic|tests/vk_spike_logic_test.cpp|"
  "log_record|tests/log_record_test.cpp|"
  "scene_frame|tests/scene_frame_test.cpp|android/app/src/main/cpp/scene_frame.cpp android/app/src/main/cpp/scene_shaders.cpp"
  "status_layout|tests/status_layout_test.cpp|"
  "layer_occlusion|tests/layer_occlusion_test.cpp|"
  # The same source as the debug APK (puppet compiled in) and as the release APK (ignored).
  "capture_puppet_debug|tests/capture_puppet_test.cpp|android/app/src/main/cpp/bridge_state.cpp|-DOFFICE_CAPTURE_PUPPET=1"
  "capture_puppet_release|tests/capture_puppet_test.cpp|android/app/src/main/cpp/bridge_state.cpp|"
)
# Java rules tests: "test class|production class", both in dev.droidoffice.xr. The test source is
# looked up in JAVA_TEST_DIRS and must be in exactly one of them; the production source is
# app/src/main/java/dev/droidoffice/xr/<class>.java. Every *Test.java in those directories must
# appear here.
JAVA_PACKAGE=dev.droidoffice.xr
JAVA_TESTS=(
  "NativeStatusPanelRulesTest|NativeStatusPanel"
  "OfficeWebServicesRulesTest|OfficeWebServices"
  "OfficeDiscoveryRulesTest|OfficeDiscovery"
)
JAVA_TEST_DIRS=(hosttest app/src/test/java)
# Required suite scripts, relative to the repository root, run under the suite contract in
# docs/vr-native-checks.md. Every nested run.sh or check.sh under app/src/test must appear here.
SUITES=(
  native/android/app/src/test/cpp/run.sh
  native/android/app/src/test/cpp/shaders/check.sh
  native/android/app/src/test/cpp/vk/check.sh
)

say() { printf '%s\n' "$*"; }
die() {
  printf 'run-host: %s\n' "$*" >&2
  exit 2
}

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
NATIVE="$ROOT/native"
ANDROID="$NATIVE/android"

sdk=""
require_java=0
build_dir="$ANDROID/build/host-tests"
limit=300
while [ $# -gt 0 ]; do
  case "$1" in
  --android-sdk)
    [ $# -ge 2 ] || die "--android-sdk needs a directory"
    sdk="$2"
    shift 2
    ;;
  --require-java)
    require_java=1
    shift
    ;;
  --suite)
    [ $# -ge 2 ] || die "--suite needs a file"
    SUITES+=("$2")
    shift 2
    ;;
  --build-dir)
    [ $# -ge 2 ] || die "--build-dir needs a directory"
    build_dir="$2"
    shift 2
    ;;
  --timeout)
    [ $# -ge 2 ] || die "--timeout needs a number of seconds"
    limit="$2"
    shift 2
    ;;
  -h | --help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    die "unknown option: $1"
    ;;
  esac
done
case "$limit" in
'' | *[!0-9]* | 0) die "--timeout must be a positive whole number of seconds" ;;
esac
if [ "$require_java" = 1 ] && [ -z "$sdk" ]; then
  die "--require-java was given without --android-sdk, so the Java rules tests cannot run"
fi

cxx="${CXX:-c++}"
command -v "$cxx" >/dev/null 2>&1 || die "C++ compiler '$cxx' was not found; set CXX"
command -v curl >/dev/null 2>&1 || die "curl is required to download the pinned headers"
command -v unzip >/dev/null 2>&1 || die "unzip is required to unpack the OpenXR headers"
if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  die "sha256sum or shasum is required to verify downloads"
fi

java_jar=""
javac_bin=""
java_bin=""
if [ -n "$sdk" ]; then
  [ -d "$sdk" ] || die "--android-sdk directory $sdk does not exist"
  sdk="$(cd "$sdk" && pwd -P)"
  java_jar="$sdk/platforms/$ANDROID_PLATFORM/android.jar"
  [ -f "$java_jar" ] || die "$java_jar is missing; install \"platforms;$ANDROID_PLATFORM\""
  javac_bin="${JAVA_HOME:+$JAVA_HOME/bin/}javac"
  java_bin="${JAVA_HOME:+$JAVA_HOME/bin/}java"
  command -v "$javac_bin" >/dev/null 2>&1 || die "javac was not found; set JAVA_HOME to a JDK 17 or newer"
  command -v "$java_bin" >/dev/null 2>&1 || die "java was not found; set JAVA_HOME to a JDK 17 or newer"
  # macOS ships javac and java stubs that fail when no JDK is installed.
  javac_version="$("$javac_bin" -version 2>&1 | head -n 1)" || die "$javac_bin does not run ($javac_version); set JAVA_HOME to a JDK 17 or newer"
  javac_major="$(printf '%s\n' "$javac_version" | sed -n 's/^javac \([0-9][0-9]*\).*/\1/p')"
  if [ -z "$javac_major" ] || [ "$javac_major" -lt 17 ]; then
    die "the Java rules tests need JDK 17 or newer; $javac_bin reports '$javac_version'"
  fi
fi

mkdir -p "$build_dir"
build_dir="$(cd "$build_dir" && pwd -P)"
cache="$build_dir/cache"
out="$build_dir/out"
# out/ holds only what the previous run of this script produced; cache/ survives between runs.
rm -rf "$out"
mkdir -p "$cache" "$out"
# Every path is absolute from here on; suites run from the repository root.
cd "$ROOT"

# Downloads url into the cache as name unless a copy with the expected hash is already there.
fetch() {
  local name="$1" url="$2" want="$3" file="$cache/$1" got
  if [ -f "$file" ] && [ "$(sha256 "$file")" = "$want" ]; then
    return 0
  fi
  say "fetch  $name"
  rm -f "$file" "$file.part"
  curl --fail --location --silent --show-error --proto '=https' --proto-redir '=https' \
    --retry 3 --retry-delay 2 --connect-timeout 20 --max-time 300 -o "$file.part" "$url" ||
    die "could not download $url"
  got="$(sha256 "$file.part")"
  if [ "$got" != "$want" ]; then
    rm -f "$file.part"
    die "$name has SHA-256 $got, expected $want (from $url)"
  fi
  mv "$file.part" "$file"
}

fetch "json-$JSON_VERSION.hpp" "$JSON_URL" "$JSON_SHA256"
fetch "openxr_loader_for_android-$OPENXR_VERSION.aar" "$OPENXR_URL" "$OPENXR_SHA256"
fetch "stb_image-$STB_COMMIT.h" "$STB_URL" "$STB_SHA256"

deps="$out/deps"
mkdir -p "$deps/json/nlohmann" "$deps/openxr" "$deps/stb"
# Both include spellings the sources use, "json.hpp" and <nlohmann/json.hpp>, as CMakeLists.txt provides.
cp "$cache/json-$JSON_VERSION.hpp" "$deps/json/json.hpp"
cp "$cache/json-$JSON_VERSION.hpp" "$deps/json/nlohmann/json.hpp"
cp "$cache/stb_image-$STB_COMMIT.h" "$deps/stb/stb_image.h"
stb_include="$deps/stb"
unzip -q -o "$cache/openxr_loader_for_android-$OPENXR_VERSION.aar" 'prefab/modules/headers/include/openxr/*' -d "$deps/openxr" ||
  die "the OpenXR $OPENXR_VERSION package has no prefab headers"
json_include="$deps/json"
openxr_include="$deps/openxr/prefab/modules/headers/include"
[ -f "$openxr_include/openxr/openxr.h" ] || die "openxr.h is missing from the OpenXR $OPENXR_VERSION package"

results=()
failed=0
record() {
  results+=("$1  $2")
  [ "$1" = PASS ] || failed=1
}

running=""
stop_running() {
  if [ -n "$running" ]; then
    kill -TERM -- "-$running" 2>/dev/null || true
  fi
}
trap 'stop_running; exit 130' INT
trap 'stop_running; exit 143' TERM

# step LABEL LOG COMMAND...: runs COMMAND with its output in LOG, stopped after $limit seconds.
# Prints one line on success and the end of LOG on failure; returns the command's status.
step() {
  local label="$1" log="$2" marker="$2.timeout"
  shift 2
  local start=$SECONDS status=0 pid watchdog took last
  # Job control gives the command its own process group, so a timeout also stops what it started.
  set -m
  "$@" </dev/null >"$log" 2>&1 &
  pid=$!
  set +m
  running=$pid
  (
    trap 'kill "$nap" 2>/dev/null; exit 0' TERM
    sleep "$limit" &
    nap=$!
    wait "$nap"
    : >"$marker"
    kill -TERM -- "-$pid" 2>/dev/null
    sleep 5
    kill -KILL -- "-$pid" 2>/dev/null
  ) >/dev/null 2>&1 &
  watchdog=$!
  wait "$pid" 2>/dev/null || status=$?
  kill -TERM "$watchdog" 2>/dev/null || true
  wait "$watchdog" 2>/dev/null || true
  kill -KILL -- "-$pid" 2>/dev/null || true
  running=""
  took=$((SECONDS - start))
  if [ -f "$marker" ]; then
    say "FAIL   $label: stopped after ${limit}s"
    status=124
  elif [ "$status" = 0 ]; then
    last="$(tail -n 1 "$log" | cut -c1-200)"
    say "ok     $label (${took}s)${last:+: $last}"
    return 0
  else
    say "FAIL   $label: exit $status after ${took}s"
  fi
  say "------ last 60 lines of ${log#"$ROOT/"}"
  tail -n 60 "$log" | cut -c1-400
  say "------"
  return "$status"
}

# Every file matching a test pattern must be registered, so a new test can't be left out silently.
registered_cpp=" "
for entry in "${CPP_TESTS[@]}"; do
  IFS='|' read -r _ test _ <<<"$entry"
  registered_cpp="$registered_cpp$test "
done
while IFS= read -r found; do
  case "$registered_cpp" in
  *" ${found#"$NATIVE/"} "*) ;;
  *)
    say "FAIL   ${found#"$ROOT/"} is not registered in CPP_TESTS in native/tests/run-host.sh"
    record FAIL "${found#"$ROOT/"} (unregistered)"
    ;;
  esac
done < <(find "$NATIVE/tests" -maxdepth 1 -name '*_test.cpp' -type f | LC_ALL=C sort)

registered_suites=" "
for suite in ${SUITES[@]+"${SUITES[@]}"}; do
  case "$suite" in
  /*) registered_suites="$registered_suites$suite " ;;
  *) registered_suites="$registered_suites$ROOT/$suite " ;;
  esac
done
while IFS= read -r found; do
  case "$registered_suites" in
  *" $found "*) ;;
  *)
    say "FAIL   ${found#"$ROOT/"} is not registered in SUITES in native/tests/run-host.sh"
    record FAIL "${found#"$ROOT/"} (unregistered)"
    ;;
  esac
done < <(
  {
    [ ! -d "$ANDROID/app/src/test" ] || find "$ANDROID/app/src/test" -type f \( -name run.sh -o -name check.sh \)
    find "$NATIVE/tests" -maxdepth 1 -name '*.sh' -type f ! -name run-host.sh
  } | LC_ALL=C sort
)

say "compiler: $("$cxx" --version 2>&1 | head -n 1)"
sanitize=('-fsanitize=address,undefined' -fno-sanitize-recover=all -fno-omit-frame-pointer)
# The tests check with assert(), so NDEBUG must never be defined for them.
cxxflags=(-std=c++17 -g -O1 -UNDEBUG -Wall -Wextra -Werror=return-type "${sanitize[@]}")
export ASAN_OPTIONS="${ASAN_OPTIONS:-detect_stack_use_after_return=1}"
export UBSAN_OPTIONS="${UBSAN_OPTIONS:-print_stacktrace=1:halt_on_error=1}"

for entry in "${CPP_TESTS[@]}"; do
  IFS='|' read -r name test sources flags <<<"$entry"
  label="c++ $name"
  files=("$NATIVE/$test")
  for source in $sources; do files+=("$NATIVE/$source"); done
  missing=""
  for file in "${files[@]}"; do [ -f "$file" ] || missing="$missing ${file#"$ROOT/"}"; done
  if [ -n "$missing" ]; then
    say "FAIL   $label: registered files are missing:$missing"
    record FAIL "$label (missing files)"
    continue
  fi
  binary="$out/$name-test"
  extra=()
  if [ -n "$flags" ]; then read -r -a extra <<<"$flags"; fi
  if ! step "$label compile" "$out/$name-compile.log" "$cxx" "${cxxflags[@]}" ${extra[@]+"${extra[@]}"} \
    -I "$ANDROID/app/src/main/cpp" -I "$json_include" -I "$openxr_include" "${files[@]}" -o "$binary"; then
    record FAIL "$label (compile)"
    continue
  fi
  if step "$label run" "$out/$name-run.log" "$binary"; then
    record PASS "$label"
  else
    record FAIL "$label (run)"
  fi
done

if [ -n "$sdk" ]; then
  say "java: $("$java_bin" -version 2>&1 | head -n 1)"
  package_dir="${JAVA_PACKAGE//.//}"
  registered_java=" "
  for entry in "${JAVA_TESTS[@]}"; do
    IFS='|' read -r class _ <<<"$entry"
    registered_java="$registered_java$class "
  done
  for dir in "${JAVA_TEST_DIRS[@]}"; do
    [ -d "$ANDROID/$dir" ] || continue
    while IFS= read -r found; do
      class="$(basename "$found" .java)"
      case "$found:$registered_java" in
      "$ANDROID/$dir/$package_dir/$class.java:"*" $class "*) ;;
      *)
        say "FAIL   ${found#"$ROOT/"} is not registered in JAVA_TESTS in native/tests/run-host.sh"
        record FAIL "${found#"$ROOT/"} (unregistered)"
        ;;
      esac
    done < <(find "$ANDROID/$dir" -name '*Test.java' -type f | LC_ALL=C sort)
  done

  for entry in "${JAVA_TESTS[@]}"; do
    IFS='|' read -r class production <<<"$entry"
    label="java $class"
    source="$ANDROID/app/src/main/java/$package_dir/$production.java"
    tests=()
    for dir in "${JAVA_TEST_DIRS[@]}"; do
      if [ -f "$ANDROID/$dir/$package_dir/$class.java" ]; then
        tests+=("$ANDROID/$dir/$package_dir/$class.java")
      fi
    done
    if [ "${#tests[@]}" != 1 ]; then
      say "FAIL   $label: expected $package_dir/$class.java in exactly one of ${JAVA_TEST_DIRS[*]} under native/android, found ${#tests[@]}"
      record FAIL "$label (test source)"
      continue
    fi
    if [ ! -f "$source" ]; then
      say "FAIL   $label: ${source#"$ROOT/"} is missing"
      record FAIL "$label (production source)"
      continue
    fi
    classes="$out/java/$class"
    mkdir -p "$classes"
    if ! step "$label compile" "$out/$class-compile.log" "$javac_bin" --release 17 -encoding UTF-8 -Xlint:all \
      -cp "$java_jar" -d "$classes" "$source" "${tests[0]}"; then
      record FAIL "$label (compile)"
      continue
    fi
    # android.jar stays off the runtime classpath, so any Android call from the rules fails the test.
    if step "$label run" "$out/$class-run.log" "$java_bin" -ea -cp "$classes" "$JAVA_PACKAGE.$class"; then
      record PASS "$label"
    else
      record FAIL "$label (run)"
    fi
  done
else
  results+=("NOT RUN  java rules tests: pass --android-sdk DIR to run them")
fi

for suite in ${SUITES[@]+"${SUITES[@]}"}; do
  case "$suite" in
  /*) path="$suite" ;;
  *) path="$ROOT/$suite" ;;
  esac
  label="suite ${path#"$ROOT/"}"
  if [ ! -f "$path" ]; then
    say "FAIL   $label: the file does not exist"
    record FAIL "$label (missing)"
    continue
  fi
  suite_out="$out/suites/$(printf '%s' "${path#"$ROOT/"}" | tr '/' '_')"
  mkdir -p "$suite_out"
  if step "$label" "$suite_out.log" env CXX="$cxx" OFFICE_XR_CXXFLAGS="${cxxflags[*]}" \
    OFFICE_XR_JSON_INCLUDE="$json_include" OFFICE_XR_OPENXR_INCLUDE="$openxr_include" \
    OFFICE_XR_STB_INCLUDE="$stb_include" OFFICE_XR_SOURCE="$ANDROID/app/src/main/cpp" \
    OFFICE_XR_TEST_OUT="$suite_out" bash "$path"; then
    record PASS "$label"
  else
    record FAIL "$label"
  fi
done

say ""
say "Summary:"
for line in "${results[@]}"; do say "  $line"; done
if [ "$failed" != 0 ]; then
  say "native host checks FAILED (logs in ${out#"$ROOT/"})"
  exit 1
fi
say "native host checks passed"
