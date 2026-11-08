---
name: performance-proof
description: Compare Droid Office rendering optimizations under the same real-office workload, at unchanged quality, resolution and actual frame rate. Use for before/after CPU or GPU time, memory, frame pacing or thermal comparisons of Office builds; it aggregates independent repeated trials and labels noisy or incomplete results honestly.
---

# Performance Proof Lab

A Droid Office project skill that compares evidence from a controlled workload: the same scenario, settings and actual frame rate on both builds. It reuses the repository's clone and collectors and runs against a clone, never the owner's active office. Its generic import adapter takes frame data an existing collector already captured; headless services and batch jobs are outside its contract. It installs no sensors, changes no fan or power settings, stops no background apps, launches no app of the owner's and authorizes no costs.

## Workflow

1. **Set up on [`office-clone`](../office-clone/SKILL.md).** Identify both built revisions and write a workload/control manifest: device, profile, settings hash, output resolution, quality, scenario, runtime, target FPS, power mode and background conditions. These stay fixed for every trial.
2. **Declare the metrics before measuring:** each one's `lower`/`higher` direction, unit and practical change, the minimum trial duration and coverage, and at least two independent trials per build (more is better). Record the measurement scope and known unknowns.
3. **Collect with the existing tools.** Office thermal work reuses [`office-thermals`](../office-thermals/SKILL.md) and `tools/frame-bench/thermal.mjs`, in chronological ABBA blocks; other checks need repeated trials, ABBA optional. Keep builds, tests and recordings off the machine during measurements.
4. **Keep raw artifacts for every trial**, and verify actual drawn FPS with adequate coverage, plus actual presented FPS for native, Electron and Android targets. A requested cap is never evidence. Verify functional and visual parity.
5. **Import one aggregate per independent trial**, never one per one-second sensor reading. A missing metric is `null` (unknown), not zero. Failed and calibration trials stay in the ledger with their exclusion reasons.
6. **Compare and report** as JSON or Markdown. Changed controls, missing coverage, failed parity, overlapping windows or a broken thermal order make the comparison invalid, and a gain within between-trial variation is **inconclusive**.
7. **Report only measured behavior.** Frame and native counters say nothing about panel scan-out, physical input-to-photon latency or battery life; sensor averages and system power estimates are not hottest-core, chassis or app-only measurements.

The proof is done when `compare` has run on every included trial and the report names its verdict (improved, regressed, inconclusive or invalid), its exclusions and its limits.

## Run

Python 3.11+ standard library only, nothing to install:

```sh
uv run --no-project --python 3.12 /absolute/skill/scripts/performance.py --help
python3 /absolute/skill/scripts/performance.py init --root /isolated/perf --state /isolated/perf/state.json --manifest /isolated/perf/manifest.json
python3 /absolute/skill/scripts/performance.py ingest --root /isolated/perf --state /isolated/perf/state.json --trial /isolated/perf/A1.json
# Ingest all independent trials, preserving the chronological timestamps.
python3 /absolute/skill/scripts/performance.py compare --root /isolated/perf --state /isolated/perf/state.json
python3 /absolute/skill/scripts/performance.py compare --root /isolated/perf --state /isolated/perf/state.json --format markdown
```

Every data path is explicit and absolute, and roots and parents must already exist. Output is JSON except Markdown reports and `--help`. Exit codes: 0 accepted or improved, 2 invalid input, 3 invalid or regressed proof, 4 locked, 5 inconclusive. A success exit from `init` or `ingest` means the record was accepted, not that performance improved.

## Contracts and reuse

- [CLI implementation](scripts/performance.py) and [standard-library contract and atomic-write support](scripts/proof_common.py).
- [Read-only adapters](scripts/adapters.py): actual Office thermal result files and generic application JSONL frame and metric counters; they launch and install nothing.
- [Contract, statistics and adapter details](references/contract.md): read it before writing a manifest, a trial template or an adapter input.
- [Versioned JSON schema](references/schema.json) and [sanitized manifest and trial examples](references/examples.json).
- [Contract tests](tests/test_performance.py) and [realistic sanitized evaluation cases](evals/cases.json).

```sh
uv run --no-project --python 3.12 -m unittest discover -s /absolute/skill/tests -v
```

The tests use fake data to check the contracts only; they are no proof of real-app performance.
