from __future__ import annotations

import re
from dataclasses import dataclass


FEATURES = ("source-exec", "agent-model", "channels")
STATES = ("clean", "patched", "mixed", "unsupported")


def assert_right_edge(lines: list[str]) -> None:
    if not lines or not lines[0].endswith("RIGHT-EDGE"):
        first = "" if not lines else lines[0]
        raise AssertionError(f"RIGHT-EDGE is not visible at the viewport edge: {first!r}")


@dataclass(frozen=True)
class ScreenFacts:
    features: dict[str, str]
    visible_features: tuple[str, ...]
    selected: tuple[str, ...]
    disabled: tuple[str, ...]
    pending: int | None
    target_features: tuple[str, ...]
    phase: str


def normalize_screen(lines: list[str]) -> ScreenFacts:
    text = "\n".join(line.rstrip() for line in lines)
    features: dict[str, str] = {}
    selected: list[str] = []
    disabled: list[str] = []
    visible: list[str] = []
    for line in lines:
        lowered = line.lower()
        feature = next((slug for slug in FEATURES if slug in lowered), None)
        state = next((value for value in STATES if re.search(rf"\b{value}\b", lowered)), None)
        if feature is None or state is None:
            continue
        features[feature] = state
        if feature not in visible:
            visible.append(feature)
        if re.search(r"\[x\]", lowered) and feature not in selected:
            selected.append(feature)
        if "disabled" in lowered or state == "unsupported":
            disabled.append(feature)

    pending_match = re.search(r"(\d+)\s+pending", text, re.IGNORECASE)
    pending = int(pending_match.group(1)) if pending_match else None
    targets: list[str] = []
    for match in re.finditer(r"(?:patch|replay)(?:\[([^]]+)\]|\s+mixed)", text, re.IGNORECASE):
        if match.group(1):
            for feature in FEATURES:
                if feature in match.group(1) and feature not in targets:
                    targets.append(feature)
        elif "source-exec" in features and "source-exec" not in targets:
            targets.append("source-exec")
    if "revert all" in text.lower():
        targets = []

    lowered_text = text.lower()
    if ("applying" in lowered_text or "running:" in lowered_text) and "done:" not in lowered_text:
        phase = "applying"
    elif "done:" in lowered_text and not pending:
        phase = "done"
    elif "probing" in lowered_text:
        phase = "loading"
    else:
        phase = "ready"
    return ScreenFacts(
        features=features,
        visible_features=tuple(visible),
        selected=tuple(selected),
        disabled=tuple(disabled),
        pending=pending,
        target_features=tuple(targets),
        phase=phase,
    )


def assert_expected(actual: ScreenFacts, expected: dict[str, object]) -> None:
    for key, value in expected.items():
        if key == "features":
            for feature, state in value.items():
                if actual.features.get(feature) != state:
                    raise AssertionError(f"feature {feature}: expected {state}, got {actual.features.get(feature)}; facts={actual}")
            continue
        actual_value = getattr(actual, key)
        if isinstance(actual_value, tuple):
            if set(actual_value) != set(value):
                raise AssertionError(f"{key}: expected {value}, got {actual_value}; facts={actual}")
        elif actual_value != value:
            raise AssertionError(f"{key}: expected {value}, got {actual_value}; facts={actual}")