# frame-bench

Measures how the Mac app paces frames and how long a mouse move takes to reach the display. It runs a **packaged** app (or any Electron build of this repository) on its own `--user-data-dir`, against a clone of the owner's office, and drives it through the DevTools port. It never touches the installed app, the owner's `userData` or the office on :4600.

## Setup

```bash
npm run build && npx electron-builder --mac --arm64 --dir --publish never   # release/mac-arm64/Droid Office.app, signed when the keychain has the Developer ID
.agents/skills/office-clone/scripts/clone-office.sh                          # prints /tmp/office-clone-XXXX
/tmp/office-clone-XXXX/start.sh                                              # fireAndForget; the app attaches to it (port 4677)
swiftc -O tools/frame-bench/display-trace/display-trace.swift -o /tmp/display-trace
```

The display recorder needs Screen Recording permission for the process that starts it (`CGPreflightScreenCaptureAccess`).

## Pacing: `bench.mjs`

```bash
node tools/frame-bench/bench.mjs --app "release/mac-arm64/Droid Office.app" --clone /tmp/office-clone-XXXX --out /tmp/bench \
  --configs remastered-sdr,remastered-hdr,classic --caps 120,60,40 --scenarios idle,turn,walk,terminal,load \
  --seconds 12 --repeat 3 --label baseline --display-trace /tmp/display-trace
node tools/frame-bench/bench.mjs --table /tmp/bench/results.jsonl
```

`--ordered` keeps the configurations in the order given instead of shuffling them (to test what a switch from one to another costs, such as the light bake cache). Every launch starts from an empty `userData`, so state that must survive a switch has to survive within one run.

Every configuration is laid over the owner's saved settings (`local-storage.json` in the clone). The office only honors Remastered on/off and HDR from that blob; the page is reloaded with `?pace=full`, so the loop never idles during a still measurement. Per configuration the page is reloaded and its shader and light warm-up finishes before anything is measured. Scenarios:

| Scenario | What it does |
| --- | --- |
| `idle` | Stand at the jukebox looking ahead |
| `turn` | Turn at 2 rad/s, reversing every second, with mouse deltas every 8 ms on a captured mouse |
| `walk` | Jukebox to elevator and back along the office paths |
| `terminal` | A plain shell's terminal open over the office with output scrolling (a shell is opened at desk 1 of the clone) |
| `load` | Reload with the light bake cached, then with it cleared (a full bake), from animation-frame timing since navigation |

Each row has the page's `office.frameStats()` (p50/p95/p99 frame time, missed and repeated, CPU and GPU per pass). With `--display-trace` the display's own changed frames in the same window are added: the gaps between them and how many came late against the cap. On a build whose `window.office` has `presenterStats` (the native presenter), each row also carries its report as `presenter`, reset and read over the same window. A scenario that errors or exceeds its time limit becomes a `failed` row and the matrix goes on.

## The whole matrix on one build: `matrix.sh`

```bash
tools/frame-bench/matrix.sh "release/mac-arm64/Droid Office.app" /tmp/office-clone-XXXX /tmp/matrix-baseline baseline full /tmp/display-trace
```

Runs everything unattended (about 40 minutes of display time; `quick` is about 8): 120 FPS with 3 rounds, input latency, 60 and 40 FPS, and the light bake load. Run it on each build and compare the tables. Each row also has `--resources`: the app's CPU (cumulative CPU time over the scenario, as a share of one core, by process role), memory, and the system's GPU utilization from IOKit (no per-process GPU without sudo), so a quiet machine matters. A build with the native presenter adds its own report to the same rows. Every step has a time limit and `DEADLINE_MIN` stops new steps, so a stuck step does not stall the rest. Every launch starts from an empty profile, so each configuration runs on its own to make its light bake once.

## Before/after temperatures: `thermal.mjs`

Build both revisions in separate worktrees first, including their native presenter. Make a real-office clone but **do not start its server**: this command owns the server, browser/app and sensor process for each trial. Supply an existing macmon executable from a verified release (tested with 0.10.0); the harness does not download or globally install it.

```bash
node tools/frame-bench/thermal.mjs --clone /tmp/office-clone-XXXX \
  --before /absolute/path/to/baseline --after /absolute/path/to/candidate \
  --macmon /absolute/path/to/macmon --out /tmp/thermal-120 --fps 120
node tools/frame-bench/thermal.mjs --compare /tmp/thermal-120
node tools/frame-bench/thermal-report.mjs /tmp/thermal-120
```

Default protocol: native Electron, Remastered SDR, Desk 1, clear weather, ABBA order (before, after, after, before). Each trial pauses rendering until a fresh 30-sample CPU/GPU window is below 34/33°C and its two halves differ by less than 0.3°C, with at least 90 seconds of cooling and a 900-second limit. It then warms the full-rate workload for 180 seconds and measures 120 seconds. `--help` lists overrides. These cool-start limits are presets, not universal operating temperatures: if unsuitable for the machine/room, select one protocol for both builds and start a new whole series.

Native trials run each checkout on Electron with a fresh isolated profile, through the clone's `office-run.mjs --source BUILD` mode. They validate **actual drawn FPS**, frame-count/window coverage and **native presented FPS**, not just the saved cap. Native output is the app's real display size; `--size` only affects headless mode. `--backend headless --fps 60` retains the headless protocol. Headless 120 FPS is rejected. Merely removing Chromium's limiter measured only about 45 FPS on the M5 Pro and is not a substitute for native 120 FPS.

Frame pacing is read/reset in ten-second chunks, because the app keeps only 7,200 frame samples (about one minute at 120 FPS). The harness validates every chunk and the full summed window. Chunk quantiles stay separate; it does not pretend their averages are whole-window percentiles.

Each trial has its build ID, `protocol.json`, `sensors.jsonl`, `result.json`, and server/app logs. A failed trial keeps its logs but gets no result; existing trial folders are never overwritten. `--compare` checks all four valid results and writes `summary.json`, giving equal weight to independent trial means. `thermal-report.mjs` adds a standalone `report.html` and `temperature-traces.svg`, suitable for the Whiteboard. Keep these machine-specific files, profiles and downloaded binaries outside git.

Do not run builds, test suites, another benchmark or a screen recorder during measurements. Leave the owner's background processes alone. Record room conditions if possible. Inspect start temperatures, repeat variation, temperature drift, fans, FPS and native-presenter counters. One-second samples are correlated, not hundreds of independent trials; five-minute runs are not automatically thermal equilibrium. CPU/GPU readings are sensor averages, not the hottest core, chassis or ambient. Missing fan/power readings mean unknown, not zero. GPU counters are system-wide estimates, not app-specific or wall power; this is not a battery-life or panel scan-out test.

The command stops its server/app/sensor and only new clone PTY hosts. Check cleanup after a crash or cancellation. The agent playbook is [office-thermals](../../.agents/skills/office-thermals/SKILL.md).

## Latency: `latency.mjs`

Each trial sends a mouse move through DevTools at a recorded `process.hrtime`; `display-trace` reports when the display's picture first changed after it (ScreenCaptureKit's `displayTime`). Latency is the difference. It includes DevTools delivery, input routing, the office's handler, the next frame, Chromium's compositing and the window server's composition. It excludes the operating system's dispatch of a real mouse event, the mouse sensor, and the panel's scan-out and pixel response (a high-speed camera measures those).

## Controls: `control.mjs`, `native-control.mjs`

The display-side numbers have a floor that no page or app can beat: the capture tool coalesces or drops some frames, and the window server and Chromium add their own. Two controls record it the same way as an office run.

```bash
node tools/frame-bench/control.mjs --app "release/mac-arm64/Droid Office.app" --clone /tmp/office-clone-XXXX --out /tmp/bench --display-trace /tmp/display-trace
swiftc -O tools/frame-bench/display-trace/native-control.swift -o /tmp/native-control
node tools/frame-bench/native-control.mjs --native-control /tmp/native-control --display-trace /tmp/display-trace --out /tmp/bench
```

`control.mjs` is a page that moves a bar once per animation frame, in the app's own window. `native-control.mjs` is a full-screen Metal window driven by the display link, with no browser. If the native control also shows late frames, they belong to the capture tool or the window server, not to Chromium. Rows go to `control.jsonl`.

## Notes

- Take the display lock when other agents share the machine, and record background load with the results (`machine.json`, `load` per row).
- `display-trace` writes every time in `CLOCK_MONOTONIC_RAW` nanoseconds (what `process.hrtime` reports on macOS; `CLOCK_MONOTONIC` is slewed and sits seconds behind it); ScreenCaptureKit's own clock is `mach_absolute_time`, which stops while the Mac sleeps.
- The page's `performance.now()` is aligned to `hrtime` before and after each run from the shortest DevTools round trip; the drift is stored in the row.
- The harness ends the app with SIGKILL by PID, never SIGTERM or `pkill` by name: on unload the packaged app asks "Leave the office?", and a terminated app stays frozen behind that dialog on the screen. `kill-own.sh list|kill [dir]` lists or force-kills the Droid Office processes whose executable is under `dir` (default `/tmp/droid-office-measure`), and `matrix.sh` runs it after every step.
- Every app launch uses a new profile folder. The launcher refuses nonempty profiles rather than recursively deleting them, follows symlinks when protecting the owner's profile/installed app, and closes its own app on startup failure or cancellation.
