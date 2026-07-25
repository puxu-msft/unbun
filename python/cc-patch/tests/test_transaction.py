import hashlib
import json
from pathlib import Path

import pytest

from cc_patch import atomicio, orchestrate, transaction
from cc_patch.features import REGISTRY, resolve_closure
from cc_patch.store import ContentInspection, StoreError, StoreV1


@pytest.fixture
def binary(tmp_path):
    path = tmp_path / "versions" / "claude"
    path.parent.mkdir()
    path.write_bytes(b"entry")
    path.chmod(0o751)
    return path


@pytest.fixture
def store(tmp_path):
    return StoreV1(
        tmp_path / "store",
        inspect_content=lambda _data: ContentInspection(None, {}),
    )


def test_commit_orders_pre_replace_proof_before_replace(monkeypatch, binary, store):
    identity = store.identity_for(binary)
    events = []
    real_replace = atomicio._replace_atomic_temp

    def recording_replace(target, temp):
        events.append("replace")
        real_replace(target, temp)

    monkeypatch.setattr(atomicio, "_replace_atomic_temp", recording_replace)

    transaction.commit(
        binary,
        b"result",
        b"entry",
        store=store,
        path_key=identity.path_key,
        verify_before_replace=lambda observed: events.append(("proof", observed)),
        verify_committed=lambda observed, signed: events.append(
            ("verify", observed, signed)
        ),
    )

    assert events == [
        ("proof", b"entry"),
        "replace",
        ("verify", b"result", False),
    ]


def test_commit_rolls_back_exact_entry_and_maps_content_mismatch(
    monkeypatch, binary, store
):
    identity = store.identity_for(binary)

    with pytest.raises(StoreError) as caught:
        transaction.commit(
            binary,
            b"result",
            b"entry",
            store=store,
            path_key=identity.path_key,
            verify_before_replace=lambda _observed: None,
            verify_committed=lambda _observed, _signed: (_ for _ in ()).throw(
                ValueError("bad post-write bytes")
            ),
        )

    assert (caught.value.code, caught.value.exit_code) == ("content_mismatch", 2)
    assert binary.read_bytes() == b"entry"


def test_rollback_failure_preserves_diagnostic_quarantine(
    monkeypatch, binary, store
):
    identity = store.identity_for(binary)
    monkeypatch.setattr(
        transaction.atomicio,
        "atomic_write",
        lambda *_args: (_ for _ in ()).throw(OSError("restore failed")),
    )

    with pytest.raises(StoreError) as caught:
        transaction.commit(
            binary,
            b"result",
            b"entry",
            store=store,
            path_key=identity.path_key,
            verify_before_replace=lambda _observed: None,
            verify_committed=lambda _observed, _signed: (_ for _ in ()).throw(
                ValueError("verification failed")
            ),
        )

    assert (caught.value.code, caught.value.exit_code) == ("rollback_failed", 2)
    quarantines = list(
        (store.target_dir(identity.path_key) / "quarantine").glob(
            "*/quarantine.json"
        )
    )
    assert len(quarantines) == 1
    assert (quarantines[0].parent / "artifact").read_bytes() == b"entry"


def test_binary_in_use_quarantine_publish_failure_restores_ready_temp(
    monkeypatch, binary, store
):
    identity = store.identity_for(binary)
    ready_temp = binary.parent / ".claude.tmp.ready"
    ready_temp.write_bytes(b"result")
    real_publish = store._publish_no_clobber

    def fail_quarantine_manifest(temp, final):
        if final.name == "quarantine.json":
            raise OSError("quarantine manifest publish failed")
        return real_publish(temp, final)

    monkeypatch.setattr(store, "_publish_no_clobber", fail_quarantine_manifest)

    with pytest.raises(OSError, match="quarantine manifest publish failed"):
        store.quarantine_ready_temp(
            identity.path_key,
            ready_temp,
            discovered_by="python",
        )

    assert ready_temp.read_bytes() == b"result"
    quarantine_root = store.target_dir(identity.path_key) / "quarantine"
    assert list(quarantine_root.glob("*/artifact")) == []


TRANSACTION_VECTORS = json.loads(
    (Path(__file__).parents[3] / "contract/vectors/transaction-v1.json").read_text(
        encoding="utf-8"
    )
)["scenarios"]


def replay(clean: bytes, selected: list[str]) -> bytes:
    data = bytearray(clean)
    for slug in resolve_closure(selected):
        REGISTRY[slug].apply(data)
    return bytes(data)


@pytest.mark.parametrize("scenario", TRANSACTION_VECTORS, ids=lambda item: item["id"])
def test_frozen_transaction_scenarios(
    scenario, monkeypatch, tmp_path, make_bundle
):
    clean = bytes(make_bundle())
    path = tmp_path / "versions" / "claude"
    path.parent.mkdir()
    entry = replay(clean, scenario["entry_features"])
    path.write_bytes(entry)
    store = StoreV1(
        tmp_path / "store",
        inspect_content=lambda data: ContentInspection(
            orchestrate.extract_version(data),
            {slug: feature.detect(data).state for slug, feature in REGISTRY.items()},
        ),
    )
    monkeypatch.setattr(orchestrate, "STORE", store)
    digest = scenario.get("entry_digest", hashlib.sha256(entry).hexdigest())
    temp_preparations = []
    real_prepare = atomicio._prepare_atomic_temp

    def recording_prepare(target, data):
        temp_preparations.append((target, data))
        return real_prepare(target, data)

    monkeypatch.setattr(atomicio, "_prepare_atomic_temp", recording_prepare)

    if "expected_error" not in scenario:
        identity = store.identity_for(path)
        store.ensure_target(identity)
        store.publish_baseline(
            identity.path_key,
            "2.1.175",
            clean,
            orchestrate._baseline_manifest(identity.path_key, clean, "2.1.175"),
        )

    if "expected_error" in scenario:
        with pytest.raises(StoreError) as caught:
            orchestrate.write_features(
                path,
                scenario["requested_features"],
                entry_digest=digest,
            )
        assert caught.value.code == scenario["expected_error"]
        assert path.read_bytes() == entry
        return

    outcome = orchestrate.write_features(
        path,
        scenario["requested_features"],
        entry_digest=digest,
    )

    assert path.read_bytes() == replay(clean, scenario["expected_features"])
    assert outcome.applied == scenario["expected_features"]
    assert outcome.edits == scenario["expected_edits"]
    assert bool(temp_preparations) is scenario["expected_write"]