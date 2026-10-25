---
name: performance-proof
description: Compare Droid Office rendering optimizations under the same real-office workload without reducing quality, resolution or actual frame rate. Use for Office before/after CPU/GPU time, memory, frame pacing or thermal comparisons. Reuses office-clone and office-thermals, aggregates independent repeated trials and labels noisy or incomplete results honestly.
---

# Performance Proof Lab

This is a Droid Office project skill, not a globally installed benchmark tool.
Use the repository's existing clone and collectors; do not drive the owner's
active office. The generic import adapter supports already captured frame data,
not arbitrary headless-service or batch-job benchmarks.

Measure a controlled workload, not a faster-looking screenshot or requested FPS
cap. This package compares evidence; it does not install sensors, change fan/power
settings, stop background apps, launch the owner's active app or authorize costs.

## Workflow

1. Load `office-clone` and use its existing real-office isolation adapter.
   Identify both built revisions and record a workload/control manifest: device,
   profile, settings hash, output resolution, quality, scenario, runtime, target FPS,
   power mode and background conditions. Keep them unchanged.
2. Choose metrics and their `lower`/`higher` direction, units, practical change,
   minimum trial duration/coverage and at least two independent trials per build
   (prefer more). Record measurement scope and known unknowns.
3. Use existing collectors. **Office thermal work must reuse `office-thermals` and
   `tools/frame-bench/thermal.mjs`, not a new harness.** Require chronological ABBA
   blocks for thermal work. Other performance checks need repeated trials but not
   mandatory ABBA. Do not run builds/tests/recordings during measurements.
4. Preserve raw artifacts for each independent trial. Verify actual drawn FPS and,
   for native/Electron/Android targets, actual presented FPS with adequate coverage.
   A requested cap is never evidence. Verify functional and visual parity.
5. Import one aggregate per independent trial, not one trial per one-second sensor
   reading. Missing metrics are `null` (unknown), not zero. Retain exclusions and
   reasons; failed/calibration trials must not quietly disappear.
6. Compare and report JSON or Markdown. Changed controls, missing coverage, failed
   parity, overlapping windows or broken thermal order invalidate comparison.
   Small gains within between-trial variation are **inconclusive**.
7. Report only measured behavior. Frame/native counters do not prove panel
   scan-out, physical input-to-photon latency or battery life. Sensor averages and
   system power estimates are not hottest-core, chassis or app-only measurements.

## Run

Python 3.11+ stdlib only, no dependencies or installs:

```sh
uv run --no-project --python 3.12 /absolute/skill/scripts/performance.py --help
python3 /absolute/skill/scripts/performance.py init --root /isolated/perf --state /isolated/perf/state.json --manifest /isolated/perf/manifest.json
python3 /absolute/skill/scripts/performance.py ingest --root /isolated/perf --state /isolated/perf/state.json --trial /isolated/perf/A1.json
# Ingest all independent trials, preserving the chronological timestamps.
python3 /absolute/skill/scripts/performance.py compare --root /isolated/perf --state /isolated/perf/state.json
python3 /absolute/skill/scripts/performance.py compare --root /isolated/perf --state /isolated/perf/state.json --format markdown
```

All data paths are explicit and absolute. Roots/parents must already exist.
Machine-readable outputs are JSON; Markdown and `--help` are explicit exceptions.
Exit codes: 0 accepted/improved, 2 invalid input, 3 invalid/regressed proof,
4 locked, 5 inconclusive. A success exit from `init`/`ingest` is not a performance gain.

## Contracts and reuse

- [CLI implementation](scripts/performance.py) and
  [stdlib contract/atomic-write support](scripts/proof_common.py).
- [Read-only adapters](scripts/adapters.py): actual Office thermal result files and
  generic application JSONL frame/metric counters; no launches or installs.
- [Contract, statistics and adapter details](references/contract.md).
- [Versioned JSON schema](references/schema.json) and
  [sanitized manifest/trial examples](references/examples.json).
- [Contract tests](tests/test_performance.py) and
  [realistic sanitized evaluation cases](evals/cases.json).

```sh
uv run --no-project --python 3.12 -m unittest discover -s /absolute/skill/tests -v
```

Tests use fake data solely for contracts. They are not real-app performance proof.
