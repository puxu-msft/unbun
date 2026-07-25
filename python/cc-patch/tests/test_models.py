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


def test_error_exit_catalog_exactly_matches_frozen_vector():
    vector_path = Path(__file__).parents[3] / "contract" / "vectors" / "error-codes-v1.json"
    vector = json.loads(vector_path.read_text(encoding="utf-8"))

    assert vector["schema_version"] == 1
    expected = {entry["code"]: entry["exit_code"] for entry in vector["errors"]}
    assert len(expected) == 19
    assert ERROR_EXIT_CODES == expected


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
