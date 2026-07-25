import os
from pathlib import Path

import pytest

from cc_patch import atomicio, orchestrate, snapshots, transaction
from cc_patch.features import REGISTRY, resolve_closure
from cc_patch.lineage import LineageError, PlatformGate
from cc_patch.store import ContentInspection, StoreError, StoreV1


def replay(clean: bytes, selected: list[str]) -> bytes:
    data = bytearray(clean)
    for slug in resolve_closure(selected):
        REGISTRY[slug].apply(data)
    return bytes(data)


def enabled_macos_gate() -> PlatformGate:
    return PlatformGate(
        platform="macos",
        format="macho",
        lineage_algorithm="claude-v1-exact-replay",
        capabilities={"production_write_gate": {"status": "enabled"}},
        production_write_gate={"status": "enabled"},
    )


def establish_baseline(store: StoreV1, binary: Path, clean: bytes, version: str = "2.1.175"):
    identity = store.identity_for(binary)
    store.ensure_target(identity)
    store.publish_baseline(
        identity.path_key,
        version,
        clean,
        orchestrate._baseline_manifest(identity.path_key, clean, version),
    )
    return store.read_active_baseline(identity.path_key, version)


@pytest.fixture(autouse=True)
def isolated_backups(monkeypatch, tmp_path):
    monkeypatch.setattr(atomicio, "BACKUP_DIR", tmp_path / "backups")


@pytest.fixture(autouse=True)
def shared_store(monkeypatch, tmp_path):
    store = StoreV1(
        tmp_path / "store",
        inspect_content=lambda data: ContentInspection(
            orchestrate.extract_version(data),
            {slug: feature.detect(data).state for slug, feature in REGISTRY.items()},
        ),
    )
    monkeypatch.setattr(orchestrate, "STORE", store)
    return store


@pytest.fixture
def binary(tmp_path, make_bundle):
    path = tmp_path / "versions" / "claude"
    path.parent.mkdir()
    clean = bytes(make_bundle())
    path.write_bytes(clean)
    return path, clean


def test_write_features_replays_effective_dependency_closure_from_clean_baseline(binary):
    path, clean = binary

    outcome = orchestrate.write_features(path, ["agent-model"], current_data=clean)

    expected = replay(clean, ["agent-model"])
    assert path.read_bytes() == expected
    assert outcome.applied == ["agent-model"]
    assert {slug: REGISTRY[slug].detect(expected).state for slug in REGISTRY} == {
        "source-exec": "clean",
        "agent-model": "patched",
        "channels": "clean",
    }


def test_agent_model_is_allowed_without_source_but_channels_dependency_is_rejected(
    monkeypatch, binary, shared_store
):
    path, clean = binary
    establish_baseline(shared_store, path, clean)
    agent_only = replay(clean, ["agent-model"])
    path.write_bytes(agent_only)

    outcome = orchestrate.write_features(
        path,
        ["agent-model"],
        current_data=agent_only,
    )

    assert outcome.applied == ["agent-model"]
    assert path.read_bytes() == agent_only

    channels = replay(clean, ["channels"])
    path.write_bytes(channels)
    writes = []
    monkeypatch.setattr(
        transaction,
        "commit",
        lambda *_args, **_kwargs: writes.append(True),
    )

    with pytest.raises(orchestrate.DependentFeatureStillEnabled) as caught:
        orchestrate.write_features(path, ["channels"], current_data=channels)

    assert caught.value.feature == "source-exec"
    assert writes == []
    assert path.read_bytes() == channels


def test_dependent_revert_is_rejected_before_version_or_baseline_and_never_writes(monkeypatch, binary, shared_store):
    path, clean = binary
    current = replay(clean, ["channels"])
    current = current.replace(b'VERSION:"2.1.175"', b'VERSION:"2.1.176"')
    path.write_bytes(current)
    establish_baseline(shared_store, path, clean)
    writes = []
    monkeypatch.setattr(transaction, "commit", lambda *_args, **_kwargs: writes.append(_args))

    with pytest.raises(orchestrate.DependentFeatureStillEnabled) as caught:
        orchestrate.write_features(path, ["channels"], current_data=current)

    assert caught.value.feature == "source-exec"
    assert caught.value.dependants == ["channels"]
    assert writes == []
    assert path.read_bytes() == current


def test_revert_channels_uses_clean_baseline_instead_of_in_place_reverse(binary, shared_store):
    path, clean = binary
    establish_baseline(shared_store, path, clean)
    current = replay(clean, ["source-exec", "agent-model", "channels"])
    path.write_bytes(current)

    orchestrate.write_features(
        path,
        ["source-exec", "agent-model"],
        current_data=current,
    )

    expected = replay(clean, ["source-exec", "agent-model"])
    assert path.read_bytes() == expected
    decision_start = clean.find(b"function x7$")
    assert path.read_bytes()[decision_start:] == clean[decision_start:]
    assert REGISTRY["channels"].detect(path.read_bytes()).state == "clean"


def test_revert_all_is_bit_exact_clean_baseline(binary, shared_store):
    path, clean = binary
    establish_baseline(shared_store, path, clean)
    current = replay(clean, list(REGISTRY))
    path.write_bytes(current)

    outcome = orchestrate.write_features(path, [], current_data=current)

    assert path.read_bytes() == clean
    assert outcome.applied == []


def test_baseline_with_mismatched_embedded_version_is_rejected_without_writing(binary, shared_store):
    path, clean = binary
    asset = establish_baseline(shared_store, path, clean)
    asset.blob_path.write_bytes(clean.replace(b'VERSION:"2.1.175"', b'VERSION:"2.1.174"'))

    with pytest.raises(StoreError) as caught:
        orchestrate.write_features(path, ["agent-model"], current_data=clean)

    assert caught.value.code == "baseline_invalid"
    assert path.read_bytes() == clean


def test_patched_baseline_is_rejected_without_writing(binary, shared_store):
    path, clean = binary
    asset = establish_baseline(shared_store, path, clean)
    patched = replay(clean, ["source-exec"])
    asset.blob_path.write_bytes(patched)
    manifest = asset.manifest
    manifest["sha256"] = orchestrate.hashlib.sha256(patched).hexdigest()
    manifest["size"] = len(patched)
    asset.manifest_path.write_bytes(shared_store._encode_manifest(manifest))

    with pytest.raises(StoreError) as caught:
        orchestrate.write_features(path, ["agent-model"], current_data=clean)

    assert caught.value.code == "baseline_invalid"
    assert path.read_bytes() == clean


def test_same_path_version_different_build_is_rejected_without_writing(binary, shared_store):
    path, clean = binary
    establish_baseline(shared_store, path, clean)
    current = replay(clean, ["source-exec"]).replace(b"agentTool=", b"otherTool=")
    path.write_bytes(current)

    with pytest.raises(LineageError) as caught:
        orchestrate.write_features(path, ["source-exec"], current_data=current)

    assert caught.value.code == "baseline_stale_build"
    assert path.read_bytes() == current


def test_version_probe_failure_is_rejected_without_orphan_baseline(binary):
    path, clean = binary
    current = clean.replace(b'overview",VERSION:"2.1.175"', b'overview",RELEASE:"2.1.175"')
    path.write_bytes(current)

    with pytest.raises(orchestrate.NoBaselineRejected) as caught:
        orchestrate.write_features(path, ["source-exec"], current_data=current)

    assert caught.value.reason == orchestrate.NoBaselineReason.VERSION_PROBE_FAILED
    assert path.read_bytes() == current
    assert not atomicio.BACKUP_DIR.exists()


def test_channels_patched_without_baseline_is_rejected_without_writing(binary):
    path, clean = binary
    current = replay(clean, ["source-exec", "channels"])
    path.write_bytes(current)

    with pytest.raises(orchestrate.NoBaselineRejected) as caught:
        orchestrate.write_features(path, list(REGISTRY), current_data=current)

    assert caught.value.reason == orchestrate.NoBaselineReason.CHANNELS_PATCHED_NO_BASELINE
    assert (caught.value.code, caught.value.exit_code) == (
        "channels_patched_no_baseline",
        1,
    )
    assert path.read_bytes() == current
    assert atomicio.find_baseline(path, "2.1.175") is None


@pytest.mark.parametrize("legacy_suffix", [".ccbak", ".agentbak", ".channels.bak"])
def test_legacy_backups_are_ignored_when_channels_is_patched_without_v1_baseline(
    binary, legacy_suffix, shared_store
):
    path, clean = binary
    current = replay(clean, ["source-exec", "channels"])
    path.write_bytes(current)
    path.with_name(path.name + legacy_suffix).write_bytes(clean)

    with pytest.raises(orchestrate.NoBaselineRejected) as caught:
        orchestrate.write_features(path, list(REGISTRY), current_data=current)

    identity = shared_store.identity_for(path)
    assert caught.value.reason == orchestrate.NoBaselineReason.CHANNELS_PATCHED_NO_BASELINE
    assert path.read_bytes() == current
    assert shared_store.find_active_baseline(identity.path_key, "2.1.175") is None


def test_clean_current_publishes_shared_store_baseline(binary, shared_store):
    path, clean = binary

    orchestrate.write_features(path, ["agent-model"], current_data=clean)

    identity = shared_store.identity_for(path)
    asset = shared_store.read_active_baseline(identity.path_key, "2.1.175")
    assert asset.data == clean
    assert asset.manifest["states"] == {slug: "clean" for slug in REGISTRY}
    assert not atomicio.BACKUP_DIR.exists()


def test_target_lock_covers_baseline_publication_and_binary_replace(
    monkeypatch, binary, shared_store
):
    path, clean = binary
    identity = shared_store.identity_for(path)
    lock_owner = shared_store.target_dir(identity.path_key) / "write.lock/owner.json"
    observations = []
    real_publish = shared_store.publish_baseline
    real_replace = atomicio._replace_atomic_temp

    def checked_publish(*args, **kwargs):
        observations.append(("baseline", lock_owner.is_file()))
        return real_publish(*args, **kwargs)

    def checked_replace(target, temp):
        observations.append(("replace", lock_owner.is_file()))
        return real_replace(target, temp)

    monkeypatch.setattr(shared_store, "publish_baseline", checked_publish)
    monkeypatch.setattr(atomicio, "_replace_atomic_temp", checked_replace)

    orchestrate.write_features(path, ["agent-model"], current_data=clean)

    assert observations == [("baseline", True), ("replace", True)]
    assert not lock_owner.parent.exists()


def test_reversible_patches_rebuild_clean_baseline_with_round_trip_gate(binary, shared_store):
    path, clean = binary
    current = replay(clean, ["source-exec", "agent-model"])
    path.write_bytes(current)

    outcome = orchestrate.write_features(
        path,
        ["source-exec", "agent-model"],
        current_data=current,
    )

    identity = shared_store.identity_for(path)
    baseline = shared_store.read_active_baseline(identity.path_key, "2.1.175")
    assert baseline.data == clean
    assert path.read_bytes() == current
    assert outcome.edits == 0


def test_reversible_rebuild_replays_only_patched_features_when_dependency_is_clean(
    monkeypatch, binary, shared_store
):
    path, clean = binary
    current = replay(clean, ["agent-model"])
    path.write_bytes(current)
    monkeypatch.setattr(REGISTRY["agent-model"], "requires", ["source-exec"])

    orchestrate.write_features(path, ["agent-model"], current_data=current)

    identity = shared_store.identity_for(path)
    assert shared_store.read_active_baseline(identity.path_key, "2.1.175").data == clean
    assert path.read_bytes() == replay(clean, ["source-exec", "agent-model"])


def test_failed_rebuild_substate_replay_is_rejected_without_writing(monkeypatch, binary, shared_store):
    path, clean = binary
    current = replay(clean, ["source-exec", "agent-model"])
    path.write_bytes(current)
    original_replay = REGISTRY["agent-model"].replay_substates

    def fail_forward_replay(data, substates, target_state=None):
        if target_state == "clean":
            return original_replay(data, substates, target_state)
        return 0

    monkeypatch.setattr(
        REGISTRY["agent-model"],
        "replay_substates",
        fail_forward_replay,
    )

    with pytest.raises(orchestrate.NoBaselineRejected) as caught:
        orchestrate.write_features(path, ["source-exec", "agent-model"], current_data=current)

    assert caught.value.reason == orchestrate.NoBaselineReason.REBUILD_ROUNDTRIP_FAILED
    assert (caught.value.code, caught.value.exit_code) == (
        "unsupported_or_mixed_no_baseline",
        1,
    )
    assert path.read_bytes() == current
    identity = shared_store.identity_for(path)
    assert shared_store.find_active_baseline(identity.path_key, "2.1.175") is None


def test_unsupported_without_baseline_is_rejected_without_writing(binary):
    path, clean = binary
    # 破坏 agent-model 的枚举 core（保留 describe 后缀），令其既非 clean 也非 patched → unsupported。
    current = clean.replace(b'"fable"])', b'"xxxxx"])')
    path.write_bytes(current)

    with pytest.raises(orchestrate.NoBaselineRejected) as caught:
        orchestrate.write_features(path, ["source-exec"], current_data=current)

    assert caught.value.reason == orchestrate.NoBaselineReason.UNSUPPORTED_OR_MIXED_NO_BASELINE
    assert path.read_bytes() == current
    assert atomicio.find_baseline(path, "2.1.175") is None


def test_mixed_without_baseline_is_rejected_without_writing(tmp_path, make_bundle):
    path = tmp_path / "versions" / "claude"
    path.parent.mkdir()
    clean = bytes(make_bundle()) + bytes(make_bundle())
    current = bytearray(clean)
    marker = b"@bytecode"
    first = current.find(marker)
    current[first : first + len(marker)] = b"@source__"
    current = bytes(current)
    path.write_bytes(current)

    with pytest.raises(orchestrate.NoBaselineRejected) as caught:
        orchestrate.write_features(path, ["source-exec"], current_data=current)

    assert caught.value.reason == orchestrate.NoBaselineReason.UNSUPPORTED_OR_MIXED_NO_BASELINE
    assert path.read_bytes() == current
    assert atomicio.find_baseline(path, "2.1.175") is None


def test_replayable_mixed_with_baseline_passes_exact_replay_and_self_heals(
    monkeypatch, tmp_path, make_bundle, shared_store
):
    path = tmp_path / "versions" / "claude"
    path.parent.mkdir()
    clean = bytes(make_bundle()) + bytes(make_bundle())
    path.write_bytes(clean)
    establish_baseline(shared_store, path, clean)
    current = bytearray(clean)
    marker = b"@bytecode"
    first = current.find(marker)
    current[first : first + len(marker)] = b"@source__"
    current = bytes(current)
    path.write_bytes(current)
    proofs = []
    original_prove = orchestrate.prove_exact_replay

    def record_proof(*args, **kwargs):
        proof = original_prove(*args, **kwargs)
        proofs.append(proof)
        return proof

    monkeypatch.setattr(orchestrate, "prove_exact_replay", record_proof)

    orchestrate.write_features(path, list(REGISTRY), current_data=current)

    assert proofs and all(proof.byte_equal for proof in proofs)
    assert path.read_bytes() == replay(clean, list(REGISTRY))


def test_revert_one_feature_preserves_other_feature_states(binary, shared_store):
    path, clean = binary
    establish_baseline(shared_store, path, clean)
    current = replay(clean, list(REGISTRY))
    before = {slug: feature.detect(current).state for slug, feature in REGISTRY.items()}
    path.write_bytes(current)

    orchestrate.write_features(
        path,
        ["source-exec", "channels"],
        current_data=current,
    )

    result = path.read_bytes()
    after = {slug: feature.detect(result).state for slug, feature in REGISTRY.items()}
    assert after["agent-model"] == "clean"
    assert after["source-exec"] == before["source-exec"]
    assert after["channels"] == before["channels"]


def test_idempotent_target_checks_disk_again_before_returning(monkeypatch, binary, shared_store):
    path, clean = binary
    establish_baseline(shared_store, path, clean)
    current = replay(clean, ["agent-model"])
    upgraded = current.replace(b'VERSION:"2.1.175"', b'VERSION:"2.1.176"')
    path.write_bytes(current)
    original_read_bytes = Path.read_bytes
    real_assert_unchanged = orchestrate._assert_binary_unchanged

    def upgrade_before_no_write_check(target, expected):
        target.write_bytes(upgraded)
        real_assert_unchanged(target, expected)

    monkeypatch.setattr(orchestrate, "_assert_binary_unchanged", upgrade_before_no_write_check)

    with pytest.raises(StoreError) as caught:
        orchestrate.write_features(
            path, ["source-exec", "agent-model"], current_data=current
        )

    assert (caught.value.code, caught.value.exit_code) == (
        "concurrent_binary_change",
        1,
    )
    assert original_read_bytes(path) == upgraded


def test_idempotent_target_skips_atomic_write(monkeypatch, binary, shared_store):
    path, clean = binary
    establish_baseline(shared_store, path, clean)
    current = replay(clean, ["agent-model"])
    path.write_bytes(current)
    writes = []
    monkeypatch.setattr(transaction, "commit", lambda *_args, **_kwargs: writes.append(_args))

    outcome = orchestrate.write_features(
        path, ["agent-model"], current_data=current
    )

    assert writes == []
    assert outcome.edits == 0
    assert path.read_bytes() == current


def test_write_features_rejects_stale_caller_snapshot_before_guards(binary):
    path, clean = binary
    current = replay(clean, ["agent-model"])
    path.write_bytes(current)

    with pytest.raises(StoreError) as caught:
        orchestrate.write_features(path, ["agent-model"], current_data=clean)

    assert (caught.value.code, caught.value.exit_code) == (
        "concurrent_binary_change",
        1,
    )
    assert path.read_bytes() == current


def test_binary_change_before_locked_baseline_work_creates_no_active_baseline(
    monkeypatch, binary, shared_store
):
    path, clean = binary
    upgraded = clean.replace(b'VERSION:"2.1.175"', b'VERSION:"2.1.176"')
    original_read_bytes = Path.read_bytes
    writes = []
    real_baseline_for_write = orchestrate._baseline_for_write

    def upgrade_before_baseline(*args, **kwargs):
        path.write_bytes(upgraded)
        return real_baseline_for_write(*args, **kwargs)

    monkeypatch.setattr(orchestrate, "_baseline_for_write", upgrade_before_baseline)
    monkeypatch.setattr(transaction, "commit", lambda *_args, **_kwargs: writes.append(_args))

    with pytest.raises(StoreError) as caught:
        orchestrate.write_features(path, ["agent-model"], current_data=clean)

    assert (caught.value.code, caught.value.exit_code) == (
        "concurrent_binary_change",
        1,
    )
    assert writes == []
    assert original_read_bytes(path) == upgraded
    identity = shared_store.identity_for(path)
    assert shared_store.find_active_baseline(identity.path_key, "2.1.175") is None


def test_binary_change_after_baseline_publish_quarantines_activation_manifest(
    monkeypatch, binary, shared_store
):
    path, clean = binary
    upgraded = clean.replace(b'VERSION:"2.1.175"', b'VERSION:"2.1.176"')
    original_read_bytes = Path.read_bytes
    real_publish = shared_store.publish_baseline

    def upgrade_after_publish(*args, **kwargs):
        result = real_publish(*args, **kwargs)
        path.write_bytes(upgraded)
        return result

    monkeypatch.setattr(shared_store, "publish_baseline", upgrade_after_publish)

    with pytest.raises(StoreError) as caught:
        orchestrate.write_features(path, ["agent-model"], current_data=clean)

    assert (caught.value.code, caught.value.exit_code) == (
        "concurrent_binary_change",
        1,
    )
    assert original_read_bytes(path) == upgraded
    identity = shared_store.identity_for(path)
    assert shared_store.find_active_baseline(identity.path_key, "2.1.175") is None
    target_dir = shared_store.target_dir(identity.path_key)
    quarantine = list((target_dir / "quarantine").glob("*/quarantine.json"))
    blobs = list((target_dir / "baselines/2.1.175/blobs").glob("*.ccbak"))
    assert len(quarantine) == 1
    assert len(blobs) == 1


def test_baseline_is_published_before_binary_exchange_failure(monkeypatch, binary, shared_store):
    path, clean = binary

    def reject_write(*_args, **_kwargs):
        raise OSError("exchange failed")

    monkeypatch.setattr(transaction, "commit", reject_write)

    with pytest.raises(OSError, match="exchange failed"):
        orchestrate.write_features(path, list(REGISTRY), current_data=clean)

    identity = shared_store.identity_for(path)
    baseline = shared_store.read_active_baseline(identity.path_key, "2.1.175")
    assert baseline.data == clean
    assert path.read_bytes() == clean


def test_baseline_manifest_directory_fsync_failure_leaves_no_active_and_retry_republishes(
    monkeypatch, binary, shared_store
):
    path, clean = binary
    identity = shared_store.identity_for(path)
    real_fsync = shared_store.durability.fsync_directory
    failed = False
    binary_writes = []
    real_commit = transaction.commit

    def fail_once_on_manifest(directory):
        nonlocal failed
        if not failed and (directory / "baseline.json").exists():
            failed = True
            raise OSError("injected baseline manifest fsync failure")
        return real_fsync(directory)

    monkeypatch.setattr(shared_store.durability, "fsync_directory", fail_once_on_manifest)
    monkeypatch.setattr(
        transaction,
        "commit",
        lambda *args, **kwargs: binary_writes.append(True)
        or real_commit(*args, **kwargs),
    )

    with pytest.raises(StoreError) as raised:
        orchestrate.write_features(path, ["agent-model"], current_data=clean)

    assert raised.value.code == "store_integrity_error"
    assert shared_store.find_active_baseline(identity.path_key, "2.1.175") is None
    assert binary_writes == []
    assert path.read_bytes() == clean

    outcome = orchestrate.write_features(path, ["agent-model"], current_data=clean)

    assert outcome.applied == ["agent-model"]
    assert shared_store.find_active_baseline(identity.path_key, "2.1.175") is not None
    assert path.read_bytes() == replay(clean, ["agent-model"])


def test_baseline_publish_failure_never_prepares_or_replaces_binary(
    monkeypatch, binary, shared_store
):
    path, clean = binary
    binary_writes = []
    monkeypatch.setattr(
        shared_store,
        "publish_baseline",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            OSError("baseline publish failed")
        ),
    )
    monkeypatch.setattr(
        atomicio,
        "_prepare_atomic_temp",
        lambda *_args, **_kwargs: binary_writes.append(True),
    )

    with pytest.raises(OSError, match="baseline publish failed"):
        orchestrate.write_features(path, ["agent-model"], current_data=clean)

    assert binary_writes == []
    assert path.read_bytes() == clean


def test_binary_in_use_moves_verified_ready_temp_to_target_quarantine(
    monkeypatch, binary, shared_store
):
    path, clean = binary
    establish_baseline(shared_store, path, clean)
    expected = replay(clean, ["agent-model"])
    real_replace = os.replace

    monkeypatch.setattr(
        os,
        "replace",
        lambda source, target: (_ for _ in ()).throw(PermissionError("in use"))
        if Path(target) == path
        else real_replace(source, target),
    )

    with pytest.raises(StoreError) as caught:
        orchestrate.write_features(path, ["agent-model"], current_data=clean)

    assert caught.value.code == "binary_in_use"
    assert caught.value.exit_code == 3
    assert path.read_bytes() == clean
    assert list(path.parent.glob(f".{path.name}.tmp.*")) == []
    identity = shared_store.identity_for(path)
    quarantines = list(
        (shared_store.target_dir(identity.path_key) / "quarantine").glob(
            "*/quarantine.json"
        )
    )
    assert len(quarantines) == 1
    assert (quarantines[0].parent / "artifact").read_bytes() == expected


def test_successful_write_resigns_after_post_write_verification(monkeypatch, binary, shared_store):
    path, clean = binary
    path.chmod(0o755)
    establish_baseline(shared_store, path, clean)
    events = []
    real_atomic_write = transaction.atomicio.atomic_write_if_unchanged

    def recording_write(target, data, expected, **kwargs):
        events.append("write")
        real_atomic_write(target, data, expected, **kwargs)

    def recording_resign(target, log):
        assert target.read_bytes() == replay(clean, ["agent-model"])
        events.append("resign")

    monkeypatch.setattr(transaction.atomicio, "atomic_write_if_unchanged", recording_write)
    monkeypatch.setattr(orchestrate, "maybe_resign_macos", recording_resign)
    monkeypatch.setattr(orchestrate.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(orchestrate, "_resolve_write_gate", enabled_macos_gate)

    outcome = orchestrate.write_features(path, ["agent-model"], current_data=clean)

    assert events == ["write", "resign"]
    assert outcome.resigned is True


def test_macos_revalidates_version_features_lineage_and_executable_after_codesign(
    monkeypatch, binary, shared_store
):
    path, clean = binary
    path.chmod(0o755)
    establish_baseline(shared_store, path, clean)
    expected = replay(clean, ["agent-model"])
    validations = []

    monkeypatch.setattr(orchestrate.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(orchestrate, "_resolve_write_gate", enabled_macos_gate)
    monkeypatch.setattr(
        orchestrate,
        "maybe_resign_macos",
        lambda target, _log: target.write_bytes(expected + b"signature"),
    )
    monkeypatch.setattr(
        orchestrate,
        "MACOS_NORMALIZE",
        lambda data: data.removesuffix(b"signature"),
    )
    monkeypatch.setattr(
        orchestrate,
        "MACOS_EXECUTABLE_CHECK",
        lambda target: validations.append(target) or True,
    )

    outcome = orchestrate.write_features(path, ["agent-model"], current_data=clean)

    assert path.read_bytes() == expected + b"signature"
    assert validations == [path]
    assert outcome.resigned is True


def test_macos_baseline_manifest_and_lineage_proofs_share_normalization(
    monkeypatch, binary, shared_store
):
    path, clean = binary
    signed_clean = clean + b"signature"
    path.write_bytes(signed_clean)
    path.chmod(0o755)
    calls = []

    def normalize(data):
        calls.append(data)
        return data.removesuffix(b"signature")

    monkeypatch.setattr(orchestrate.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(orchestrate, "_resolve_write_gate", enabled_macos_gate)
    monkeypatch.setattr(orchestrate, "MACOS_NORMALIZE", normalize)
    monkeypatch.setattr(orchestrate, "maybe_resign_macos", lambda *_args: None)

    orchestrate.write_features(path, ["agent-model"], current_data=signed_clean)

    identity = shared_store.identity_for(path)
    asset = shared_store.read_active_baseline(identity.path_key, "2.1.175")
    assert asset.manifest["lineage_sha256"] == orchestrate.hashlib.sha256(
        clean
    ).hexdigest()
    assert signed_clean in calls


def test_macos_codesign_feature_drift_rolls_back_exact_entry(
    monkeypatch, binary, shared_store
):
    path, clean = binary
    path.chmod(0o755)
    establish_baseline(shared_store, path, clean)
    expected = replay(clean, ["agent-model"])
    corrupted = expected.replace(b".string()", b".xxxxxx()", 1)
    monkeypatch.setattr(orchestrate.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(orchestrate, "_resolve_write_gate", enabled_macos_gate)
    monkeypatch.setattr(
        orchestrate,
        "maybe_resign_macos",
        lambda target, _log: target.write_bytes(corrupted),
    )
    monkeypatch.setattr(orchestrate, "MACOS_NORMALIZE", lambda data: data)

    with pytest.raises(StoreError) as caught:
        orchestrate.write_features(path, ["agent-model"], current_data=clean)

    assert (caught.value.code, caught.value.exit_code) == ("content_mismatch", 2)
    assert path.read_bytes() == clean


def test_codesign_failure_reports_stable_code_after_exact_entry_rollback(
    monkeypatch, binary, shared_store
):
    path, clean = binary
    establish_baseline(shared_store, path, clean)
    monkeypatch.setattr(orchestrate.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(orchestrate, "_resolve_write_gate", enabled_macos_gate)
    monkeypatch.setattr(
        orchestrate,
        "maybe_resign_macos",
        lambda *_args: (_ for _ in ()).throw(ValueError("sign failed")),
    )

    with pytest.raises(StoreError) as caught:
        orchestrate.write_features(path, ["agent-model"], current_data=clean)

    assert caught.value.code == "codesign_failed"
    assert caught.value.exit_code == 3
    assert "sign failed" in str(caught.value)
    assert path.read_bytes() == clean


def test_post_write_readback_mismatch_rolls_back_without_resigning(monkeypatch, binary, shared_store):
    path, clean = binary
    establish_baseline(shared_store, path, clean)
    real_atomic_write = transaction.atomicio.atomic_write_if_unchanged
    resigns = []

    def corrupting_write(target, data, expected, **kwargs):
        real_atomic_write(target, data, expected, **kwargs)
        target.write_bytes(data + b"corrupt")

    monkeypatch.setattr(transaction.atomicio, "atomic_write_if_unchanged", corrupting_write)
    monkeypatch.setattr(
        orchestrate,
        "maybe_resign_macos",
        lambda *_args, **_kwargs: resigns.append(True),
    )

    with pytest.raises(StoreError, match="Written-back bytes") as caught:
        orchestrate.write_features(path, ["agent-model"], current_data=clean)

    assert caught.value.code == "content_mismatch"
    assert caught.value.exit_code == 2
    assert path.read_bytes() == clean
    assert resigns == []


def test_post_write_failure_with_failed_rollback_preserves_both_errors(monkeypatch, binary, shared_store):
    path, clean = binary
    establish_baseline(shared_store, path, clean)
    real_guarded_write = transaction.atomicio.atomic_write_if_unchanged

    def corrupting_write(target, data, expected, **kwargs):
        real_guarded_write(target, data, expected, **kwargs)
        target.write_bytes(data + b"corrupt")

    rollback_error = OSError("rollback disk failure")
    monkeypatch.setattr(transaction.atomicio, "atomic_write_if_unchanged", corrupting_write)
    monkeypatch.setattr(
        transaction.atomicio,
        "atomic_write",
        lambda *_args: (_ for _ in ()).throw(rollback_error),
    )

    with pytest.raises(StoreError) as caught:
        orchestrate.write_features(path, ["agent-model"], current_data=clean)

    assert caught.value.code == "rollback_failed"
    assert caught.value.exit_code == 2
    assert "Post-write verification failed and rollback failed" in str(caught.value)
    assert "Written-back bytes" in str(caught.value)
    assert "rollback disk failure" in str(caught.value)
    assert caught.value.__cause__ is rollback_error


def test_in_memory_prevalidation_rejects_before_atomic_write(monkeypatch, binary, shared_store):
    path, clean = binary
    establish_baseline(shared_store, path, clean)
    writes = []
    monkeypatch.setattr(REGISTRY["agent-model"], "apply", lambda _data, **_kwargs: 0)
    monkeypatch.setattr(transaction, "commit", lambda *_args, **_kwargs: writes.append(_args))

    with pytest.raises(orchestrate.ContentMismatch):
        orchestrate.write_features(path, ["agent-model"], current_data=clean)

    assert writes == []
    assert path.read_bytes() == clean


@pytest.mark.parametrize(
    ("corrupt_result", "message"),
    [
        (lambda data: data + b"extra", "length"),
        (
            lambda data: data.replace(
                b'VERSION:"2.1.175"', b'VERSION:"2.1.176"'
            ),
            "version",
        ),
    ],
)
def test_in_memory_result_invariants_fail_before_baseline_publish_or_write(
    monkeypatch, binary, shared_store, corrupt_result, message
):
    path, clean = binary
    publications = []
    writes = []
    real_apply = REGISTRY["agent-model"].apply

    def corrupting_apply(data, **kwargs):
        edits = real_apply(data, **kwargs)
        data[:] = corrupt_result(bytes(data))
        return edits

    monkeypatch.setattr(REGISTRY["agent-model"], "apply", corrupting_apply)
    monkeypatch.setattr(
        shared_store,
        "publish_baseline",
        lambda *_args, **_kwargs: publications.append(True),
    )
    monkeypatch.setattr(
        transaction,
        "commit",
        lambda *_args, **_kwargs: writes.append(True),
    )

    with pytest.raises(orchestrate.ContentMismatch, match=message):
        orchestrate.write_features(path, ["agent-model"], current_data=clean)

    assert publications == []
    assert writes == []
    assert path.read_bytes() == clean


def test_save_named_snapshot_uses_current_binary_version(binary, shared_store):
    path, clean = binary

    saved = orchestrate.save_named_snapshot(path, "before-test")

    identity = shared_store.identity_for(path)
    assert saved.name == "snapshot.json"
    assert shared_store.read_snapshot(identity.path_key, "2.1.175", "before-test").data == clean


def test_save_named_snapshot_rejects_version_probe_failure_without_writing(binary):
    path, clean = binary
    broken = clean.replace(b'overview",VERSION:"2.1.175"', b'overview",RELEASE:"2.1.175"')
    path.write_bytes(broken)

    with pytest.raises(orchestrate.NoBaselineRejected) as caught:
        orchestrate.save_named_snapshot(path, "before-test")

    assert caught.value.reason == orchestrate.NoBaselineReason.VERSION_PROBE_FAILED
    assert path.read_bytes() == broken
    assert not atomicio.BACKUP_DIR.exists()


def test_restore_snapshot_rejects_concurrent_binary_change(monkeypatch, binary, shared_store):
    path, clean = binary
    snapshot = replay(clean, ["agent-model"])
    upgraded = clean.replace(b'VERSION:"2.1.175"', b'VERSION:"2.1.176"')
    snapshots.save_data(path, snapshot, "2.1.175", "patched", store=shared_store)
    real_write = transaction.atomicio.atomic_write_if_unchanged
    resigns = []

    def upgrading_write(target, data, expected, **kwargs):
        target.write_bytes(upgraded)
        return real_write(target, data, expected, **kwargs)

    monkeypatch.setattr(transaction.atomicio, "atomic_write_if_unchanged", upgrading_write)
    monkeypatch.setattr(
        orchestrate,
        "maybe_resign_macos",
        lambda *_args, **_kwargs: resigns.append(True),
    )

    with pytest.raises(StoreError) as caught:
        orchestrate.restore_snapshot(path, "patched")

    assert (caught.value.code, caught.value.exit_code) == (
        "concurrent_binary_change",
        1,
    )
    assert path.read_bytes() == upgraded
    assert resigns == []


def test_restore_snapshot_resigns_after_verified_write(monkeypatch, binary, shared_store):
    path, clean = binary
    path.chmod(0o755)
    snapshot = replay(clean, ["agent-model"])
    snapshots.save_data(path, snapshot, "2.1.175", "patched", store=shared_store)
    events = []
    real_atomic_write = transaction.atomicio.atomic_write_if_unchanged

    def recording_write(target, data, expected, **kwargs):
        events.append("write")
        real_atomic_write(target, data, expected, **kwargs)

    def recording_resign(target, log):
        assert target.read_bytes() == snapshot
        events.append("resign")

    monkeypatch.setattr(transaction.atomicio, "atomic_write_if_unchanged", recording_write)
    monkeypatch.setattr(orchestrate, "maybe_resign_macos", recording_resign)
    monkeypatch.setattr(orchestrate.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(orchestrate, "_resolve_write_gate", enabled_macos_gate)

    outcome = orchestrate.restore_snapshot(path, "patched")

    assert events == ["write", "resign"]
    assert outcome.resigned is True


def test_restore_snapshot_matching_version_overwrites_binary(binary, shared_store):
    path, clean = binary
    snapshot = replay(clean, ["agent-model"])
    snapshots.save_data(path, snapshot, "2.1.175", "patched", store=shared_store)
    path.write_bytes(clean)

    outcome = orchestrate.restore_snapshot(path, "patched")

    assert path.read_bytes() == snapshot
    assert outcome.applied == ["agent-model"]


def test_restore_uses_embedded_snapshot_version_for_cross_version_guard(binary, shared_store):
    path, clean = binary
    disguised = clean.replace(b'VERSION:"2.1.175"', b'VERSION:"2.1.174"')
    snapshots.save_data(path, disguised, "2.1.174", "disguised", store=shared_store)

    with pytest.raises(orchestrate.CrossVersionSnapshotWarning) as caught:
        orchestrate.restore_snapshot(path, "disguised")

    assert caught.value.snapshot_version == "2.1.174"
    assert caught.value.current_version == "2.1.175"
    assert path.read_bytes() == clean


def test_cross_version_snapshot_requires_confirmation_without_writing(binary, shared_store):
    path, clean = binary
    old = clean.replace(b'VERSION:"2.1.175"', b'VERSION:"2.1.174"')
    snapshots.save_data(path, old, "2.1.174", "old", store=shared_store)

    with pytest.raises(orchestrate.CrossVersionSnapshotWarning) as caught:
        orchestrate.restore_snapshot(path, "old")

    assert caught.value.snapshot_version == "2.1.174"
    assert caught.value.current_version == "2.1.175"
    assert path.read_bytes() == clean


def test_confirmed_cross_version_snapshot_is_restored(binary, shared_store):
    path, clean = binary
    old = clean.replace(b'VERSION:"2.1.175"', b'VERSION:"2.1.174"')
    snapshots.save_data(path, old, "2.1.174", "old", store=shared_store)

    with pytest.raises(orchestrate.CrossVersionSnapshotWarning) as warning:
        orchestrate.restore_snapshot(path, "old")
    orchestrate.restore_snapshot(path, "old", confirmation=warning.value.confirmation)

    assert path.read_bytes() == old


def test_cross_version_confirmation_rejects_binary_replaced_between_calls(binary, shared_store):
    path, clean = binary
    old = clean.replace(b'VERSION:"2.1.175"', b'VERSION:"2.1.174"')
    snapshots.save_data(path, old, "2.1.174", "old", store=shared_store)

    with pytest.raises(orchestrate.CrossVersionSnapshotWarning) as warning:
        orchestrate.restore_snapshot(path, "old")
    replacement = replay(clean, ["agent-model"])
    path.write_bytes(replacement)

    with pytest.raises(orchestrate.ConcurrentBinaryChange) as raised:
        orchestrate.restore_snapshot(
            path,
            "old",
            confirmation=warning.value.confirmation,
        )

    assert raised.value.code == "concurrent_binary_change"
    assert path.read_bytes() == replacement


def test_restore_same_slug_prefers_current_version_and_allows_explicit_version(binary, shared_store):
    path, clean = binary
    current = replay(clean, ["agent-model"])
    old = clean.replace(b'VERSION:"2.1.175"', b'VERSION:"2.1.174"')
    snapshots.save_data(path, current, "2.1.175", "same", store=shared_store)
    snapshots.save_data(path, old, "2.1.174", "same", store=shared_store)

    orchestrate.restore_snapshot(path, "same")
    assert path.read_bytes() == current

    path.write_bytes(clean)
    with pytest.raises(orchestrate.CrossVersionSnapshotWarning) as warning:
        orchestrate.restore_snapshot(path, "same", snapshot_version="2.1.174")
    orchestrate.restore_snapshot(
        path,
        "same",
        snapshot_version="2.1.174",
        confirmation=warning.value.confirmation,
    )
    assert path.read_bytes() == old


def test_restore_same_slug_without_current_match_lists_versions(binary, shared_store):
    path, clean = binary
    for version in ("2.1.173", "2.1.174"):
        data = clean.replace(b'VERSION:"2.1.175"', f'VERSION:"{version}"'.encode())
        snapshots.save_data(path, data, version, "same", store=shared_store)

    with pytest.raises(StoreError) as caught:
        orchestrate.restore_snapshot(path, "same")
    assert caught.value.code == "snapshot_ambiguous"


def test_write_after_snapshot_restore_uses_detected_current_state_only(binary, shared_store):
    path, clean = binary
    establish_baseline(shared_store, path, clean)
    restored = replay(clean, ["agent-model"])
    snapshots.save_data(path, restored, "2.1.175", "agent-only", store=shared_store)
    orchestrate.restore_snapshot(path, "agent-only")

    orchestrate.write_features(
        path,
        ["source-exec", "agent-model", "channels"],
        current_data=path.read_bytes(),
    )

    assert path.read_bytes() == replay(clean, list(REGISTRY))
