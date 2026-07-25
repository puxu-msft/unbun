from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path

from dual_tui_driver import (
    PtySession,
    build_fixture,
    capture_bad_layout,
    make_source_mixed,
    probe,
    run_steps,
    seed_clean_baseline,
    store_facts,
)
from normalizer import assert_right_edge


ROOT = Path(__file__).resolve().parents[2]
SCENARIOS = json.loads((Path(__file__).with_name("scenarios.json")).read_text())["scenarios"]


class TestDualProductionTui(unittest.TestCase):
    maxDiff = None

    def run_implementation(
        self,
        implementation: str,
        scenario: dict[str, object],
        binary: Path,
        store: Path,
        home: Path,
    ):
        home.mkdir(exist_ok=True)
        session = PtySession(implementation, binary, store, home, int(scenario["columns"]))
        try:
            frames = run_steps(session, scenario["steps"])
        finally:
            session.close()
        js_state = probe("js", binary, store)
        py_state = probe("py", binary, store)
        self.assertEqual(js_state, py_state)
        return frames, js_state, store_facts(store)

    def test_positive_control_rejects_wrong_scenario(self) -> None:
        scenario = next(item for item in SCENARIOS if item.get("positive_control"))
        with tempfile.TemporaryDirectory(prefix="unbun-dual-tui-control-") as temp:
            root = Path(temp)
            binary = root / "bin/claude"
            binary.parent.mkdir()
            build_fixture(binary)
            with self.assertRaisesRegex(AssertionError, "nonexistent-feature"):
                self.run_implementation("js", scenario, binary, root / "store", root / "home-js")

    def test_positive_control_rejects_real_bad_layout(self) -> None:
        with self.assertRaisesRegex(AssertionError, "RIGHT-EDGE"):
            assert_right_edge(capture_bad_layout(columns=80))

    def test_dual_tui_scenarios(self) -> None:
        scenarios = [item for item in SCENARIOS if not item.get("positive_control")]
        selected = os.environ.get("DUAL_TUI_SCENARIO")
        if selected:
            scenarios = [item for item in scenarios if item["id"] == selected]
            self.assertEqual(len(scenarios), 1, f"unknown DUAL_TUI_SCENARIO: {selected}")
        for scenario in scenarios:
            with self.subTest(scenario=scenario["id"]), tempfile.TemporaryDirectory(prefix="unbun-dual-tui-") as temp:
                root = Path(temp)
                binary = root / "bin/claude"
                binary.parent.mkdir()
                build_fixture(binary, str(scenario.get("fixture", "clean")))
                store = root / "store"
                if scenario.get("fixture") == "mixed":
                    seed_clean_baseline(binary, store)
                    make_source_mixed(binary)
                initial_bytes = binary.read_bytes()
                js_result = self.run_implementation("js", scenario, binary, store, root / "home-js")
                binary.write_bytes(initial_bytes)
                binary.chmod(0o755)
                py_result = self.run_implementation("py", scenario, binary, store, root / "home-py")
                self.assertEqual(js_result, py_result)
                expected = scenario.get("final_features")
                if expected is not None:
                    self.assertEqual(js_result[1], expected)

    def test_widths_and_quit_keys_restore_termios(self) -> None:
        base = next(item for item in SCENARIOS if item["id"] == "filter-space-visible-all-disabled-plan")
        for columns in (80, 100, 120):
            for key in ("q", "escape"):
                scenario = {**base, "columns": columns, "steps": [base["steps"][0], {"send": key}]}
                for implementation in ("js", "py"):
                    with self.subTest(columns=columns, key=key, implementation=implementation), tempfile.TemporaryDirectory(prefix="unbun-dual-tui-exit-") as temp:
                        root = Path(temp)
                        binary = root / "bin/claude"
                        binary.parent.mkdir()
                        build_fixture(binary)
                        self.run_implementation(implementation, scenario, binary, root / "store", root / "home")


if __name__ == "__main__":
    unittest.main(verbosity=2)