import json
from dataclasses import FrozenInstanceError
from pathlib import Path

import pytest

from cc_patch.models import (
    ERROR_EXIT_CODES,
    BinaryProbe,
    FeatureStatus,
    SnapshotInfo,
    WriteOutcome,
)


def test_feature_status_fields_and_frozen_contract():
    status = FeatureStatus("channels", "clean", ["one site"], 1)
    assert status.slug == "channels"
    assert status.state == "clean"
    assert status.details == ["one site"]
    assert status.sites == 1
    with pytest.raises(FrozenInstanceError):
        status.sites = 2


def test_binary_probe_fields_and_frozen_contract():
    feature = FeatureStatus("source-exec", "patched", [], 1)
    probe = BinaryProbe(
        Path("/tmp/claude"),
        "2.1.175",
        {"source-exec": feature},
        250_085_376,
        True,
    )
    assert probe.path == Path("/tmp/claude")
    assert probe.version == "2.1.175"
    assert probe.features == {"source-exec": feature}
    assert probe.size_bytes == 250_085_376
    assert probe.has_baseline is True
    with pytest.raises(FrozenInstanceError):
        probe.version = "2.1.176"


def test_binary_probe_preserves_unreadable_binary_error_state():
    probe = BinaryProbe(
        Path("/tmp/unreadable-claude"),
        None,
        {},
        0,
        False,
        {"message": "unreadable"},
    )
    assert probe.probe_error == {"message": "unreadable"}
    assert probe.features == {}


def test_error_catalog_exactly_matches_complete_frozen_vector():
    vector_path = Path(__file__).parents[3] / "contract" / "vectors" / "error-codes-v1.json"
    vector = json.loads(vector_path.read_text(encoding="utf-8"))
    expected = [
        {"code": "store_version_unsupported", "exit_code": 1, "meaning": "The store protocol version is not supported."},
        {"code": "target_identity_mismatch", "exit_code": 2, "meaning": "Target metadata does not match the canonical path identity."},
        {"code": "target_locked", "exit_code": 1, "meaning": "Another writer holds the target lock."},
        {"code": "baseline_not_found", "exit_code": 1, "meaning": "No matching baseline exists and one cannot be created."},
        {"code": "channels_patched_no_baseline", "exit_code": 1, "meaning": "The irreversible channels feature is patched without a clean baseline."},
        {"code": "unsupported_or_mixed_no_baseline", "exit_code": 1, "meaning": "A trusted baseline cannot be created from the incoming state."},
        {"code": "version_probe_failed", "exit_code": 1, "meaning": "The embedded version cannot be extracted."},
        {"code": "baseline_conflict", "exit_code": 2, "meaning": "A different baseline is already active for this target and version."},
        {"code": "baseline_invalid", "exit_code": 2, "meaning": "The baseline manifest or content failed self-validation."},
        {"code": "baseline_stale_build", "exit_code": 2, "meaning": "The current binary and baseline do not share the same build lineage."},
        {"code": "snapshot_exists", "exit_code": 1, "meaning": "A snapshot already exists for this target, version, and slug."},
        {"code": "snapshot_not_found", "exit_code": 1, "meaning": "The requested snapshot does not exist."},
        {"code": "snapshot_ambiguous", "exit_code": 1, "meaning": "The snapshot slug exists across versions and cannot be selected implicitly."},
        {"code": "snapshot_invalid", "exit_code": 2, "meaning": "The snapshot manifest or content failed validation."},
        {"code": "concurrent_binary_change", "exit_code": 1, "meaning": "The binary changed during the transaction."},
        {"code": "content_mismatch", "exit_code": 2, "meaning": "Written bytes or feature postconditions do not match the expected result."},
        {"code": "rollback_failed", "exit_code": 2, "meaning": "The transaction entry bytes could not be restored after failure."},
        {"code": "binary_in_use", "exit_code": 3, "meaning": "The binary is in use and cannot be atomically replaced."},
        {"code": "codesign_failed", "exit_code": 3, "meaning": "macOS ad-hoc code signing failed."},
        {"code": "platform_write_unsupported", "exit_code": 1, "meaning": "The current platform is not a supported production write target."},
        {"code": "platform_write_disabled", "exit_code": 1, "meaning": "The production write gate is not enabled for the current platform."},
    ]

    assert vector == {"schema_version": 1, "errors": expected}
    assert ERROR_EXIT_CODES == {entry["code"]: entry["exit_code"] for entry in expected}


def test_snapshot_info_fields_and_frozen_contract():
    from datetime import UTC, datetime

    created = datetime(2026, 7, 13, tzinfo=UTC)
    info = SnapshotInfo(Path("/tmp/test.ccsnap"), "2.1.207", "before-test", created, False, False)
    assert info.slug == "before-test"
    assert info.created_at == created
    assert info.is_stale is False
    assert info.invalid is False
    with pytest.raises(FrozenInstanceError):
        info.slug = "other"


def test_write_outcome_fields_and_frozen_contract():
    outcome = WriteOutcome(Path("/tmp/claude"), ["source-exec", "channels"], 9, True)
    assert outcome.binary == Path("/tmp/claude")
    assert outcome.applied == ["source-exec", "channels"]
    assert outcome.edits == 9
    assert outcome.resigned is True
    with pytest.raises(FrozenInstanceError):
        outcome.edits = 0
