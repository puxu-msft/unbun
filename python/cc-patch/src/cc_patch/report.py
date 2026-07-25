from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from cc_patch.models import BinaryProbe, CliError, SnapshotInfo, WriteOutcome


def _json_default(value: Any) -> str:
    if isinstance(value, Path):
        return str(value)
    raise TypeError(f"Cannot serialize {type(value).__name__}")


def render_check(probes: list[BinaryProbe]) -> str:
    sections: list[str] = []
    for probe in probes:
        lines = [
            str(probe.path),
            f"Version  : {probe.version or '?'}",
            f"Size     : {probe.size_bytes / (1024 * 1024):.1f} MB",
            f"Baseline : {'yes' if probe.has_baseline else 'no'}",
        ]
        if probe.probe_error is not None:
            lines.append(f"Error    : {probe.probe_error['message']}")
        for slug, status in probe.features.items():
            lines.append(f"  {slug:<13}: {status.state} ({status.sites} site(s))")
            lines.extend(f"    - {detail}" for detail in status.details)
        sections.append("\n".join(lines))
    return "\n\n".join(sections)


def render_json(probes: list[BinaryProbe]) -> str:
    return json.dumps(
        [
            {
                "schema_version": 1,
                "path": str(probe.path),
                "version": probe.version,
                "size_bytes": probe.size_bytes,
                "has_baseline": probe.has_baseline,
                "probe_error": probe.probe_error,
                "features": {
                    slug: {
                        "slug": status.slug,
                        "state": status.state,
                        "details": list(status.detail_codes),
                        "sites": status.sites,
                        "substates": [
                            {
                                "identity": substate.identity,
                                "state": substate.state,
                            }
                            for substate in status.substates
                        ],
                    }
                    for slug, status in probe.features.items()
                },
            }
            for probe in probes
        ],
        ensure_ascii=False,
        indent=2,
    )


def write_outcome_dict(outcome: WriteOutcome) -> dict[str, Any]:
    return {
        "binary": str(outcome.binary),
        "applied": outcome.applied,
        "edits": outcome.edits,
        "resigned": outcome.resigned,
    }


def render_write_outcomes_json(
    *,
    action: str,
    exit_code: int,
    outcomes: list[WriteOutcome],
    errors: list[CliError],
) -> str:
    return json.dumps(
        {
            "schema_version": 1,
            "success": exit_code == 0,
            "exit_code": exit_code,
            "action": action,
            "results": [write_outcome_dict(outcome) for outcome in outcomes],
            "errors": [
                {
                    "schema_version": 1,
                    "code": error.code,
                    "message": error.message,
                    "binary": str(error.binary) if error.binary is not None else None,
                    "feature": error.feature,
                    "details": error.details or {},
                }
                for error in errors
            ],
        },
        ensure_ascii=False,
        indent=2,
    )


def render_write_outcome(outcome: WriteOutcome, *, action: str | None = None) -> str:
    if outcome.applied:
        action = action or "Patched"
        applied = ", ".join(outcome.applied)
    else:
        action = action or ("Reverted" if outcome.edits else "Already clean")
        applied = "clean baseline"
    lines = [
        f"{action} -> {outcome.binary} ({outcome.edits} edit block(s))",
        f"Features : {applied}",
    ]
    if outcome.resigned:
        lines.append("codesign : macOS ad-hoc signature refreshed")
    return "\n".join(lines)


def render_snapshots(infos: list[SnapshotInfo]) -> str:
    if not infos:
        return "No named snapshots."
    lines = []
    for info in infos:
        flags = []
        if info.is_stale:
            flags.append("stale")
        if info.invalid:
            flags.append("invalid")
        marker = f" [{' / '.join(flags)}]" if flags else ""
        lines.append(
            f"{info.slug:<24} {info.version:<12} "
            f"{info.created_at.isoformat()}{marker}\n  {info.path}"
        )
    return "\n".join(lines)
