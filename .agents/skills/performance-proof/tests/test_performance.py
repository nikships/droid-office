"""Synthetic contract tests only. No real-app, temperature or battery claims."""
import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

PACKAGE = Path(__file__).resolve().parents[1]
CLI, ADAPTER = PACKAGE / "scripts/performance.py", PACKAGE / "scripts/adapters.py"


class PerformanceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.state = self.root / "state.json"
        self.workload = {"device": "sanitized-device", "profile": "copied-profile", "settings_sha256": "a" * 64,
                         "resolution": [1920, 1080], "quality": {"preset": "high", "msaa": 4}, "target_fps": 120,
                         "background_conditions": {"load": "unchanged-idle-apps"}, "runtime": "electron",
                         "scenario": "returning-user-panels", "power_mode": "AC-default"}
        self.manifest = {"schema_version": 1, "run_id": "synthetic-contract", "workload": self.workload,
                         "builds": {"before": "rev-before", "after": "rev-after"},
                         "metrics": {"cpu_ms": {"direction": "lower", "unit": "ms", "practical_change": 0.1, "nonnegative": True}},
                         "primary_metric": "cpu_ms", "min_trials": 2, "min_trial_seconds": 10,
                         "min_coverage": 0.95, "fps_tolerance": 0.025, "thermal": False}
        self.parity = self.root / "parity.txt"
        self.parity.write_text("SYNTHETIC unit-test parity artifact, not a real screenshot")

    def write(self, name, data):
        path = self.root / name
        path.write_text(json.dumps(data))
        return path

    def cli(self, command, *args, code=0, json_output=True):
        result = subprocess.run([sys.executable, str(CLI), command, "--root", str(self.root), "--state", str(self.state), *map(str, args)], capture_output=True, text=True)
        self.assertEqual(result.returncode, code, result.stdout + result.stderr)
        return json.loads(result.stdout) if json_output else result.stdout

    def init(self, code=0):
        return self.cli("init", "--manifest", self.write("manifest.json", self.manifest), code=code)

    def trial(self, index, variant, value):
        raw = self.root / f"raw-{index}.txt"
        raw.write_text(f"SYNTHETIC independent trial {index}")
        return {"schema_version": 1, "id": f"trial-{index}", "variant": variant, "build": self.manifest["builds"][variant],
                "workload": copy.deepcopy(self.workload), "started_at": index * 100, "ended_at": index * 100 + 10,
                "independent": True, "functional_parity": True, "visual_parity": True, "coverage": 0.99,
                "drawn_fps": 120, "presented_fps": 120, "fps_source": "native-presenter-counter",
                "metrics": {name: value for name in self.manifest["metrics"]}, "raw_artifacts": [str(raw)],
                "parity_artifact": str(self.parity), "excluded_reason": None}

    def ingest(self, trial, code=0):
        return self.cli("ingest", "--trial", self.write(f"{trial['id']}.json", trial), code=code)

    def series(self, values=(10, 6, 6.1, 10.1)):
        for i, (variant, value) in enumerate(zip(("before", "after", "after", "before"), values), 1):
            self.ingest(self.trial(i, variant, value))

    def test_independent_repeated_trials_improvement(self):
        self.init()
        self.series()
        report = self.cli("compare")
        self.assertEqual(report["status"], "improved")
        self.assertEqual(report["metrics"]["cpu_ms"]["trials"]["before"]["n"], 2)
        self.assertIn("sha256", report["provenance"][0]["raw_artifacts"][0])

    def test_actual_drawn_and_presented_rate_rejected(self):
        self.init()
        for field, value in (("drawn_fps", 60), ("presented_fps", 60), ("presented_fps", None), ("drawn_fps", 160), ("fps_source", "requested-cap")):
            with self.subTest(field=field, value=value):
                trial = self.trial(1, "before", 10)
                trial[field] = value
                self.ingest(trial, code=3)

    def test_workload_changes_rejected(self):
        self.init()
        for field, value in (("resolution", [1280, 720]), ("quality", {"preset": "low"}), ("profile", "wrong"), ("target_fps", 60), ("settings_sha256", "b" * 64)):
            with self.subTest(field=field):
                trial = self.trial(1, "before", 10)
                trial["workload"][field] = value
                self.ingest(trial, code=3)

    def test_parity_and_missing_coverage_rejected(self):
        self.init()
        for field, value in (("functional_parity", False), ("visual_parity", None), ("coverage", 0.4), ("independent", False)):
            trial = self.trial(1, "before", 10)
            trial[field] = value
            self.ingest(trial, code=3)

    def test_wrong_build_rejected(self):
        self.init()
        trial = self.trial(1, "before", 10)
        trial["build"] = "stale-build"
        self.ingest(trial, code=3)

    def test_unknown_not_zero(self):
        self.init()
        self.series((10, None, 6, 10))
        report = self.cli("compare", code=5)
        self.assertEqual(report["metrics"]["cpu_ms"]["status"], "unknown")

    def test_noise_inconclusive(self):
        self.init()
        self.series((10, 8.9, 10.9, 12))
        self.assertEqual(self.cli("compare", code=5)["status"], "inconclusive")

    def test_insufficient_trials_inconclusive(self):
        self.init()
        self.ingest(self.trial(1, "before", 10))
        self.ingest(self.trial(2, "after", 5))
        self.cli("compare", code=5)

    def test_regression(self):
        self.init()
        self.series((5, 10, 10.1, 5.1))
        self.assertEqual(self.cli("compare", code=3)["status"], "regressed")

    def test_higher_metric(self):
        self.manifest["metrics"]["cpu_ms"]["direction"] = "higher"
        self.init()
        self.series((5, 10, 10.1, 5.1))
        self.cli("compare")

    def test_exclusions_preserved(self):
        self.init()
        excluded = self.trial(0, "before", 999)
        excluded.update(excluded_reason="calibration run: wrong FPS, retained", drawn_fps=60, functional_parity=False)
        self.ingest(excluded)
        self.series()
        report = self.cli("compare")
        self.assertEqual(report["exclusions"][0]["id"], "trial-0")
        self.assertEqual(report["trial_counts"]["before"], 2)

    def test_exclusion_cannot_hide_workload_mismatch(self):
        self.init()
        trial = self.trial(1, "before", 100)
        trial["workload"]["quality"] = {"preset": "low"}
        trial["excluded_reason"] = "bad calibration"
        self.ingest(trial, code=3)

    def test_thermal_requires_abba(self):
        self.manifest["thermal"] = True
        self.init()
        for i, variant in enumerate(("before", "after", "before", "after"), 1):
            self.ingest(self.trial(i, variant, 10 if variant == "before" else 5))
        self.assertEqual(self.cli("compare", code=3)["status"], "invalid")

    def test_thermal_abba_passes(self):
        self.manifest["thermal"] = True
        self.init()
        self.series()
        self.cli("compare")

    def test_overlapping_trials_invalid(self):
        self.init()
        for i, variant in enumerate(("before", "after", "after", "before"), 1):
            trial = self.trial(i, variant, 10 if variant == "before" else 5)
            trial.update(started_at=100, ended_at=110)
            self.ingest(trial)
        self.assertEqual(self.cli("compare", code=3)["status"], "invalid")

    def test_raw_provenance_tamper(self):
        self.init()
        self.series()
        (self.root / "raw-1.txt").write_text("changed")
        self.cli("compare", code=3)

    def test_missing_raw_is_gate_failure(self):
        self.init()
        self.series()
        (self.root / "raw-1.txt").unlink()
        self.cli("compare", code=3)

    def test_duplicate_trial_and_reused_raw_fail(self):
        self.init()
        trial = self.trial(1, "before", 10)
        self.ingest(trial)
        self.ingest(trial, code=2)
        trial["id"] = "different-id"
        self.ingest(trial, code=2)

    def test_missing_values_coverage_explicit(self):
        self.init()
        trial = self.trial(1, "before", 10)
        trial["metrics"] = {}
        self.ingest(trial, code=2)

    def test_invalid_versions_nonfinite_and_relative_paths(self):
        self.manifest["schema_version"] = 2
        self.init(code=2)
        self.manifest["schema_version"] = 1
        self.init()
        trial = self.trial(1, "before", float("nan"))
        self.ingest(trial, code=2)
        trial = self.trial(1, "before", 10)
        trial["raw_artifacts"] = ["relative.txt"]
        self.ingest(trial, code=2)

    def test_browser_counter_can_have_unknown_presenter(self):
        self.workload["runtime"] = "browser"
        self.init()
        trial = self.trial(1, "before", 10)
        trial.update(presented_fps=None, fps_source="drawn-frame-counter")
        self.ingest(trial)

    def test_markdown_report(self):
        self.init()
        self.series()
        text = self.cli("compare", "--format", "markdown", json_output=False)
        self.assertIn("Status: **improved**", text)
        self.assertIn("not prove physical panel", text)

    def test_mutating_ingests_serialize_across_processes(self):
        self.init()
        trials = [self.trial(i, "before" if i == 1 else "after", 10) for i in (1, 2)]
        processes = []
        for trial in trials:
            path = self.write(f"{trial['id']}.json", trial)
            processes.append(subprocess.Popen([sys.executable, str(CLI), "ingest", "--root", str(self.root), "--state", str(self.state), "--trial", str(path)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True))
        for process in processes:
            out, err = process.communicate(timeout=10)
            self.assertEqual(process.returncode, 0, out + err)
        self.assertEqual(len(json.loads(self.state.read_text())["trials"]), 2)

    def test_lock_conflict(self):
        self.init()
        directory = Path(str(self.state) + ".lock")
        directory.mkdir()
        self.addCleanup(directory.rmdir)
        self.cli("compare", code=4)

    def test_jsonl_adapter_measures_actual_counters(self):
        manifest = self.write("manifest.json", self.manifest)
        template = self.write("template.json", self.trial(1, "before", 10))
        samples = self.root / "samples.jsonl"
        rows = [{"schema_version": 1, "at": i, "drawn_frames": i * 120, "presented_frames": i * 120, "metrics": {"cpu_ms": 4 + i / 10}} for i in range(11)]
        samples.write_text("\n".join(map(json.dumps, rows)))
        args = [sys.executable, str(ADAPTER), "application-jsonl", "--root", str(self.root), "--manifest", str(manifest), "--template", str(template), "--samples", str(samples)]
        result = subprocess.run(args, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout)
        output = json.loads(result.stdout)
        self.assertEqual(output["drawn_fps"], 120)
        self.assertEqual(output["metrics"]["cpu_ms"], 4.5)
        rows[-1]["drawn_frames"] = 500
        samples.write_text("\n".join(map(json.dumps, rows)))
        result = subprocess.run(args, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)

    def office_fixture(self):
        """Actual thermal-steps v1 shape, all values explicitly synthetic."""
        self.manifest["metrics"] = {"cpu_c": {"direction": "lower", "unit": "C", "practical_change": 0.5, "nonnegative": True},
                                    "fan0_rpm": {"direction": "lower", "unit": "rpm", "practical_change": 50, "nonnegative": True}}
        self.manifest["primary_metric"] = "cpu_c"
        self.manifest["thermal"] = True
        self.workload.update(quality={"renderer": {"preset": "test-high"}, "lights": [{"visible": True, "intensity": 1}]},
                             scenario="floor-sanitized:clear:desk-1")
        self.workload["background_conditions"]["office_protocol"] = {"warmup_seconds": 180, "measurement_seconds": 10,
                                                                    "cool_criteria": {"cpuMaxC": 34, "gpuMaxC": 33}}
        trial = self.trial(1, "before", 40)
        result = {"schema": 1, "variant": "before", "commit": "rev-before", "backend": "native", "fps": 120,
                  "configuration": {"renderer": {"preset": "test-high"}, "lights": [{"visible": True, "intensity": 1}],
                                    "output": {"width": 1920, "height": 1080}, "floor": "floor-sanitized", "weather": "clear"},
                  "measurementSeconds": 10, "warmupSeconds": 180, "coolCriteria": {"cpuMaxC": 34, "gpuMaxC": 33},
                  "measureAt": 1000000, "finishAt": 1010000,
                  "pacing": {"fpsCap": 120, "fps": 120, "spanMs": 10000, "frames": 1200,
                             "chunks": [{"seconds": 10, "report": {"spanMs": 10000, "fps": 120, "frames": 1200}}]},
                  "presenter": {"fps": 120}, "cpuC": {"mean": 40}, "fan0Rpm": None}
        manifest_path = self.write("manifest.json", self.manifest)
        template_path = self.write("template.json", trial)
        self.write("result.json", result)
        self.write("protocol.json", {"target": "desk-1"})
        sensor = self.root / "sensors.jsonl"
        sensor.write_text("\n".join(json.dumps({"phase": "measurement", "at": 1000000 + i * 1000, "cpuC": 40, "gpuC": 39}) for i in range(1, 11)))
        args = [sys.executable, str(ADAPTER), "office-thermal", "--root", str(self.root), "--manifest", str(manifest_path), "--template", str(template_path)]
        return args, result

    def test_office_adapter_actual_v1_result_shape_and_unknown_fans(self):
        args, _ = self.office_fixture()
        result = subprocess.run(args, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        trial = json.loads(result.stdout)
        self.assertEqual(trial["metrics"], {"cpu_c": 40, "fan0_rpm": None})
        self.assertEqual(trial["presented_fps"], 120)
        self.assertEqual(len(trial["raw_artifacts"]), 3)

    def test_office_adapter_rejects_low_fps_chunk_and_resolution(self):
        args, fixture = self.office_fixture()
        fixture["pacing"]["chunks"][0]["report"]["fps"] = 60
        self.write("result.json", fixture)
        result = subprocess.run(args, capture_output=True, text=True)
        self.assertEqual(result.returncode, 3, result.stdout)
        fixture["pacing"]["chunks"][0]["report"]["fps"] = 120
        fixture["configuration"]["output"]["width"] = 1280
        self.write("result.json", fixture)
        result = subprocess.run(args, capture_output=True, text=True)
        self.assertEqual(result.returncode, 3, result.stdout)

    def test_office_adapter_rejects_missing_sensor_coverage(self):
        args, _ = self.office_fixture()
        (self.root / "sensors.jsonl").write_text('{"phase":"measurement","at":1001000}\n')
        result = subprocess.run(args, capture_output=True, text=True)
        self.assertEqual(result.returncode, 3, result.stdout)

    def test_office_adapter_rejects_changed_cooldown_protocol(self):
        args, fixture = self.office_fixture()
        fixture["warmupSeconds"] = 30
        self.write("result.json", fixture)
        result = subprocess.run(args, capture_output=True, text=True)
        self.assertEqual(result.returncode, 3, result.stdout)

    def test_help_invalid_cli_evals(self):
        for script in (CLI, ADAPTER):
            result = subprocess.run([sys.executable, str(script), "--help"], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
        result = subprocess.run([sys.executable, str(CLI), "bogus"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stdout)["status"], "error")
        self.assertGreaterEqual(len(json.loads((PACKAGE / "evals/cases.json").read_text())["cases"]), 3)

    def test_reference_examples_match_schema_and_evals_map_to_tests(self):
        program = (
            "import json,sys; from pathlib import Path; "
            "sys.path.insert(0,sys.argv[1]); from proof_common import validate; "
            "p=Path(sys.argv[1]).parent; s=json.loads((p/'references/schema.json').read_text()); "
            "e=json.loads((p/'references/examples.json').read_text()); "
            "validate(e['manifest'],s['$defs']['manifest'],s['$defs']); "
            "validate(e['trial'],s['$defs']['trial'],s['$defs'])"
        )
        result = subprocess.run([sys.executable, "-c", program, str(PACKAGE / "scripts")], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for case in json.loads((PACKAGE / "evals/cases.json").read_text())["cases"]:
            for name in case["test"].split("; "):
                self.assertTrue(hasattr(type(self), name), name)


if __name__ == "__main__":
    unittest.main()
