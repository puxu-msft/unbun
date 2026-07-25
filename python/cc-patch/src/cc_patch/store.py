import hashlib
import json
import os
import re
import sys
import unicodedata
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path, PureWindowsPath
from typing import Callable, Mapping


_HEX64 = re.compile(r"[0-9a-f]{64}", re.ASCII)
_VERSION = re.compile(r"[0-9]+(?:\.[0-9]+)*", re.ASCII)
_SLUG = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*", re.ASCII)
_REASON = re.compile(r"[a-z0-9]+(?:_[a-z0-9]+)*", re.ASCII)
_UUID4 = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}",
    re.ASCII,
)
_FEATURE_STATES = {"clean", "patched", "mixed", "unsupported"}
_FEATURES = ("source-exec", "agent-model", "channels")


class StoreError(RuntimeError):
    def __init__(self, code: str, exit_code: int, message: str):
        self.code = code
        self.exit_code = exit_code
        super().__init__(message)


@dataclass(frozen=True)
class TargetIdentity:
    canonical_path: str
    path_key: str
    display_name: str


@dataclass(frozen=True)
class StoredAsset:
    manifest_path: Path
    blob_path: Path
    manifest: dict
    data: bytes


@dataclass(frozen=True)
class ContentInspection:
    embedded_version: str | None
    states: dict[str, str]


class DurabilityAdapter:
    directory_fsync_supported = True
    durability_boundary = "file-and-directory-fsync"

    def fsync_file(self, path: Path) -> None:
        descriptor = os.open(path, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def fsync_directory(self, path: Path) -> None:
        descriptor = os.open(path, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    @classmethod
    def for_platform(cls, platform: str | None = None) -> "DurabilityAdapter":
        if (platform or sys.platform).lower().startswith("win"):
            return WindowsDurabilityAdapter()
        return cls()


class WindowsDurabilityAdapter(DurabilityAdapter):
    directory_fsync_supported = False
    durability_boundary = "file-flush-and-atomic-rename-no-directory-fsync"

    def fsync_file(self, path: Path) -> None:
        descriptor = os.open(path, os.O_RDWR)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def fsync_directory(self, path: Path) -> None:
        return None


def _store_error(code: str, message: str) -> StoreError:
    exits = {
        "store_version_unsupported": 1,
        "snapshot_exists": 1,
        "snapshot_not_found": 1,
        "snapshot_ambiguous": 1,
        "binary_in_use": 3,
        "codesign_failed": 3,
    }
    return StoreError(code, exits.get(code, 2), message)


def _contains_unexpanded_value(value: str) -> bool:
    return value.startswith("~") or "$" in value or re.search(r"%[^%]+%", value) is not None


def _is_absolute_native(value: str, platform: str) -> bool:
    if platform.lower().startswith("win"):
        return PureWindowsPath(value).is_absolute()
    return value.startswith("/")


def resolve_store_root(environment: Mapping[str, str] | None = None, *, platform: str | None = None) -> Path:
    env = os.environ if environment is None else environment
    host = (platform or sys.platform).lower()
    override = env.get("UNBUN_CC_STORE")
    if override is not None:
        if _contains_unexpanded_value(override) or not _is_absolute_native(override, host):
            raise StoreError("store_root_invalid", 1, "UNBUN_CC_STORE must be an unexpanded absolute path")
        return Path(override)
    if host.startswith("win"):
        base = env.get("LOCALAPPDATA")
        if not base:
            raise StoreError("store_root_invalid", 1, "LOCALAPPDATA is required on Windows")
        return Path(str(PureWindowsPath(base) / "unbun" / "cc-patch"))
    xdg = env.get("XDG_DATA_HOME")
    if xdg:
        if not xdg.startswith("/"):
            raise StoreError("store_root_invalid", 1, "XDG_DATA_HOME must be absolute")
        return Path(xdg) / "unbun" / "cc-patch"
    home = env.get("HOME")
    if not home or not home.startswith("/"):
        raise StoreError("store_root_invalid", 1, "HOME must be an absolute path")
    if host == "darwin":
        return Path(home) / "Library" / "Application Support" / "unbun" / "cc-patch"
    return Path(home) / ".local" / "share" / "unbun" / "cc-patch"


def _ascii_lower(value: str) -> str:
    return "".join(chr(ord(character) + 32) if "A" <= character <= "Z" else character for character in value)


def canonicalize_contract_path(
    value: str,
    *,
    platform: str,
    symlinks: Mapping[str, str] | None = None,
) -> str:
    if platform == "windows":
        normalized = value
        if normalized.startswith("\\\\?\\"):
            normalized = normalized[4:]
        normalized = normalized.replace("\\", "/")
        return unicodedata.normalize("NFC", _ascii_lower(normalized))
    if not value.startswith("/"):
        raise StoreError("target_identity_mismatch", 2, "canonical POSIX path must be absolute")
    resolved = value
    for source, target in sorted((symlinks or {}).items(), key=lambda item: len(item[0]), reverse=True):
        if resolved == source or resolved.startswith(f"{source}/"):
            resolved = f"{target}{resolved[len(source):]}"
            break
    return unicodedata.normalize("NFC", resolved)


def compute_path_key(canonical_path: str) -> str:
    return hashlib.sha256(canonical_path.encode("utf-8")).hexdigest()


def _require_string(manifest: dict, field: str, *, minimum: int = 1) -> str:
    value = manifest.get(field)
    if not isinstance(value, str) or len(value) < minimum:
        raise ValueError(f"invalid {field}")
    return value


def _require_pattern(manifest: dict, field: str, pattern: re.Pattern[str]) -> str:
    value = _require_string(manifest, field)
    if pattern.fullmatch(value) is None:
        raise ValueError(f"invalid {field}")
    return value


def _require_integer(manifest: dict, field: str, *, minimum: int = 0) -> int:
    value = manifest.get(field)
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise ValueError(f"invalid {field}")
    return value


def _require_time(manifest: dict, field: str) -> str:
    value = _require_string(manifest, field)
    if not value.endswith("Z"):
        raise ValueError(f"invalid {field}")
    datetime.fromisoformat(f"{value[:-1]}+00:00")
    return value


def _require_relative_path(value: str) -> None:
    if value.startswith(('/', '\\')) or re.match(r"[A-Za-z]:[\\/]", value):
        raise ValueError("absolute manifest path")
    parts = value.replace("\\", "/").split("/")
    if ".." in parts or any(not part for part in parts):
        raise ValueError("unsafe manifest path")


def _require_states(manifest: dict, field: str, *, clean_only: bool) -> None:
    states = manifest.get(field)
    if not isinstance(states, dict):
        raise ValueError(f"invalid {field}")
    for feature in _FEATURES:
        value = states.get(feature)
        if value != "clean" if clean_only else value not in _FEATURE_STATES:
            raise ValueError(f"invalid {field}.{feature}")


def _validate_manifest(manifest: dict, kind: str) -> None:
    schemas = {
        "target": "unbun.cc.target",
        "baseline": "unbun.cc.baseline",
        "snapshot": "unbun.cc.snapshot",
        "lock-owner": "unbun.cc.lock-owner",
        "quarantine": "unbun.cc.quarantine",
    }
    if kind not in schemas or manifest.get("schema") != schemas[kind]:
        raise ValueError("unknown manifest schema")
    version = manifest.get("schema_version")
    if isinstance(version, bool) or not isinstance(version, int):
        raise ValueError("invalid schema_version")
    if version > 1:
        raise _store_error("store_version_unsupported", f"unsupported {kind} schema version {version}")
    if version != 1:
        raise ValueError("invalid schema_version")
    if kind == "target":
        _require_pattern(manifest, "path_key", _HEX64)
        _require_string(manifest, "canonical_path")
        _require_string(manifest, "display_name")
        _require_time(manifest, "created_at")
        return
    if kind == "lock-owner":
        _require_pattern(manifest, "token", _UUID4)
        _require_string(manifest, "implementation")
        _require_integer(manifest, "pid", minimum=1)
        _require_string(manifest, "hostname")
        _require_time(manifest, "started_at")
        _require_string(manifest, "command")
        return
    if kind == "quarantine":
        original_path = _require_string(manifest, "original_path")
        _require_relative_path(original_path)
        if "\\" in original_path:
            raise ValueError("invalid original_path")
        _require_pattern(manifest, "reason", _REASON)
        _require_pattern(manifest, "observed_sha256", _HEX64)
        _require_time(manifest, "discovered_at")
        _require_string(manifest, "discovered_by")
        return
    if manifest.get("feature_contract") != "claude-v1":
        raise ValueError("unsupported feature_contract")
    _require_pattern(manifest, "path_key", _HEX64)
    _require_pattern(manifest, "embedded_version", _VERSION)
    blob = _require_string(manifest, "blob")
    _require_relative_path(blob)
    _require_pattern(manifest, "sha256", _HEX64)
    _require_integer(manifest, "size")
    _require_time(manifest, "created_at")
    _require_string(manifest, "created_by")
    digest = manifest["sha256"]
    if kind == "baseline":
        if blob != f"blobs/{digest}.ccbak":
            raise ValueError("invalid baseline blob")
        if manifest.get("lineage_algorithm") != "claude-v1-exact-replay":
            raise ValueError("invalid lineage_algorithm")
        _require_pattern(manifest, "lineage_sha256", _HEX64)
        _require_states(manifest, "states", clean_only=True)
    else:
        if blob != f"blobs/{digest}.ccsnap":
            raise ValueError("invalid snapshot blob")
        _require_pattern(manifest, "slug", _SLUG)
        _require_states(manifest, "observed_states", clean_only=False)


def parse_manifest(payload: bytes, *, kind: str) -> dict:
    code = "baseline_invalid" if kind == "baseline" else f"{kind.replace('-', '_')}_invalid"
    try:
        if payload.startswith(b"\xef\xbb\xbf"):
            raise ValueError("manifest BOM is forbidden")
        parsed = json.loads(payload.decode("utf-8"))
        if not isinstance(parsed, dict):
            raise ValueError("manifest root must be an object")
        _validate_manifest(parsed, kind)
        return parsed
    except StoreError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError, TypeError) as error:
        raise _store_error(code, f"invalid {kind} manifest: {error}") from error


def _utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class StoreV1:
    def __init__(
        self,
        root: Path,
        *,
        durability: DurabilityAdapter | None = None,
        inspect_content: Callable[[bytes], ContentInspection] | None = None,
    ):
        self.root = Path(root)
        self.protocol_root = self.root / "v1"
        self.targets_root = self.protocol_root / "targets"
        self.durability = durability or DurabilityAdapter.for_platform()
        self.inspect_content = inspect_content

    @classmethod
    def from_environment(cls, environment: Mapping[str, str] | None = None) -> "StoreV1":
        return cls(resolve_store_root(environment))

    @staticmethod
    def utc_now() -> str:
        return _utc_now()

    def identity_for(self, binary: Path) -> TargetIdentity:
        path = Path(binary)
        if not path.exists():
            raise StoreError("target_identity_mismatch", 2, f"target does not exist: {path}")
        canonical = unicodedata.normalize("NFC", str(path.resolve()))
        if os.name == "nt":
            canonical = canonicalize_contract_path(canonical, platform="windows")
        return TargetIdentity(canonical, compute_path_key(canonical), path.name)

    def target_dir(self, path_key: str) -> Path:
        if _HEX64.fullmatch(path_key) is None:
            raise StoreError("target_identity_mismatch", 2, "invalid path_key")
        return self.targets_root / path_key

    def ensure_target(self, identity: TargetIdentity) -> Path:
        target_dir = self.target_dir(identity.path_key)
        target_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        final = target_dir / "target.json"
        manifest = {
            "schema": "unbun.cc.target",
            "schema_version": 1,
            "path_key": identity.path_key,
            "canonical_path": identity.canonical_path,
            "display_name": identity.display_name,
            "created_at": _utc_now(),
        }
        if final.exists():
            self._validate_target(final, identity)
            return final
        temp = self._write_temp(final, self._encode_manifest(manifest))
        try:
            self._publish_no_clobber(temp, final)
        except FileExistsError:
            self._validate_target(final, identity)
        finally:
            temp.unlink(missing_ok=True)
        return final

    def _validate_target(self, path: Path, identity: TargetIdentity) -> None:
        try:
            manifest = parse_manifest(path.read_bytes(), kind="target")
        except (OSError, StoreError) as error:
            raise StoreError("target_identity_mismatch", 2, f"invalid target identity: {error}") from error
        if (
            manifest["path_key"] != identity.path_key
            or manifest["canonical_path"] != identity.canonical_path
            or compute_path_key(manifest["canonical_path"]) != identity.path_key
        ):
            raise StoreError("target_identity_mismatch", 2, "target identity does not match canonical path")

    def _encode_manifest(self, manifest: dict) -> bytes:
        return (json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")

    def _write_temp(self, final: Path, data: bytes) -> Path:
        final.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        temp = final.parent / f".{final.name}.tmp.{uuid.uuid4()}"
        with temp.open("xb") as stream:
            stream.write(data)
            stream.flush()
        os.chmod(temp, 0o600)
        self.durability.fsync_file(temp)
        if temp.read_bytes() != data:
            temp.unlink(missing_ok=True)
            raise StoreError("content_mismatch", 2, f"temporary write mismatch: {temp}")
        return temp

    def _publish_no_clobber(self, temp: Path, final: Path) -> None:
        os.link(temp, final)
        self.durability.fsync_directory(final.parent)

    def _publish_blob(self, final: Path, data: bytes) -> None:
        if final.exists():
            existing = final.read_bytes()
            if existing != data:
                raise StoreError("content_mismatch", 2, f"content-addressed blob mismatch: {final}")
            return
        temp = self._write_temp(final, data)
        try:
            try:
                self._publish_no_clobber(temp, final)
            except FileExistsError:
                if final.read_bytes() != data:
                    raise StoreError("content_mismatch", 2, f"content-addressed blob conflict: {final}")
        finally:
            temp.unlink(missing_ok=True)

    def publish_baseline(
        self,
        path_key: str,
        version: str,
        data: bytes,
        manifest: dict,
        *,
        fault: str | None = None,
    ) -> Path:
        parsed = parse_manifest(self._encode_manifest(manifest), kind="baseline")
        self._validate_manifest_identity(parsed, path_key, version)
        self._validate_content(parsed, data, "baseline_invalid")
        directory = self.target_dir(path_key) / "baselines" / version
        blob = directory / parsed["blob"]
        self._publish_blob(blob, data)
        if fault == "after_blob":
            raise RuntimeError("fault after_blob")
        final = directory / "baseline.json"
        if final.exists():
            existing = self.read_active_baseline(path_key, version)
            if existing.manifest["sha256"] == parsed["sha256"]:
                return final
            raise StoreError("baseline_conflict", 2, f"active baseline differs: {final}")
        temp = self._write_temp(final, self._encode_manifest(parsed))
        if fault == "after_manifest_temp":
            raise RuntimeError("fault after_manifest_temp")
        try:
            try:
                self._publish_no_clobber(temp, final)
            except FileExistsError:
                existing = self.read_active_baseline(path_key, version)
                if existing.manifest["sha256"] != parsed["sha256"]:
                    raise StoreError("baseline_conflict", 2, f"active baseline differs: {final}")
        finally:
            temp.unlink(missing_ok=True)
        self.read_active_baseline(path_key, version)
        return final

    def find_active_baseline(self, path_key: str, version: str) -> Path | None:
        final = self.target_dir(path_key) / "baselines" / version / "baseline.json"
        return final if final.is_file() else None

    def read_active_baseline(self, path_key: str, version: str) -> StoredAsset:
        final = self.find_active_baseline(path_key, version)
        if final is None:
            raise StoreError("baseline_not_found", 1, f"baseline not found: {version}")
        return self._read_asset(final, "baseline", path_key, version)

    def publish_snapshot(
        self,
        path_key: str,
        version: str,
        slug: str,
        data: bytes,
        manifest: dict,
        *,
        force: bool = False,
    ) -> Path:
        parsed = parse_manifest(self._encode_manifest(manifest), kind="snapshot")
        self._validate_manifest_identity(parsed, path_key, version, slug)
        self._validate_content(parsed, data, "snapshot_invalid")
        directory = self.target_dir(path_key) / "snapshots" / version / slug
        blob = directory / parsed["blob"]
        self._publish_blob(blob, data)
        final = directory / "snapshot.json"
        temp = self._write_temp(final, self._encode_manifest(parsed))
        try:
            if force:
                os.replace(temp, final)
                self.durability.fsync_directory(directory)
            else:
                try:
                    self._publish_no_clobber(temp, final)
                except FileExistsError as error:
                    raise StoreError("snapshot_exists", 1, f"snapshot already exists: {slug}") from error
        finally:
            temp.unlink(missing_ok=True)
        self.read_snapshot(path_key, version, slug)
        return final

    def read_snapshot(self, path_key: str, version: str, slug: str) -> StoredAsset:
        final = self.target_dir(path_key) / "snapshots" / version / slug / "snapshot.json"
        if not final.is_file():
            raise StoreError("snapshot_not_found", 1, f"snapshot not found: {slug}@{version}")
        return self._read_asset(final, "snapshot", path_key, version, slug)

    def select_snapshot(self, path_key: str, slug: str, *, current_version: str) -> StoredAsset:
        if _SLUG.fullmatch(slug) is None:
            raise StoreError("snapshot_not_found", 1, f"invalid snapshot slug: {slug}")
        root = self.target_dir(path_key) / "snapshots"
        current = root / current_version / slug / "snapshot.json"
        if current.is_file():
            return self.read_snapshot(path_key, current_version, slug)
        matches = list(root.glob(f"*/{slug}/snapshot.json"))
        if not matches:
            raise StoreError("snapshot_not_found", 1, f"snapshot not found: {slug}")
        if len(matches) > 1:
            raise StoreError("snapshot_ambiguous", 1, f"snapshot version is ambiguous: {slug}")
        version = matches[0].parents[1].name
        return self.read_snapshot(path_key, version, slug)

    def _read_asset(
        self,
        manifest_path: Path,
        kind: str,
        path_key: str,
        version: str,
        slug: str | None = None,
    ) -> StoredAsset:
        code = f"{kind}_invalid"
        try:
            manifest = parse_manifest(manifest_path.read_bytes(), kind=kind)
            self._validate_manifest_identity(manifest, path_key, version, slug)
            blob_path = manifest_path.parent / manifest["blob"]
            data = blob_path.read_bytes()
            self._validate_content(manifest, data, code)
            return StoredAsset(manifest_path, blob_path, manifest, data)
        except StoreError:
            raise
        except OSError as error:
            raise StoreError(code, 2, f"invalid active {kind}: {error}") from error

    def _validate_manifest_identity(
        self,
        manifest: dict,
        path_key: str,
        version: str,
        slug: str | None = None,
    ) -> None:
        kind = "snapshot" if "slug" in manifest else "baseline"
        code = f"{kind}_invalid"
        if manifest["path_key"] != path_key or manifest["embedded_version"] != version:
            raise StoreError(code, 2, f"{kind} identity mismatch")
        if slug is not None and manifest.get("slug") != slug:
            raise StoreError(code, 2, "snapshot slug mismatch")
        if _VERSION.fullmatch(version) is None or (slug is not None and _SLUG.fullmatch(slug) is None):
            raise StoreError(code, 2, f"invalid {kind} directory identity")

    def _validate_content(self, manifest: dict, data: bytes, code: str) -> None:
        digest = hashlib.sha256(data).hexdigest()
        if manifest["size"] != len(data) or manifest["sha256"] != digest:
            raise StoreError(code, 2, "manifest content hash or size mismatch")
        if self.inspect_content is None:
            return
        inspection = self.inspect_content(data)
        if inspection.embedded_version != manifest["embedded_version"]:
            raise StoreError(code, 2, "manifest and content versions differ")
        if manifest["schema"] == "unbun.cc.baseline":
            if inspection.states != {feature: "clean" for feature in _FEATURES}:
                raise StoreError(code, 2, "baseline content is not all clean")

    def quarantine(
        self,
        path_key: str,
        source: Path,
        *,
        reason: str,
        discovered_by: str,
    ) -> Path:
        target = self.target_dir(path_key)
        try:
            original = source.relative_to(target).as_posix()
        except ValueError as error:
            raise StoreError("quarantine_invalid", 2, "artifact is outside target directory") from error
        data = source.read_bytes()
        timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ")
        directory = target / "quarantine" / f"{timestamp}-{reason}-{uuid.uuid4()}"
        directory.mkdir(parents=True, mode=0o700)
        artifact = directory / "artifact"
        os.replace(source, artifact)
        manifest = {
            "schema": "unbun.cc.quarantine",
            "schema_version": 1,
            "original_path": original,
            "reason": reason,
            "observed_sha256": hashlib.sha256(data).hexdigest(),
            "discovered_at": _utc_now(),
            "discovered_by": discovered_by,
        }
        parse_manifest(self._encode_manifest(manifest), kind="quarantine")
        final = directory / "quarantine.json"
        temp = self._write_temp(final, self._encode_manifest(manifest))
        try:
            self._publish_no_clobber(temp, final)
        except Exception:
            if artifact.exists() and not source.exists():
                try:
                    os.replace(artifact, source)
                    self.durability.fsync_directory(source.parent)
                except OSError:
                    pass
            raise
        finally:
            temp.unlink(missing_ok=True)
        return directory

    def quarantine_ready_temp(
        self,
        path_key: str,
        source: Path,
        *,
        discovered_by: str,
    ) -> Path:
        target = self.target_dir(path_key)
        staging = target / f".ready.tmp.{uuid.uuid4()}"
        staging.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.replace(source, staging)
        try:
            return self.quarantine(
                path_key,
                staging,
                reason="binary_in_use",
                discovered_by=discovered_by,
            )
        except Exception:
            if staging.exists() and not source.exists():
                try:
                    os.replace(staging, source)
                    self.durability.fsync_directory(source.parent)
                except OSError:
                    pass
            raise

    def quarantine_data(
        self,
        path_key: str,
        data: bytes,
        *,
        reason: str,
        discovered_by: str,
    ) -> Path:
        target = self.target_dir(path_key)
        staging = target / f".diagnostic.tmp.{uuid.uuid4()}"
        staging.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with staging.open("xb") as stream:
            stream.write(data)
            stream.flush()
        os.chmod(staging, 0o600)
        self.durability.fsync_file(staging)
        if staging.read_bytes() != data:
            staging.unlink(missing_ok=True)
            raise StoreError("content_mismatch", 2, "diagnostic temporary write mismatch")
        return self.quarantine(
            path_key,
            staging,
            reason=reason,
            discovered_by=discovered_by,
        )