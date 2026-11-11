---
name: performance-proof
description: Prove before/after Droid Office rendering changes (CPU/GPU frame time, pacing, memory, thermals) across independent repeated trials under locked clone workload, quality, resolution and verified drawn/presented FPS.
---

# Performance Proof Lab

Aggregates and validates repeated frame-producing trials across two Droid Office builds on an isolated [`office-clone`](../office-clone/SKILL.md), leaving system power/fan controls, background apps, and the owner's active office untouched (non-rendering batch jobs are out of scope). Read [`references/contract.md`](references/contract.md) before authoring a manifest, trial record or adapter input.

## Workflow

1. **Lock the workload on [`office-clone`](../office-clone/SKILL.md):** build both revisions and write `manifest.json` fixing `device`, `profile`, `settings_sha256`, `resolution`, `quality`, `scenario`, `runtime`, `target_fps`, `power_mode` and `background_conditions` across every trial.
2. **Predeclare metrics and thresholds:** set each metric's `direction` (`lower`/`higher`), `unit`, `practical_change`, `min_trial_seconds`, `min_coverage` (`>=0.9`), and `min_trials` (`>=2` independent runs per build), plus known scope limits.
3. **Collect trials with existing harnesses:** run [`office-thermals`](../office-thermals/SKILL.md) (`tools/frame-bench/thermal.mjs`) in chronological ABBA blocks for thermals, or repeated `tools/frame-bench/` runs for frame/memory metrics, keeping builds, tests and recordings off the machine during capture windows.
4. **Verify FPS and parity per trial:** retain raw artifacts and a matched parity capture; require measured `drawn_fps` (plus native `presented_fps` on `electron`, `native` and `android`—`fps_source: requested-cap` is rejected) and functional/visual parity.
5. **Ingest one aggregate per independent trial** (never per 1-second sample), recording unknown metrics as `null` rather than `0`, and keeping failed or calibration runs in the ledger with a nonempty `excluded_reason`.
6. **Compare and state limits:** run `compare` (mismatched controls, missing coverage, failed parity, overlapping windows or broken thermal ABBA order yield `invalid`; gains within between-trial variation yield `inconclusive`). Report only what the counters measure (excluding panel scan-out, physical input-to-photon latency, battery life, hottest-core/chassis temperature, and app-isolated power).

Done when `compare` has evaluated all ingested trials and emitted its verdict (`improved`, `regressed`, `inconclusive` or `invalid`) with exclusions, artifact hashes and measurement limits.

## CLI (`Python 3.11+` stdlib only)

Pass explicit absolute paths whose parent directories already exist:

```sh
S="$PWD/.agents/skills/performance-proof/scripts/performance.py"
python3 "$S" init --root /isolated/perf --state /isolated/perf/state.json --manifest /isolated/perf/manifest.json
python3 "$S" ingest --root /isolated/perf --state /isolated/perf/state.json --trial /isolated/perf/A1.json
python3 "$S" compare --root /isolated/perf --state /isolated/perf/state.json --format markdown
```

Exit codes: `0` accepted (`init`/`ingest`) or `improved` (`compare`), `2` invalid input, `3` `invalid` or `regressed`, `4` lock contention, `5` `inconclusive`.

## References and contract tests

- **Schema, examples & adapters:** [`references/contract.md`](references/contract.md), [`references/schema.json`](references/schema.json), [`references/examples.json`](references/examples.json), and read-only collectors in [`scripts/adapters.py`](scripts/adapters.py).
- **Synthetic contract suite** (verifies schema/ledger rules only, not app performance):
  `uv run --no-project --python 3.12 -m unittest discover -s "$PWD/.agents/skills/performance-proof/tests" -v`
