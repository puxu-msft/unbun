from __future__ import annotations

import json
from pathlib import Path
import sys
from typing import Any


REGISTRY_ORDER = ("source-exec", "agent-model", "channels")
REQUIRES = {
    "source-exec": (),
    "agent-model": (),
    "channels": ("source-exec",),
}


def close_request(request_set: Any) -> list[str]:
    if not isinstance(request_set, list):
        raise TypeError("request_set must be an array")
    selected: set[str] = set()

    def add(feature: Any) -> None:
        if not isinstance(feature, str) or feature not in REQUIRES:
            raise ValueError(f"unknown feature: {feature}")
        if feature in selected:
            return
        for dependency in REQUIRES[feature]:
            add(dependency)
        selected.add(feature)

    for feature in request_set:
        add(feature)
    return [feature for feature in REGISTRY_ORDER if feature in selected]


def request_sets(requests: Any) -> list[dict[str, Any]]:
    if not isinstance(requests, list):
        raise TypeError("requests must be an array")
    return [
        {"request_set": request_set, "closed_set": close_request(request_set)}
        for request_set in requests
    ]


def evaluate_vector(document: Any) -> dict[str, Any]:
    if not isinstance(document, dict):
        raise TypeError("vector root must be an object")
    common = {
        "feature_contract": "claude-v1",
        "implementation": "python",
        "runner_role": "read-only-contract",
    }
    if isinstance(document.get("requests"), list) and isinstance(
        document.get("registry_order"), list
    ):
        return {
            **common,
            "kind": "dependency-closure",
            "request_sets": request_sets(document["requests"]),
        }
    if document.get("algorithm") == "claude-v1-exact-replay" and isinstance(
        document.get("targets"), list
    ):
        return {
            **common,
            "kind": "lineage-targets",
            "algorithm": document["algorithm"],
            "baseline": document.get("baseline"),
            "cases": document.get("cases"),
            "targets": request_sets(document["targets"]),
        }
    return {**common, "kind": "contract-vector", "document": document}


def main() -> int:
    vector_path = sys.stdin.read().strip()
    if not vector_path:
        raise ValueError("stdin must contain a vector path")
    with Path(vector_path).open("r", encoding="utf-8") as stream:
        document = json.load(stream)
    result = evaluate_vector(document)
    sys.stdout.write(
        json.dumps(result, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        + "\n"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        sys.stderr.write(f"python-vector-runner: {error}\n")
        raise SystemExit(1)