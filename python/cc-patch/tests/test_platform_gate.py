from pathlib import Path

import pytest

from cc_patch import orchestrate, snapshots
from cc_patch.features import REGISTRY
from cc_patch.lineage import LineageError, PlatformGate, assert_platform_write_enabled
from cc_patch.store import ContentInspection, StoreV1


REPO_ROOT = Path(__file__).resolve().parents[3]
CONTRACT_ROOT = REPO_ROOT / "contract"


def _enabled_macos_gate() -> PlatformGate:
    return PlatformGate(
        platform="macos",
        format="macho",
        lineage_algorithm="claude-v1-exact-replay",
        capabilities={"production_write_gate": {"status": "enabled"}},
        production_write_gate={"status": "enabled"},
    )


@pytest.fixture
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


def test_assert_platform_write_enabled_allows_only_enabled_linux_gate():
    gate = assert_platform_write_enabled(CONTRACT_ROOT, "linux")

    assert gate.platform == "linux"
    assert gate.production_write_gate["status"] == "enabled"


@pytest.mark.parametrize("platform_name", ["windows", "macos"])
def test_assert_platform_write_enabled_rejects_disabled_platforms(platform_name):
    with pytest.raises(LineageError) as raised:
        assert_platform_write_enabled(CONTRACT_ROOT, platform_name)

    assert (raised.value.code, raised.value.exit_code) == ("platform_write_disabled", 1)


def test_assert_platform_write_enabled_rejects_unknown_platform():
    with pytest.raises(LineageError) as raised:
        assert_platform_write_enabled(CONTRACT_ROOT, "plan9")

    assert (raised.value.code, raised.value.exit_code) == ("platform_write_unsupported", 1)


@pytest.mark.parametrize("system_name", ["Windows", "Darwin"])
def test_write_features_rejects_disabled_platform_before_binary_changes(monkeypatch, binary, system_name):
    path, clean = binary
    monkeypatch.setattr(orchestrate.platform, "system", lambda: system_name)

    with pytest.raises(LineageError) as raised:
        orchestrate.write_features(path, ["agent-model"], current_data=clean)

    assert (raised.value.code, raised.value.exit_code) == ("platform_write_disabled", 1)
    assert path.read_bytes() == clean


@pytest.mark.parametrize("system_name", ["Windows", "Darwin"])
def test_restore_snapshot_rejects_disabled_platform_before_binary_changes(monkeypatch, binary, system_name):
    path, clean = binary
    monkeypatch.setattr(orchestrate.platform, "system", lambda: system_name)

    with pytest.raises(LineageError) as raised:
        orchestrate.restore_snapshot(path, "missing")

    assert (raised.value.code, raised.value.exit_code) == ("platform_write_disabled", 1)
    assert path.read_bytes() == clean


def test_linux_write_and_snapshot_restore_remain_enabled(binary, shared_store):
    path, clean = binary
    patched = orchestrate.write_features(path, ["agent-model"], current_data=clean)
    snapshots.save_data(path, clean, "2.1.175", "clean", store=shared_store)

    restored = orchestrate.restore_snapshot(path, "clean")

    assert patched.applied == ["agent-model"]
    assert restored.applied == []
    assert path.read_bytes() == clean


def test_enabled_macos_gate_seam_allows_write_internals(monkeypatch, binary):
    path, clean = binary
    path.chmod(0o755)
    monkeypatch.setattr(orchestrate.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(orchestrate, "_resolve_write_gate", _enabled_macos_gate)
    monkeypatch.setattr(orchestrate, "maybe_resign_macos", lambda *_args: None)

    outcome = orchestrate.write_features(path, ["agent-model"], current_data=clean)

    assert outcome.resigned is True
    assert path.read_bytes() != clean


def test_enabled_macos_gate_seam_allows_snapshot_restore_internals(monkeypatch, binary, shared_store):
    path, clean = binary
    path.chmod(0o755)
    patched = bytearray(clean)
    REGISTRY["agent-model"].apply(patched)
    snapshots.save_data(path, bytes(patched), "2.1.175", "patched", store=shared_store)
    monkeypatch.setattr(orchestrate.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(orchestrate, "_resolve_write_gate", _enabled_macos_gate)
    monkeypatch.setattr(orchestrate, "maybe_resign_macos", lambda *_args: None)

    outcome = orchestrate.restore_snapshot(path, "patched")

    assert outcome.resigned is True
    assert path.read_bytes() == bytes(patched)
