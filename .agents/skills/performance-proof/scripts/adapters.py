#!/usr/bin/env python3
"""Read-only adapters for Office thermal results and application JSONL counters."""
import json
import math
from pathlib import Path
import statistics
import sys

from proof_common import JsonArgumentParser, ProofError, absolute, artifact, emit, inside, load, require
from performance import check_manifest, check_trial, contract


def finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def generic(args, manifest, template, root):
    path = inside(args.samples, root)
    rows = []
    with path.open() as stream:
        for line in stream:
            if line.strip():
                row = json.loads(line)
                require(isinstance(row, dict) and type(row.get("schema_version")) is int and row["schema_version"] == 1, "counter row requires integer schema_version 1")
                require(set(row) == {"schema_version", "at", "drawn_frames", "presented_frames", "metrics"}, "unknown/missing counter fields")
                require(finite(row["at"]) and finite(row["drawn_frames"]) and row["drawn_frames"] >= 0, "invalid counter/time")
                require(row["presented_frames"] is None or finite(row["presented_frames"]) and row["presented_frames"] >= 0, "invalid presenter counter")
                require(isinstance(row["metrics"], dict) and set(row["metrics"]) == set(manifest["metrics"]), "metric coverage differs")
                require(all(v is None or finite(v) for v in row["metrics"].values()), "nonfinite metric")
                rows.append(row)
    require(len(rows) >= 2, "at least two counter readings required")
    for left, right in zip(rows, rows[1:]):
        require(right["at"] > left["at"] and right["drawn_frames"] >= left["drawn_frames"], "clock/counter reset or unsorted samples")
        require(left["presented_frames"] is None or right["presented_frames"] is None or right["presented_frames"] >= left["presented_frames"], "presenter counter reset")
    duration = rows[-1]["at"] - rows[0]["at"]
    template["started_at"], template["ended_at"] = rows[0]["at"], rows[-1]["at"]
    template["drawn_fps"] = (rows[-1]["drawn_frames"] - rows[0]["drawn_frames"]) / duration
    all_presented = all(row["presented_frames"] is not None for row in rows)
    template["presented_fps"] = (rows[-1]["presented_frames"] - rows[0]["presented_frames"]) / duration if all_presented else None
    template["fps_source"] = "native-presenter-counter" if all_presented else "drawn-frame-counter"
    template["coverage"] = sum(r["at"] - l["at"] for l, r in zip(rows, rows[1:]) if r["at"] - l["at"] <= args.max_gap) / duration
    for metric in manifest["metrics"]:
        values = [row["metrics"][metric] for row in rows]
        template["metrics"][metric] = statistics.mean(values) if all(v is not None for v in values) else None
    template["raw_artifacts"] = [str(path)]
    return template


def office(args, manifest, template, root):
    # These are the actual thermal.mjs/thermal-steps.mjs v1 output fields.
    result_path = inside(str(root / "result.json"), root)
    protocol_path = inside(str(root / "protocol.json"), root)
    result, protocol = load(str(result_path)), load(str(protocol_path))
    require(result.get("schema") == 1, "unsupported Office thermal result schema")
    require(result["variant"] == template["variant"] and result["commit"] == template["build"], "Office build/variant mismatch", 3)
    native = result["backend"] == "native"
    require(manifest["workload"]["runtime"] == ("electron" if native else "browser"), "Office backend differs from workload", 3)
    config = result["configuration"]
    expected_quality = {"renderer": config["renderer"], "lights": config["lights"]}
    require(manifest["workload"]["quality"] == expected_quality, "record exact Office renderer/lights quality in workload", 3)
    expected_protocol = {"warmup_seconds": result["warmupSeconds"], "measurement_seconds": result["measurementSeconds"], "cool_criteria": result["coolCriteria"]}
    require(manifest["workload"]["background_conditions"].get("office_protocol") == expected_protocol, "Office warmup/cooldown/measurement protocol differs from workload", 3)
    require(manifest["workload"]["resolution"] == [config["output"]["width"], config["output"]["height"]], "Office resolution mismatch", 3)
    require(manifest["workload"]["scenario"] == f"{config['floor']}:{config['weather']}:{protocol['target']}", "Office floor/weather/camera target mismatch", 3)
    require(result["fps"] == manifest["workload"]["target_fps"] and result["pacing"]["fpsCap"] == result["fps"], "Office requested FPS mismatch", 3)
    seconds = result["measurementSeconds"]
    require(finite(seconds) and seconds > 0, "invalid measurementSeconds")
    pacing = result["pacing"]
    chunks = pacing["chunks"]
    require(chunks, "Office pacing requires raw chunk coverage")
    for chunk in chunks:
        r = chunk["report"]
        require(finite(chunk["seconds"]) and chunk["seconds"] > 0, "invalid pacing chunk duration")
        require(r["spanMs"] >= chunk["seconds"] * 1000 * manifest["min_coverage"], "Office chunk missing time coverage", 3)
        require(abs(r["fps"] - result["fps"]) <= result["fps"] * manifest["fps_tolerance"], "Office chunk actual drawn FPS mismatch", 3)
        require(r["frames"] >= result["fps"] * chunk["seconds"] * (1 - manifest["fps_tolerance"]), "Office chunk missing frames", 3)
    frames = sum(c["report"]["frames"] for c in chunks)
    span_ms = sum(c["report"]["spanMs"] for c in chunks)
    require(span_ms > 0 and frames == pacing["frames"] and abs(span_ms - pacing["spanMs"]) < 0.01, "Office aggregate frame counters differ from chunks", 3)
    require(abs(frames * 1000 / span_ms - pacing["fps"]) < 0.01, "Office aggregate FPS differs from frame counters", 3)
    template.update(started_at=result["measureAt"] / 1000, ended_at=result["finishAt"] / 1000,
                    drawn_fps=pacing["fps"], presented_fps=(result.get("presenter") or {}).get("fps"),
                    fps_source="native-presenter-counter" if native else "drawn-frame-counter",
                    coverage=min(1, pacing["spanMs"] / (seconds * 1000)))
    mapping = {"cpu_c": "cpuC", "gpu_c": "gpuC", "gpu_active": "gpuActive", "gpu_w": "estimatedGpuW", "cpu_w": "estimatedCpuW",
               "fan0_rpm": "fan0Rpm", "fan1_rpm": "fan1Rpm"}
    require(set(manifest["metrics"]).issubset(mapping), f"supported Office metrics: {list(mapping)}")
    template["metrics"] = {name: (result.get(mapping[name]) or {}).get("mean") for name in manifest["metrics"]}
    sensor_path = inside(str(root / "sensors.jsonl"), root)
    measured = []
    with sensor_path.open() as stream:
        for line in stream:
            if line.strip():
                row = json.loads(line)
                if row.get("phase") == "measurement" and result["measureAt"] + 1000 <= row["at"] <= result["finishAt"]:
                    measured.append(row)
    require(len(measured) >= seconds * 0.9, "missing Office sensor coverage", 3)
    require(all(0 < r["at"] - l["at"] <= 2500 for l, r in zip(measured, measured[1:])), "Office sensor gaps/order invalid", 3)
    template["raw_artifacts"] = [str(result_path), str(protocol_path), str(sensor_path)]
    return template


def main():
    parser = JsonArgumentParser(description=__doc__, epilog="Writes only JSON to stdout. Operator supplies controls, independent-run and parity attestations.")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("application-jsonl", "office-thermal"):
        cmd = sub.add_parser(name)
        cmd.add_argument("--root", required=True, help="absolute existing raw results root")
        cmd.add_argument("--manifest", required=True)
        cmd.add_argument("--template", required=True, help="complete v1 trial; adapter replaces measured fields only")
        if name == "application-jsonl":
            cmd.add_argument("--samples", required=True)
            cmd.add_argument("--max-gap", type=float, default=2, help="maximum seconds between covered counter readings")
    args = parser.parse_args()
    root = absolute(args.root)
    require(root.is_dir(), "raw root must exist")
    manifest, template = load(args.manifest), load(args.template)
    check_manifest(manifest)
    contract(template, "trial")
    if args.command == "application-jsonl":
        require(math.isfinite(args.max_gap) and args.max_gap > 0, "max-gap must be positive/finite")
        trial = generic(args, manifest, template, root)
    else:
        trial = office(args, manifest, template, root)
    check_trial(trial, manifest)
    for path in [*trial["raw_artifacts"], trial["parity_artifact"]]:
        artifact(path)
    emit(trial)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ProofError, OSError, KeyError, TypeError, ValueError, ZeroDivisionError) as exc:
        emit({"status": "error", "error": str(exc)})
        sys.exit(exc.code if isinstance(exc, ProofError) else 2)
