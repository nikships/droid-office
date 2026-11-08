---
name: office-thermals
description: Compare CPU/GPU sensor temperatures of two Droid Office builds on macOS with counterbalanced ABBA trials, on a clone of the owner's office in native Electron at verified 120 FPS. Use when a rendering change needs before/after thermal evidence.
---

# Office thermal measurements

Read `tools/frame-bench/README.md` and the [`office-clone`](../office-clone/SKILL.md) skill first. Every trial runs on a clone with its own server and app; the owner's running app, profile and :4600 stay out of it.

1. **Build both revisions** in separate worktrees. Hold everything else fixed: app settings, floor, weather, camera and output size, and resolution, MSAA, GI, power mode and fan control.
2. **Use a real clone and an existing, verified `macmon` executable.** The harness downloads nothing; bring the binary you already have, without global installs, unverified downloads or sudo.
3. **Run `node tools/frame-bench/thermal.mjs --help`**, then supply `--clone`, `--before`, `--after`, `--macmon` and a fresh `--out`. The default is four ABBA trials at native 120 FPS, each with a paused cooldown, a three-minute load warmup and a two-minute measurement.
4. **Measure 120 FPS on the native Electron backend.** The tool checks actual drawn FPS, frame-window coverage and native presented FPS, because a cap alone is no evidence of the workload. Headless Chromium usually runs at 60 Hz, and an unthrottled-headless experiment reached only 45 FPS on the M5 Pro and was rejected.
5. **Keep the machine quiet during sensor windows:** no builds, test suites, other benchmarks or screen recordings, and background apps left as they are (the owner's processes keep running). Record AC or battery, power mode, thermal warnings, room conditions if available, and background load.
6. **Inspect every `result.json`, raw `sensors.jsonl` and `summary.json`:** starting temperatures, per-trial means and ranges, first-to-last drift, fan readings and pacing. Missing fan or power data is unknown, not zero.
7. **Read trials as the independent replications**, not the one-second sensor readings. ABBA cancels linear time drift but not room or background variation, and five minutes is not automatically thermal equilibrium. A difference smaller than the repeat variation is inconclusive.
8. **State what the numbers are.** CPU/GPU readings are sensor averages, not the hottest core, the chassis or ambient. Power counters are system-wide estimates, not app-specific or wall power. Frame and presenter counters say nothing about panel scan-out or battery life.
9. **Keep failed and calibration runs** with the reason each was excluded. A corrected full series goes in a new output folder, so every failed trial stays visible.
10. **Finish clean.** The tool closes the app and server it started and stops only the clone PTY hosts it created; after a cancellation or crash, check that yourself. Keep raw data local, publish the report on the existing Whiteboard card, and keep clone data, profiles, downloaded binaries and machine-specific logs out of git.

The comparison is done when every trial of the complete ABBA blocks (four by default) has passed the FPS checks, every exclusion has a reason, and the report states the result (cooler, warmer or inconclusive) with its limits.
