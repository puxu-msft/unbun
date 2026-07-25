import hashlib
import json
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path
from typing import Callable


class LineageError(RuntimeError):
    def __init__(self, code: str, exit_code: int, message: str):
        self.code = code
        self.exit_code = exit_code
        super().__init__(message)


@dataclass(frozen=True)
class PlatformGate:
    platform: str
    format: str
    lineage_algorithm: str
    capabilities: dict
    production_write_gate: dict


@dataclass(frozen=True)
class ExactReplayProof:
    accepted: bool
    byte_equal: bool
    normalized_size: int
    baseline_lineage_sha256: str
    expected_sha256: str
    current_sha256: str
    substates: object


class ExactReplayAdapter(ABC):
    @abstractmethod
    def observe_substates(self, current: bytes) -> object:
        raise NotImplementedError

    @abstractmethod
    def replay_substates(self, baseline: bytes, substates: object) -> bytes:
        raise NotImplementedError


def load_platform_gate(contract_root: Path, platform: str) -> PlatformGate:
    path = Path(contract_root) / "vectors/platform-writes-v1.json"
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        record = payload["platforms"][platform]
        capabilities = record["capabilities"]
        production = capabilities["production_write_gate"]
        if payload["lineage_algorithm"] != "claude-v1-exact-replay" or "writes" in payload or "writes" in capabilities:
            raise ValueError("invalid platform gate aggregation")
        return PlatformGate(
            platform=platform,
            format=record["format"],
            lineage_algorithm=payload["lineage_algorithm"],
            capabilities=capabilities,
            production_write_gate=production,
        )
    except KeyError as error:
        if error.args == (platform,):
            raise LineageError("platform_write_unsupported", 1, f"unsupported platform: {platform}") from error
        raise LineageError("platform_gate_invalid", 2, f"invalid platform gate: missing {error.args[0]}") from error
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError) as error:
        raise LineageError("platform_gate_invalid", 2, f"invalid platform gate: {error}") from error


def assert_platform_write_enabled(contract_root: Path, platform_name: str) -> PlatformGate:
    """Return an enabled platform gate or reject production writes before side effects."""
    gate = load_platform_gate(contract_root, platform_name)
    if gate.production_write_gate["status"] != "enabled":
        raise LineageError(
            "platform_write_disabled",
            1,
            f"production writes disabled for platform: {platform_name}",
        )
    return gate


def prove_exact_replay(
    baseline: bytes,
    current: bytes,
    *,
    adapter: ExactReplayAdapter,
    normalize: Callable[[bytes], bytes],
    baseline_lineage_sha256: str,
) -> ExactReplayProof:
    try:
        normalized_baseline = normalize(baseline)
    except Exception as error:
        raise LineageError("baseline_invalid", 2, f"baseline normalization failed: {error}") from error
    actual_lineage = hashlib.sha256(normalized_baseline).hexdigest()
    if actual_lineage != baseline_lineage_sha256:
        raise LineageError("baseline_invalid", 2, "baseline lineage hash mismatch")
    try:
        substates = adapter.observe_substates(current)
        expected = adapter.replay_substates(baseline, substates)
        normalized_expected = normalize(expected)
        normalized_current = normalize(current)
    except LineageError:
        raise
    except Exception as error:
        raise LineageError("baseline_stale_build", 2, f"exact replay failed: {error}") from error
    if len(normalized_expected) != len(normalized_current) or normalized_expected != normalized_current:
        raise LineageError("baseline_stale_build", 2, "exact replay bytes differ")
    return ExactReplayProof(
        accepted=True,
        byte_equal=True,
        normalized_size=len(normalized_current),
        baseline_lineage_sha256=actual_lineage,
        expected_sha256=hashlib.sha256(normalized_expected).hexdigest(),
        current_sha256=hashlib.sha256(normalized_current).hexdigest(),
        substates=substates,
    )