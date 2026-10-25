#!/usr/bin/env python3
"""Independent-trial performance ledger and conservative comparison."""
import math
from pathlib import Path
import statistics
import sys

from proof_common import JsonArgumentParser, ProofError, absolute, artifact, atomic, emit, inside, load, lock, require, validate, verify

SCHEMA = load(str(Path(__file__).resolve().parents[1] / "references/schema.json"))


def contract(data, name):
    validate(data, SCHEMA["$defs"][name], SCHEMA["$defs"])


def check_manifest(data):
    contract(data, "manifest")
    require(data["primary_metric"] in data["metrics"], "primary_metric must be configured")
    require(data["builds"]["before"] != data["builds"]["after"], "before and after build identities must differ")
    require(data["workload"]["runtime"] in ("electron", "browser", "native", "android"), "unknown runtime")
    require(len(data["workload"]["resolution"]) == 2, "resolution must be exactly [width, height]")
    require(data["workload"]["quality"] and data["workload"]["background_conditions"], "quality and background_conditions must be explicitly recorded")


def check_trial(trial, manifest):
    contract(trial, "trial")
    require(trial["build"] == manifest["builds"][trial["variant"]], "wrong build identity", 3)
    require(trial["workload"] == manifest["workload"], "changed workload/quality/resolution/settings/background conditions", 3)
    require(trial["ended_at"] > trial["started_at"], "trial end must follow start")
    require(set(trial["metrics"]) == set(manifest["metrics"]), "metric coverage differs (use null for unknown)")
    if trial["excluded_reason"] is not None:
        require(bool(trial["excluded_reason"].strip()), "exclusion requires a reason")
        return
    require(trial["independent"] is True, "trial independence must be explicitly attested", 3)
    require(trial["functional_parity"] is True and trial["visual_parity"] is True, "functional/visual parity did not pass", 3)
    require(trial["coverage"] >= manifest["min_coverage"], "missing frame-window coverage", 3)
    require(trial["ended_at"] - trial["started_at"] >= manifest["min_trial_seconds"], "measurement duration too short", 3)
    target = manifest["workload"]["target_fps"]
    minimum = target * (1 - manifest["fps_tolerance"])
    require(minimum <= trial["drawn_fps"] <= target * (1 + manifest["fps_tolerance"]), "actual drawn FPS differs from matched workload", 3)
    if manifest["workload"]["runtime"] in ("native", "electron", "android"):
        require(trial["presented_fps"] is not None and minimum <= trial["presented_fps"] <= target * (1 + manifest["fps_tolerance"]), "actual presented FPS missing/differs from matched workload", 3)
    require(trial["fps_source"] != "requested-cap", "requested FPS cap is not measured FPS", 3)
    for name, spec in manifest["metrics"].items():
        if spec["nonnegative"] and trial["metrics"][name] is not None:
            require(trial["metrics"][name] >= 0, f"negative {name}")


def read_state(args):
    state = load(str(inside(args.state, args.root)))
    contract(state, "state")
    require(state["root"] == str(absolute(args.root)), "state belongs to another root")
    check_manifest(state["manifest"])
    return state


def compare(state):
    manifest = state["manifest"]
    trials, exclusions, problems = [], [], []
    for entry in state["trials"]:
        for raw in [*entry["raw_artifacts"], entry["parity_artifact"], entry["input_artifact"]]:
            verify(raw)
        trial = entry["trial"]
        check_trial(trial, manifest)
        if trial["excluded_reason"] is not None:
            exclusions.append({"id": trial["id"], "reason": trial["excluded_reason"], "raw_artifacts": entry["raw_artifacts"]})
        else:
            trials.append(trial)
    ordered = sorted(trials, key=lambda t: t["started_at"])
    for left, right in zip(ordered, ordered[1:]):
        if left["ended_at"] > right["started_at"]:
            problems.append("overlapping measurement windows are not independent trials")
    if manifest["thermal"]:
        order = [t["variant"] for t in ordered]
        if not order or len(order) % 4 or order != ["before", "after", "after", "before"] * (len(order) // 4):
            problems.append("thermal runs require complete chronological ABBA blocks; exclusions may break the block")
    variants = {v: [t for t in trials if t["variant"] == v] for v in ("before", "after")}
    enough = all(len(v) >= manifest["min_trials"] for v in variants.values())
    results = {}
    for name, spec in manifest["metrics"].items():
        groups = {v: [t["metrics"][name] for t in items] for v, items in variants.items()}
        if any(not xs or any(x is None for x in xs) for xs in groups.values()):
            results[name] = {"status": "unknown", "reason": "missing values are unknown, never zero"}
            continue
        stats = {}
        for variant, values in groups.items():
            stats[variant] = {"n": len(values), "mean": statistics.mean(values), "stdev": statistics.stdev(values) if len(values) > 1 else None,
                              "min": min(values), "max": max(values), "trial_values": values}
        delta = stats["after"]["mean"] - stats["before"]["mean"]
        gain = -delta if spec["direction"] == "lower" else delta
        if not enough:
            status, threshold = "inconclusive", None
        else:
            se = math.sqrt(sum(s["stdev"] ** 2 / s["n"] for s in stats.values()))
            spread = max(s["max"] - s["min"] for s in stats.values())
            threshold = max(spec["practical_change"], 2 * se, spread)
            status = "improved" if gain > threshold else "regressed" if gain < -threshold else "inconclusive"
        results[name] = {"status": status, "direction": spec["direction"], "unit": spec["unit"], "delta_after_minus_before": delta,
                         "gain": gain, "screening_threshold": threshold, "trials": stats}
    primary = results[manifest["primary_metric"]]["status"]
    statuses = [r["status"] for r in results.values()]
    status = "invalid" if problems else "regressed" if "regressed" in statuses else "improved" if primary == "improved" and "unknown" not in statuses else "inconclusive"
    return {"schema_version": 1, "kind": "performance-proof-report", "status": status, "run_id": manifest["run_id"],
            "workload": manifest["workload"], "builds": manifest["builds"], "metrics": results, "exclusions": exclusions,
            "problems": problems, "included_trial_ids": [t["id"] for t in ordered],
            "trial_counts": {v: len(ts) for v, ts in variants.items()},
            "method": "Independent trial means; threshold=max(practical change, 2*between-trial SE, largest within-variant trial range). A conservative screening heuristic, not a confidence interval or significance test.",
            "limitations": ["Independence, comparable background load and parity observations require operator/adapter attestation.",
                            "Frame counters do not prove physical panel scan-out, input-to-photon latency, app-only power or battery life.",
                            "ABBA reduces linear drift; it does not prove thermal equilibrium or controlled ambient conditions."],
            "provenance": state["trials"]}


def markdown(report):
    lines = ["# Performance proof", "", f"Status: **{report['status']}**", f"Run: `{report['run_id']}`", "",
             "| Metric | Result | Before | After | Threshold |", "| --- | --- | ---: | ---: | ---: |"]
    for name, metric in report["metrics"].items():
        groups = metric.get("trials", {})
        lines.append(f"| {name} | {metric['status']} | {groups.get('before', {}).get('mean', 'unknown')} | {groups.get('after', {}).get('mean', 'unknown')} | {metric.get('screening_threshold', 'unknown')} |")
    lines += ["", report["method"], "", "## Exclusions"]
    lines += [f"- {e['id']}: {e['reason']}" for e in report["exclusions"]] or ["- None"]
    lines += ["", "## Limitations"] + [f"- {x}" for x in [*report["problems"], *report["limitations"]]]
    lines += ["", "Raw file hashes, controls and complete trial records are preserved in the JSON report."]
    return "\n".join(lines) + "\n"


def main():
    parser = JsonArgumentParser(description=__doc__, epilog="Exit: 0 accepted/improved, 2 input, 3 invalid/regressed, 4 locked, 5 inconclusive.")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("init", "ingest", "compare"):
        cmd = sub.add_parser(name)
        cmd.add_argument("--root", required=True, help="absolute existing evidence root")
        cmd.add_argument("--state", required=True, help="absolute state path inside root")
        if name == "init":
            cmd.add_argument("--manifest", required=True)
        elif name == "ingest":
            cmd.add_argument("--trial", required=True, help="one independent trial aggregate JSON")
        else:
            cmd.add_argument("--format", choices=("json", "markdown"), default="json")
    args = parser.parse_args()
    root, path = absolute(args.root), inside(args.state, args.root)
    require(root.is_dir() and path.parent.is_dir(), "root and state parent must exist")
    with lock(path):
        if args.command == "init":
            require(not path.exists(), "refusing to overwrite existing state")
            manifest = load(args.manifest)
            check_manifest(manifest)
            atomic(path, {"schema_version": 1, "kind": "performance-proof", "root": str(root), "manifest": manifest, "trials": []})
            emit({"status": "initialized", "run_id": manifest["run_id"]})
            return 0
        state = read_state(args)
        if args.command == "ingest":
            trial = load(args.trial)
            check_trial(trial, state["manifest"])
            require(not any(t["trial"]["id"] == trial["id"] for t in state["trials"]), "duplicate trial id")
            raw = [artifact(p) for p in trial["raw_artifacts"]]
            require(len({r["path"] for r in raw}) == len(raw), "duplicate raw artifact paths")
            require(not any(r["path"] in {a["path"] for e in state["trials"] for a in e["raw_artifacts"]} for r in raw), "raw artifact reused across independent trials")
            entry = {"trial": trial, "raw_artifacts": raw, "parity_artifact": artifact(trial["parity_artifact"]), "input_artifact": artifact(args.trial)}
            state["trials"].append(entry)
            atomic(path, state)
            emit({"status": "ingested", "id": trial["id"], "excluded": trial["excluded_reason"] is not None})
            return 0
        report = compare(state)
        if args.format == "json":
            emit(report)
        else:
            print(markdown(report), end="")
        return 3 if report["status"] in ("invalid", "regressed") else 5 if report["status"] == "inconclusive" else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ProofError, OSError, KeyError, TypeError, ValueError) as exc:
        emit({"status": "error", "error": str(exc)})
        sys.exit(exc.code if isinstance(exc, ProofError) else 2)
