from __future__ import annotations

import json
import os
import subprocess
import sys
import hashlib
from pathlib import Path

from jsonschema import Draft202012Validator
from referencing import Registry, Resource


REPOSITORY_ROOT = Path(__file__).parents[3]
SCHEMA_ROOT = REPOSITORY_ROOT / "contract" / "schemas"
CCPATCH = Path(sys.executable).with_name("ccpatch")


def _schema(name: str) -> dict:
    return json.loads((SCHEMA_ROOT / name).read_text(encoding="utf-8"))


def _validate(payload: object, schema_name: str) -> None:
    schema = _schema(schema_name)
    error_schema = _schema("error.schema.json")
    registry = Registry().with_resource(
        error_schema["$id"], Resource.from_contents(error_schema)
    )
    Draft202012Validator(schema, registry=registry).validate(payload)


def _run_ccpatch(
    tmp_path: Path,
    *arguments: str,
    input_text: str | None = None,
    environment_overrides: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    store = tmp_path / "shared-store"
    environment = dict(os.environ)
    environment["UNBUN_CC_STORE"] = str(store)
    environment.update(environment_overrides or {})
    return subprocess.run(
        [str(CCPATCH), *arguments],
        input=input_text,
        text=True,
        capture_output=True,
        check=False,
        env=environment,
        cwd=REPOSITORY_ROOT / "python" / "cc-patch",
    )


def test_public_check_json_matches_contract_and_does_not_create_store(make_bundle, tmp_path):
    binary = tmp_path / "claude"
    binary.write_bytes(bytes(make_bundle()))

    completed = _run_ccpatch(tmp_path, "--check", "--json", "--binary", str(binary))

    assert completed.returncode == 0, completed.stderr
    payload = json.loads(completed.stdout)
    assert completed.stderr == ""
    assert len(payload) == 1
    _validate(payload[0], "status.schema.json")
    assert payload[0]["path"] == str(binary)
    assert payload[0]["size_bytes"] == binary.stat().st_size
    assert not (tmp_path / "shared-store").exists()


def test_public_patch_json_matches_contract_and_uses_shared_store(make_bundle, tmp_path):
    binary = tmp_path / "claude"
    binary.write_bytes(bytes(make_bundle()))

    completed = _run_ccpatch(
        tmp_path,
        "patch",
        "--binary",
        str(binary),
        "--feature",
        "agent-model",
        "--json",
    )

    assert completed.returncode == 0, completed.stderr
    payload = json.loads(completed.stdout)
    _validate(payload, "write-envelope.schema.json")
    assert payload["results"][0]["applied"] == ["agent-model"]
    assert "agent-model" not in completed.stdout.removeprefix("{").splitlines()[0]
    assert (tmp_path / "shared-store" / "v1" / "targets").is_dir()


def test_store_root_is_read_only_and_reports_resolved_override(tmp_path):
    completed = _run_ccpatch(tmp_path, "store", "root")

    assert completed.returncode == 0, completed.stderr
    assert completed.stdout.strip() == str(tmp_path / "shared-store")
    assert completed.stderr == ""
    assert not (tmp_path / "shared-store").exists()


def test_lock_inspect_and_cleanup_require_explicit_force(make_bundle, tmp_path):
    binary = tmp_path / "claude"
    binary.write_bytes(bytes(make_bundle()))
    canonical = str(binary.resolve())

    path_key = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    lock_path = tmp_path / "shared-store" / "v1" / "targets" / path_key / "write.lock"
    lock_path.mkdir(parents=True)

    inspected = _run_ccpatch(
        tmp_path, "lock", "inspect", "--binary", str(binary), "--json"
    )
    assert inspected.returncode == 0, inspected.stderr
    diagnosis = json.loads(inspected.stdout)
    assert diagnosis["locked"] is True
    assert diagnosis["owner_known"] is False
    assert diagnosis["message"] == "lock exists but owner unknown"
    assert lock_path.is_dir()

    refused = _run_ccpatch(tmp_path, "lock", "cleanup", "--binary", str(binary))
    assert refused.returncode == 1
    assert "--force" in refused.stderr
    assert lock_path.is_dir()

    cleaned = _run_ccpatch(
        tmp_path, "lock", "cleanup", "--binary", str(binary), "--force"
    )
    assert cleaned.returncode == 0, cleaned.stderr
    assert not lock_path.exists()


def test_bare_non_tty_is_read_only_status(make_bundle, tmp_path):
    home = tmp_path / "home"
    binary = home / ".local" / "share" / "claude" / "versions" / "2.1.175"
    binary.parent.mkdir(parents=True)
    binary.write_bytes(bytes(make_bundle()) + b"\0" * 10_000_000)
    original = binary.read_bytes()

    completed = _run_ccpatch(
        tmp_path,
        environment_overrides={"HOME": str(home), "PATH": "/usr/bin:/bin"},
    )

    assert completed.returncode == 0, completed.stderr
    assert str(binary) in completed.stdout
    assert binary.read_bytes() == original
    assert not (tmp_path / "shared-store").exists()


def test_profile_is_read_only_and_reports_implementation(make_bundle, tmp_path):
    binary = tmp_path / "claude"
    binary.write_bytes(bytes(make_bundle()))

    completed = _run_ccpatch(tmp_path, "--profile", "--binary", str(binary))

    assert completed.returncode == 0, completed.stderr
    assert "implementation=python" in completed.stdout
    assert "source-exec=clean" in completed.stdout
    assert not (tmp_path / "shared-store").exists()


def test_snapshot_commands_use_shared_store_and_never_legacy_backups(make_bundle, tmp_path):
    binary = tmp_path / "claude"
    binary.write_bytes(bytes(make_bundle()))

    saved = _run_ccpatch(
        tmp_path, "snapshot", "save", "before-test", "--binary", str(binary)
    )
    assert saved.returncode == 0, saved.stderr
    assert not list(tmp_path.glob("*.ccsnap"))

    listed = _run_ccpatch(tmp_path, "snapshot", "list", "--binary", str(binary))
    assert listed.returncode == 0, listed.stderr
    assert "before-test" in listed.stdout

    duplicate = _run_ccpatch(
        tmp_path, "snapshot", "save", "before-test", "--binary", str(binary)
    )
    assert duplicate.returncode == 1
    assert "--force" in duplicate.stderr

    forced = _run_ccpatch(
        tmp_path,
        "snapshot",
        "save",
        "before-test",
        "--force",
        "--binary",
        str(binary),
    )
    assert forced.returncode == 0, forced.stderr

    removed = _run_ccpatch(
        tmp_path, "snapshot", "rm", "before-test", "--binary", str(binary)
    )
    assert removed.returncode == 0, removed.stderr
    assert "before-test" not in _run_ccpatch(
        tmp_path, "snapshot", "list", "--binary", str(binary)
    ).stdout


def test_dependency_error_names_only_actual_channels_dependant(make_bundle, tmp_path):
    binary = tmp_path / "claude"
    clean = bytes(make_bundle())
    binary.write_bytes(clean)
    patched = _run_ccpatch(
        tmp_path, "patch", "--binary", str(binary), "--feature", "channels"
    )
    assert patched.returncode == 0, patched.stderr

    refused = _run_ccpatch(
        tmp_path,
        "revert",
        "--binary",
        str(binary),
        "--feature",
        "source-exec",
        "--json",
    )

    assert refused.returncode == 1
    payload = json.loads(refused.stdout)
    _validate(payload, "write-envelope.schema.json")
    assert payload["errors"][0]["details"] == {
        "category": "dependency_conflict",
        "dependency": "source-exec",
        "dependants": ["channels"],
    }
    assert "agent-model" not in refused.stderr


def test_multi_binary_write_returns_most_severe_exit(make_bundle, tmp_path):
    home = tmp_path / "home"
    versions = home / ".local" / "share" / "claude" / "versions"
    versions.mkdir(parents=True)
    valid = versions / "2.1.175"
    invalid = versions / "2.1.176"
    fixture = bytes(make_bundle()) + b"\0" * 10_000_000
    valid.write_bytes(fixture)
    invalid.write_bytes(fixture)

    canonical = str(invalid.resolve())
    path_key = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    baseline_dir = (
        tmp_path
        / "shared-store"
        / "v1"
        / "targets"
        / path_key
        / "baselines"
        / "2.1.175"
    )
    baseline_dir.mkdir(parents=True)
    missing_digest = "0" * 64
    (baseline_dir / "baseline.json").write_text(
        json.dumps(
            {
                "schema": "unbun.cc.baseline",
                "schema_version": 1,
                "feature_contract": "claude-v1",
                "path_key": path_key,
                "embedded_version": "2.1.175",
                "blob": f"blobs/{missing_digest}.ccbak",
                "sha256": missing_digest,
                "lineage_algorithm": "claude-v1-exact-replay",
                "lineage_sha256": missing_digest,
                "size": len(fixture),
                "states": {
                    "source-exec": "clean",
                    "agent-model": "clean",
                    "channels": "clean",
                },
                "created_at": "2026-07-24T00:00:00.000Z",
                "created_by": "test",
            }
        ),
        encoding="utf-8",
    )

    completed = _run_ccpatch(
        tmp_path,
        "patch",
        "--all",
        "--json",
        environment_overrides={"HOME": str(home), "PATH": "/usr/bin:/bin"},
    )

    assert completed.returncode == 2
    payload = json.loads(completed.stdout)
    _validate(payload, "write-envelope.schema.json")
    assert payload["exit_code"] == 2
    assert len(payload["results"]) == 1
    assert len(payload["errors"]) == 1
    assert payload["errors"][0]["code"] == "baseline_invalid"