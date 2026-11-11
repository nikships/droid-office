---
name: office-thermals
description: Measure before/after macOS CPU/GPU sensor temperatures across two Droid Office builds using counterbalanced ABBA trials on an isolated clone in native Electron at verified 120 FPS.
---

# Office thermal measurements

Read [`tools/frame-bench/README.md`](../../../tools/frame-bench/README.md) and [`office-clone`](../office-clone/SKILL.md) first. Every trial launches its own clone server and isolated Electron app, leaving the owner's running app, profile and `:4600` untouched.

1. **Build both revisions** in separate worktrees with identical controls: app settings, floor, weather, camera, output size, resolution, MSAA, GI, power mode and fan control.
2. **Prepare inputs:** create a real [`office-clone`](../office-clone/SKILL.md) and pass an existing local `macmon` binary (never install globally, download unverified binaries or use `sudo`).
3. **Run ABBA trials:** inspect `node tools/frame-bench/thermal.mjs --help`, then pass `--clone`, `--before`, `--after`, `--macmon` and a fresh `--out` (default: four native 120 FPS ABBA trials, each with paused cooldown, 3-minute load warmup and 2-minute measurement). Headless Chromium caps near 60 Hz, so 120 FPS requires native Electron with verified drawn FPS, window coverage and native `presenterStats` FPS.
4. **Keep sensor windows quiet:** defer builds, test suites, other benchmarks and screen recordings until the series finishes, while leaving the owner's existing background processes as-is. Record AC/battery state, power mode, thermal warnings, ambient conditions (if known) and background load.
5. **Audit every trial (`result.json`, `sensors.jsonl`, `summary.json`):** check starting temperatures, per-trial means/ranges, first-to-last drift, fan speed and frame pacing. Treat missing fan or power fields as unknown (`null`), never zero. Preserve failed or calibration runs with explicit exclusion reasons, and write any corrected full series to a new `--out` directory.
6. **Interpret and report:** treat trials (never 1-second samples) as the unit of replication; ABBA cancels linear drift only, 5 minutes does not guarantee thermal equilibrium, and differences within repeat variation are **inconclusive**. State sensor scope limits (CPU/GPU sensor averages rather than hottest core, chassis or ambient; system-wide power estimates rather than app-only or wall power; presenter counters rather than panel scan-out or battery life).
7. **Clean up:** verify after completion, cancellation or crash that the harness's server, Electron app and clone PTY hosts are stopped; publish the summary to the existing Whiteboard card, and keep clone data, profiles, binaries and raw sensor logs uncommitted.

Done when every trial in complete ABBA blocks (four by default) passes drawn and native-presented 120 FPS checks, every excluded run carries its reason, and the Whiteboard report states the verdict (`cooler`, `warmer` or `inconclusive`) alongside its measurement limits.
