---
name: office-thermals
description: Compare CPU/GPU sensor temperatures before and after a rendering change on macOS, using the real-office clone, native Electron at verified 120 FPS, and counterbalanced thermal trials.
---

# Office thermal measurements

Read `tools/frame-bench/README.md` and load `office-clone` before starting. Never use the owner's running app, profile or :4600.

1. Build both revisions in separate worktrees. Keep the same app settings, floor, weather, camera and output size. Do not change resolution, MSAA, GI, power mode or fan control to make the candidate look better.
2. Use a real clone and an existing, verified `macmon` executable. Do not install global tools, download an unverified binary or ask for sudo unnecessarily. The harness never downloads tools.
3. Run `node tools/frame-bench/thermal.mjs --help`. Supply `--clone`, `--before`, `--after`, `--macmon` and a fresh `--out`. The default is four ABBA trials at native 120 FPS, each with a paused cooldown, three-minute load warmup and two-minute measurement.
4. For 120 FPS use the native Electron backend. Setting a cap is not evidence of the workload: the tool checks actual drawn FPS, frame-window coverage and native presented FPS. Headless Chromium's usual 60 Hz is not 120 Hz. An unthrottled-headless experiment measured only 45 FPS on the M5 Pro and was rejected.
5. Let the machine run without builds, test suites, other benchmarks or screen recordings during the sensor windows. Keep background apps unchanged. Record AC/battery, power mode, thermal warnings, room conditions if available, and background load. Do not stop the owner's processes.
6. Inspect every `result.json`, raw `sensors.jsonl` and `summary.json`. Check starting temperatures, per-trial means/ranges, first/last temperature drift, fan readings and pacing. Missing fan/power data means unknown, not zero.
7. Treat trials as independent replications, not the one-second sensor readings. ABBA reduces linear time drift but does not remove uncontrolled room/background variation. Five minutes is not automatically thermal equilibrium. A small average difference below repeat variation is inconclusive, not proof of cooler operation.
8. CPU/GPU readings are sensor averages, not the hottest core, chassis or ambient. Power counters are system-wide estimates, not app-specific or wall power. Frame and native-presenter counters do not measure panel scan-out or battery life.
9. Keep failed/calibration runs and state why they were excluded. Use a new output folder for a corrected full series; do not quietly replace a failed trial under changed conditions.
10. The tool closes the app and server it started and only stops new clone PTY hosts. Check cleanup after a cancellation or crash. Retain raw data locally, publish the report on the existing Whiteboard card, and never commit private clone data, profiles, downloaded binaries or machine-specific logs.
