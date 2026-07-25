from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Literal


SubstateState = Literal["clean", "patched", "absent", "unsupported"]

ERROR_EXIT_CODES = {
    "store_version_unsupported": 1,
    "target_identity_mismatch": 2,
    "target_locked": 1,
    "baseline_not_found": 1,
    "channels_patched_no_baseline": 1,
    "unsupported_or_mixed_no_baseline": 1,
    "version_probe_failed": 1,
    "baseline_conflict": 2,
    "baseline_invalid": 2,
    "baseline_stale_build": 2,
    "snapshot_exists": 1,
    "snapshot_not_found": 1,
    "snapshot_ambiguous": 1,
    "snapshot_invalid": 2,
    "concurrent_binary_change": 1,
    "content_mismatch": 2,
    "rollback_failed": 2,
    "binary_in_use": 3,
    "codesign_failed": 3,
}


@dataclass(frozen=True)
class FeatureSubstate:
    identity: str
    offset: int
    length: int
    state: SubstateState
    detail_code: str | None = None
    essential: bool = True


@dataclass(frozen=True)
class ProbeSlice:
    offset: int
    data: bytes


@dataclass(frozen=True)
class FeatureStatus:
    slug: str
    state: Literal["clean", "patched", "mixed", "unsupported"]
    details: list[str]
    sites: int
    substates: tuple[FeatureSubstate, ...] = ()
    detail_codes: tuple[str, ...] = ()


@dataclass(frozen=True)
class BinaryProbe:
    path: Path
    version: str | None
    features: dict[str, FeatureStatus]
    size_bytes: int
    has_baseline: bool
    probe_error: dict[str, object] | None = None


@dataclass(frozen=True)
class CliError:
    code: str
    message: str
    binary: Path | None = None
    feature: str | None = None
    details: dict[str, object] | None = None

    def __post_init__(self) -> None:
        if self.code not in ERROR_EXIT_CODES:
            raise ValueError(f"Unknown CLI error code: {self.code}")


@dataclass(frozen=True)
class SnapshotInfo:
    path: Path
    version: str
    slug: str
    created_at: datetime
    is_stale: bool
    invalid: bool


@dataclass(frozen=True)
class WriteOutcome:
    binary: Path
    applied: list[str]
    edits: int
    resigned: bool
