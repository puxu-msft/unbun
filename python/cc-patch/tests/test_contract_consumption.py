from __future__ import annotations

import hashlib
import importlib.util
import json
import subprocess
import sys
from copy import deepcopy
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator
from referencing import Registry, Resource

from cc_patch.features import REGISTRY, agent_model, channels, resolve_closure
from cc_patch.locking import DirectoryLock
from cc_patch.models import BinaryProbe, CliError, ERROR_EXIT_CODES, WriteOutcome
from cc_patch.report import render_json, render_write_outcomes_json
from cc_patch.store import StoreV1
from tests.conftest import make_bundle


REPO_ROOT = Path(__file__).resolve().parents[3]
CONTRACT_ROOT = REPO_ROOT / "contract"
SCHEMA_ROOT = CONTRACT_ROOT / "schemas"
VECTOR_ROOT = CONTRACT_ROOT / "vectors"
GOLDEN_ROOT = CONTRACT_ROOT / "golden"
VECTOR_MANIFESTS = ("feature-claude-v1", "store-v1", "lineage-v1", "known-bad-v1")


def _schema_registry() -> Registry:
    registry = Registry()
    for path in SCHEMA_ROOT.glob("*.schema.json"):
        schema = json.loads(path.read_text(encoding="utf-8"))
        registry = registry.with_resource(schema["$id"], Resource.from_contents(schema))
    return registry


def _validator(schema_name: str) -> Draft202012Validator:
    schema = json.loads((SCHEMA_ROOT / schema_name).read_text(encoding="utf-8"))
    return Draft202012Validator(schema, registry=_schema_registry())


def _load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


@pytest.fixture
def produced_contract_objects(tmp_path: Path) -> dict[str, object]:
    binary = tmp_path / "claude"
    binary.write_bytes(bytes(make_bundle()))
    store = StoreV1(tmp_path / "store")
    identity = store.identity_for(binary)
    target = _load_json(store.ensure_target(identity))
    baseline_data = b"clean-baseline"
    digest = hashlib.sha256(baseline_data).hexdigest()
    baseline = {
        "schema": "unbun.cc.baseline",
        "schema_version": 1,
        "feature_contract": "claude-v1",
        "path_key": identity.path_key,
        "embedded_version": "2.1.175",
        "blob": f"blobs/{digest}.ccbak",
        "sha256": digest,
        "lineage_algorithm": "claude-v1-exact-replay",
        "lineage_sha256": digest,
        "size": len(baseline_data),
        "states": {slug: "clean" for slug in REGISTRY},
        "created_at": StoreV1.utc_now(),
        "created_by": "python",
    }
    baseline_path = store.publish_baseline(identity.path_key, "2.1.175", baseline_data, baseline)
    snapshot_data = b"patched-snapshot"
    snapshot_digest = hashlib.sha256(snapshot_data).hexdigest()
    snapshot = {
        "schema": "unbun.cc.snapshot",
        "schema_version": 1,
        "feature_contract": "claude-v1",
        "path_key": identity.path_key,
        "embedded_version": "2.1.175",
        "slug": "before-change",
        "blob": f"blobs/{snapshot_digest}.ccsnap",
        "sha256": snapshot_digest,
        "size": len(snapshot_data),
        "observed_states": {slug: "clean" for slug in REGISTRY},
        "created_at": StoreV1.utc_now(),
        "created_by": "python",
    }
    snapshot_path = store.publish_snapshot(identity.path_key, "2.1.175", "before-change", snapshot_data, snapshot)
    lock = DirectoryLock(store.target_dir(identity.path_key) / "write.lock", implementation="python", command="schema-test")
    owner = lock.acquire()
    lock.release()
    corrupt = store.target_dir(identity.path_key) / "baselines/2.1.175/broken.json"
    corrupt.parent.mkdir(parents=True, exist_ok=True)
    corrupt.write_bytes(b"corrupt")
    quarantine_dir = store.quarantine(identity.path_key, corrupt, reason="baseline_invalid", discovered_by="python")
    status = json.loads(render_json([BinaryProbe(binary, "2.1.175", {}, binary.stat().st_size, True)]))[0]
    envelope = json.loads(render_write_outcomes_json(action="patch", exit_code=2, outcomes=[], errors=[CliError("content_mismatch", "integrity failure")]))
    return {
        "target.schema.json": target,
        "baseline.schema.json": _load_json(baseline_path),
        "snapshot.schema.json": _load_json(snapshot_path),
        "lock-owner.schema.json": owner,
        "quarantine.schema.json": _load_json(quarantine_dir / "quarantine.json"),
        "status.schema.json": status,
        "error.schema.json": envelope["errors"][0],
        "write-envelope.schema.json": envelope,
        "transaction-scenario.schema.json": _load_json(VECTOR_ROOT / "transaction-v1.json"),
    }


def _exact_replay_output() -> dict:
    command = [
        sys.executable,
        str(REPO_ROOT / "exp/exact-replay/python/replay_proof.py"),
        "--manifest",
        str(REPO_ROOT / "exp/exact-replay/fixtures/manifest.json"),
        "--case",
        "clean",
        "--current",
        str(REPO_ROOT / "contract/golden/claude-v1/synthetic-2.1.175-clean.bin"),
    ]
    completed = subprocess.run(command, capture_output=True, text=True, check=False)
    assert completed.returncode == 0, completed.stderr
    return json.loads(completed.stdout)


def test_python_loads_all_contract_schemas_and_validates_actual_outputs(produced_contract_objects: dict[str, object]):
    objects = {**produced_contract_objects, "exact-replay-result.schema.json": _exact_replay_output()}

    assert set(path.name for path in SCHEMA_ROOT.glob("*.schema.json")) == set(objects)
    for schema_name, payload in objects.items():
        _validator(schema_name).validate(payload)


@pytest.mark.parametrize("schema_name", sorted(path.name for path in SCHEMA_ROOT.glob("*.schema.json")))
def test_each_contract_schema_rejects_a_malformed_actual_output(schema_name: str, produced_contract_objects: dict[str, object]):
    payloads = {**produced_contract_objects, "exact-replay-result.schema.json": _exact_replay_output()}
    payload = deepcopy(payloads[schema_name])
    required = _load_json(SCHEMA_ROOT / schema_name)["required"]
    payload.pop(required[0])

    assert list(_validator(schema_name).iter_errors(payload))


def test_shared_golden_sha256sums_are_verified_and_private_copies_match():
    lines = (GOLDEN_ROOT / "SHA256SUMS").read_text(encoding="utf-8").splitlines()
    assert lines
    for line in lines:
        digest, relative_path = line.split(maxsplit=1)
        shared = REPO_ROOT / relative_path
        private = Path(__file__).with_name("golden") / shared.name
        assert hashlib.sha256(shared.read_bytes()).hexdigest() == digest
        assert private.read_bytes() == shared.read_bytes()


@pytest.mark.parametrize("manifest_name", VECTOR_MANIFESTS)
def test_shared_vector_manifest_pins_every_listed_fixture(manifest_name: str):
    manifest_path = VECTOR_ROOT / manifest_name / "manifest.json"
    manifest = _load_json(manifest_path)
    assert manifest["vectors"]
    for vector in manifest["vectors"]:
        for pinned in vector["files"]:
            path = (manifest_path.parent / pinned["path"]).resolve()
            assert path.is_relative_to(CONTRACT_ROOT.resolve())
            data = path.read_bytes()
            assert len(data) == pinned["size"]
            assert hashlib.sha256(data).hexdigest() == pinned["sha256"]


KNOWN_BAD_MANIFEST = _load_json(VECTOR_ROOT / "known-bad-v1/manifest.json")
KNOWN_BAD_OBSERVATIONS = _load_json(VECTOR_ROOT / "known-bad-v1/fixtures/desired-observations.json")


@pytest.mark.parametrize("vector", KNOWN_BAD_MANIFEST["vectors"], ids=lambda vector: vector["id"])
def test_known_bad_corpus_does_not_recur_in_python(vector: dict, tmp_path: Path):
    vector_id = vector["id"]
    expected = KNOWN_BAD_OBSERVATIONS[vector_id]

    if vector_id == "hardcoded-e":
        data = (VECTOR_ROOT / "known-bad-v1/fixtures/hardcoded-receiver-s.txt").read_bytes()
        status = agent_model.FEATURE.detect(data)
        assert status.state == expected["desired"]
        assert status.substates[0].receiver == "S"
        return

    if vector_id == "incorrect-agent-source-dependency":
        fixture = _load_json(VECTOR_ROOT / "known-bad-v1/fixtures/incorrect-agent-source-dependency.json")
        assert resolve_closure(fixture["request_set"]) == expected["desired_closed_set"]
        return

    if vector_id == "channels-revert-erases-agent-model":
        # 此语料是 JS generation-one 整文件 .bak revert 的正向负样本；Python channels 不可逆，故没有会覆盖 agent-model 的 channels reverse 路径。
        data = bytearray((VECTOR_ROOT / "known-bad-v1/fixtures/generation-one-binary.txt").read_bytes())
        enum = b'enum(["sonnet","opus","haiku","fable"])'
        site = data.index(enum)
        data[site : site + len(enum)] = agent_model.REPLACE_CORE
        assert not hasattr(channels.FEATURE, "reverse")
        assert b"E.string()" in data
        assert b"E.enum(" not in data
        return

    if vector_id == "adjacent-bak":
        # 此语料是 JS generation-one 创建 launcher 相邻 .bak 的正向负样本；Python store 仅在其受控根目录发布资产。
        binary = tmp_path / "claude"
        binary.write_bytes(bytes(make_bundle()))
        store = StoreV1(tmp_path / "store")
        identity = store.identity_for(binary)
        store.ensure_target(identity)
        assert not list(binary.parent.glob(f"{binary.name}*.bak"))
        assert store.target_dir(identity.path_key).is_relative_to(store.protocol_root)
        return

    if vector_id == "collapsed-error-exit":
        # 此语料是 JS generation-one catch-all exit 1 的正向负样本；Python 保留完整错误 catalog，将完整性错误映射为 exit 2。
        data = (VECTOR_ROOT / "known-bad-v1/fixtures/channels-missing-essential.txt").read_bytes()
        assert channels.FEATURE.detect(data).state == "mixed"
        assert ERROR_EXIT_CODES[vector["expected_code"]] == expected["desired_integrity_exit"]
        return

    raise AssertionError(f"unhandled known-bad vector: {vector_id}")
