# V1 contracts, adapters and honest interpretation

The linked Draft 2020-12 `schema.json` describes manifests, trial records and
mutable ledger state. The stdlib validator implements exactly the small keyword
subset used there. Unknown fixed fields and versions fail. All metric values must
be finite numbers or `null`; `NaN` and infinity are rejected.

## Workload manifest

Required top-level fields:

- `schema_version: 1`, unique `run_id`, `workload`, different `builds.before` /
  `.after`, `metrics`, `primary_metric`, `min_trials` (>=2),
  `min_trial_seconds` (>=1), `min_coverage` (0.9–1),
  `fps_tolerance` (0–0.05), `thermal` boolean.
- Workload fields: nonsecret `device` / `profile` labels, `settings_sha256`,
  exact two-element pixel `resolution`, nonempty `quality` object,
  `target_fps`, nonempty `background_conditions`, `runtime`
  (`electron`, `browser`, `native`, `android`), `scenario`, `power_mode`.
- `metrics` maps names to `{direction: lower|higher, unit, practical_change,
  nonnegative}`. `primary_metric` must be in that map. Controls and acceptance
  thresholds are chosen before trials; do not tune them after seeing results.

Every trial must reproduce the whole workload object exactly. Build IDs differ
between variants but must match their respective manifest IDs. This catches
declared resolution/quality/FPS/profile changes, not dishonest labels. Capture
runtime provenance, actual graphics configuration and settings artifacts using
the real-state tool. Background load/power/ambient comparability remains manual.
Compare workload choices and minimum durations before taking measurements.

This V1 is for frame-producing workloads. It intentionally requires drawn FPS even
when the chosen metric is memory or CPU time. It is not yet a headless service or
non-rendering batch benchmark contract; do not fabricate frame counters for one.

## One trial, one independent run

A trial has version, `id`, `variant`, `build`, `workload`, `started_at` / `ended_at`
(epoch seconds), `independent: true`, `functional_parity`, `visual_parity`,
`coverage`, actual `drawn_fps`, `presented_fps`, `fps_source`, `metrics`,
`raw_artifacts`, `parity_artifact`, `excluded_reason`.

- Values in `metrics` are **per-trial aggregates**, in the declared units. Every
  metric must exist; unknown values use `null`.
- Actual rates must be within the predeclared tolerance of the target; native,
  Electron and Android need a non-null presented counter too. Browser-only drawn
  proof may leave presented FPS unknown. `fps_source: requested-cap` is rejected.
- FPS source enums describe counters, not physical display scan-out.
  Native presented FPS should come from a native/platform presenter, not a
  relabeled JavaScript callback.
- Parity must be true and supported by an existing file. The CLI hashes the file,
  but does not visually interpret it. Include actual functional assertions and
  matched-quality captures from the same workload.
- Raw artifacts must exist. Reused raw paths and trial IDs are rejected. Trial
  input JSON and parity artifact are also hashed. Once imported, keep originals
  unchanged; compare rehashes them. This preserves source attribution and exclusions.
- An excluded trial needs a nonempty `excluded_reason`; its raw files remain
  required. Excluded records can retain failed coverage/parity/FPS but must still
  match declared controls/builds. Retain experiments under *different* controls in
  a separate run/manifest and link their report manually; do not erase them.

Imported reports verify file hashes, not the truth of user-authored aggregates.
Operator/adapter attestation is necessary for independence, runtime identity,
functional and visual parity, non-overlapping preparation/warmup, comparable load,
calibration and absence of confounds. A one-second sample is not an independent
trial. Overlapping included measurement intervals invalidate the report.
For thermal runs, chronological included trial variants must form complete ABBA
blocks. If exclusions break the order, preserve the old run and collect a new
complete series.

## Aggregation and decisions

Each metric uses the mean and sample standard deviation of independent trial
means for each variant. It does not pool one-second observations. Its screening
threshold is the maximum of:

1. predeclared practical change in metric units;
2. twice the between-trial standard error of the difference;
3. the largest observed within-variant range of trial means.

Direction-adjusted gain above this threshold is `improved`; below its negative
is `regressed`; otherwise it is `inconclusive`. This is a **conservative screening
heuristic, not a significance test or confidence interval**. Small sample counts
cannot establish a population-level effect or remove systematic confounds.
Unknown metrics stay unknown. Too few trials are inconclusive even when a single
run looks much faster.

Overall report: structural/order problems are `invalid`; any measured regression
is `regressed`; an improved primary with no regressions and no unknown metric is
`improved`; everything else is `inconclusive`. Secondary inconclusive metrics are
shown, not claimed to have improved. The JSON report includes all imported trial
records and hashes; Markdown summarizes results, exclusions and limitations.

## Mutable state

State paths must be inside the explicit existing root. `init` refuses an existing
file. Mutations hold an atomic-mkdir cross-process lock `<state>.lock`, fsync a
private temporary file, then atomically replace the ledger. Lock contention after
two seconds exits 4. A crash may leave a lock; inspect the writer before manually
removing only that lock. No lock stealing, global installs, process kills or file
cleanup. This is a local-filesystem contract, not a distributed/tamper-proof store.
Keep private app paths/logs local; publication is a separately authorized action.

## Read-only generic collector adapter

Have the existing app collector emit JSONL cumulative counters with epoch-second
timestamps (one process/workload window per file):

```json
{"schema_version":1,"at":1700000000,"drawn_frames":120,"presented_frames":119,"metrics":{"cpu_ms":4.1}}
{"schema_version":1,"at":1700000001,"drawn_frames":240,"presented_frames":239,"metrics":{"cpu_ms":4.2}}
```

`presented_frames` can be `null` only when truly unavailable; no inferred
presentation. Every row needs every metric (null for unknown). Counters must be
monotonic and timestamps increasing. Metrics are equally spaced interval
aggregates supplied by the collector; record interval meanings in the workload.
The adapter averages each metric into **one trial mean**, never multiple trials.
Any null reading makes that trial's metric unknown. It calculates actual rates by
counter deltas over the observed interval. Intervals longer than `--max-gap`
(default 2 seconds) are uncovered; the overall coverage must still pass.

```sh
python3 /absolute/skill/scripts/adapters.py application-jsonl --root /raw/trial --manifest /run/manifest.json --template /run/trial-template.json --samples /raw/trial/counters.jsonl
```

The template is a complete v1 trial carrying manual controls/parity/independence.
The adapter replaces measured timestamps, FPS, coverage, metric values and raw
paths, then validates. It prints JSON only. Save output to a new file and ingest
that file. It reads existing raw data; it never injects app code, launches a
collector or changes the owner's app.

## Actual Office thermal adapter

Reuse `/checkout/.agents/skills/office-thermals/SKILL.md`, which in turn requires
`office-clone` and `tools/frame-bench/README.md`. Read the installed runner's help:

```sh
node /checkout/tools/frame-bench/thermal.mjs --help
node /checkout/tools/frame-bench/thermal.mjs --clone /isolated/clone --before /built/before --after /built/after --macmon /existing/verified/macmon --out /new/results
```

These existing reference commands are **not** run by this package. Prerequisites:
macOS, already-built revisions, a real installed-state clone, existing verified
macmon, native Electron for real 120 FPS, stable background conditions. No tool
downloads, global installs or owner-app tests.

```sh
python3 /absolute/skill/scripts/adapters.py office-thermal --root /results/A1 --manifest /run/manifest.json --template /run/A1-template.json
```

The read-only adapter consumes the actual runner's `result.json` (schema 1),
`protocol.json`, `sensors.jsonl`. It cross-checks commit/variant, backend, floor,
weather/camera target, output pixels, full recorded renderer/lights, FPS cap,
measured chunk rates/coverage and sensor gaps. Required workload `quality` is
`{"renderer": RESULT.configuration.renderer, "lights": RESULT.configuration.lights}`;
`scenario` is `FLOOR:WEATHER:TARGET`. Profile, settings hash, device/background/power
controls and parity still come from reviewed template evidence.
The workload's `background_conditions.office_protocol` must exactly equal
`{"warmup_seconds": RESULT.warmupSeconds, "measurement_seconds": RESULT.measurementSeconds,
"cool_criteria": RESULT.coolCriteria}`. This prevents silently changing warmup or
cooldown criteria between revisions. Chunk totals must agree with aggregate frame
counters and measured FPS; relabeling a requested cap cannot satisfy the adapter.

Supported metric names: `cpu_c`, `gpu_c`, `gpu_active`, `gpu_w`, `cpu_w`,
`fan0_rpm`, `fan1_rpm`. They map to actual result aggregate fields. Missing optional
fan/power results become null. Declare appropriate units/directions in the manifest.
Keep all raw files, including failed/calibration logs, in their original folders.
This wrapper does not rebuild Office's sampler, sensor tool, native presenter,
isolation, warmup/cooldown, process ownership or report runner.
