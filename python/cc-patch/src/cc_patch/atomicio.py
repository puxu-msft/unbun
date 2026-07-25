import hashlib
import errno
import os
import re
import stat
import tempfile
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path

from cc_patch.models import SnapshotInfo
from cc_patch.probe import extract_version


BACKUP_DIR = Path(__file__).resolve().parents[2] / "backups"
_VERSION_PATTERN = re.compile(r"[0-9]+(?:\.[0-9]+)*", re.ASCII)
_SNAPSHOT_SLUG_PATTERN = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*", re.ASCII)


def is_valid_version_format(version: str) -> bool:
    return _VERSION_PATTERN.fullmatch(version) is not None


def is_valid_snapshot_slug(name: str) -> bool:
    return _SNAPSHOT_SLUG_PATTERN.fullmatch(name) is not None


def binary_path_hash(binary: Path) -> str:
    canonical = str(binary.resolve())
    return hashlib.sha256(canonical.encode()).hexdigest()[:12]


def _binary_tag(binary: Path) -> str:
    return f"{binary_path_hash(binary)}__{binary.name}"


def baseline_path(binary: Path, version: str) -> Path:
    """Return the version-keyed clean baseline outside launcher-scanned directories."""
    if not is_valid_version_format(version):
        raise ValueError(f"Invalid version format: {version!r}")
    # Backups must stay outside Claude's versions/ directory. The launcher applies
    # semver coercion and may otherwise select a backup as the executable binary.
    return BACKUP_DIR / f"{_binary_tag(binary)}__{version}.ccbak"


def snapshot_path(binary: Path, version: str, slug: str) -> Path:
    if not is_valid_version_format(version):
        raise ValueError(f"Invalid version format: {version!r}")
    if not is_valid_snapshot_slug(slug):
        raise ValueError(f"Invalid snapshot name: {slug!r}")
    return BACKUP_DIR / f"{_binary_tag(binary)}__{version}--{slug}.ccsnap"


class BaselineExists(FileExistsError):
    pass


class VersionDrift(ValueError):
    def __init__(self, expected: str, actual: str):
        self.expected = expected
        self.actual = actual
        super().__init__(f"Baseline version {expected} differs from current binary version {actual}")


class SnapshotExists(FileExistsError):
    pass


class SnapshotNotFound(FileNotFoundError):
    pass


class AmbiguousSnapshot(ValueError):
    pass


class ConcurrentFileChange(RuntimeError):
    pass


class AtomicContentMismatch(RuntimeError):
    pass


class BinaryInUse(RuntimeError):
    def __init__(self, binary: Path, ready_temp: Path):
        self.binary = binary
        self.ready_temp = ready_temp
        super().__init__(f"Cannot replace {binary}; verified replacement is ready at {ready_temp}")


def find_baseline(binary: Path, version: str) -> Path | None:
    path = baseline_path(binary, version)
    return path if path.is_file() else None


def prepare_baseline(binary: Path, data: bytes, version: str) -> Path:
    """Write and fsync a hidden baseline candidate without publishing it."""
    final = baseline_path(binary, version)
    final.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(
        dir=final.parent,
        prefix=f".{final.name}.",
        suffix=".tmp",
    )
    temp = Path(name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        return temp
    except Exception:
        try:
            os.close(descriptor)
        except OSError:
            pass
        temp.unlink(missing_ok=True)
        raise


def _fsync_directory(directory: Path) -> None:
    descriptor = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def publish_baseline_noreplace(temp: Path, final: Path) -> Path:
    """Atomically publish a prepared baseline without replacing an existing one."""
    try:
        os.link(temp, final)
    except FileExistsError as error:
        raise BaselineExists(final) from error
    try:
        _fsync_directory(final.parent)
    except Exception:
        final.unlink(missing_ok=True)
        raise
    finally:
        temp.unlink(missing_ok=True)
    return final


def establish_baseline(binary: Path, data: bytes, version: str) -> Path:
    """Compatibility helper using the same prepared, no-clobber publication path."""
    final = baseline_path(binary, version)
    temp = prepare_baseline(binary, data, version)
    try:
        return publish_baseline_noreplace(temp, final)
    finally:
        temp.unlink(missing_ok=True)


def quarantine_baseline(path: Path) -> Path | None:
    """Move an active baseline out of the ``*.ccbak`` discovery namespace."""
    if not path.exists():
        return None
    descriptor, name = tempfile.mkstemp(
        dir=path.parent,
        prefix=f"{path.name}.stale.",
        suffix=".quarantine",
    )
    os.close(descriptor)
    quarantine = Path(name)
    quarantine.unlink()
    os.replace(path, quarantine)
    _fsync_directory(path.parent)
    return quarantine


def save_snapshot(
    binary: Path,
    data: bytes,
    version: str,
    slug: str,
    *,
    force: bool = False,
) -> Path:
    from cc_patch import snapshots

    return snapshots.save_data(binary, data, version, slug, force=force)


def _snapshot_prefix(binary: Path) -> str:
    return f"{_binary_tag(binary)}__"


def list_snapshots(binary: Path, current_version: str) -> list[SnapshotInfo]:
    from cc_patch import snapshots

    return snapshots.list_for_binary(binary, current_version=current_version)


def remove_snapshot(binary: Path, slug: str, *, version: str | None = None) -> Path:
    from cc_patch import snapshots

    return snapshots.remove(binary, slug, version=version)


def _prepare_atomic_temp(binary: Path, data: bytes) -> Path:
    tmp = binary.parent / f".{binary.name}.tmp.{uuid.uuid4()}"
    descriptor = os.open(
        tmp,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL,
        0o600,
    )
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(tmp, stat.S_IMODE(os.stat(binary).st_mode))
        if tmp.read_bytes() != data:
            raise AtomicContentMismatch(f"temporary write mismatch: {tmp}")
        return tmp
    except Exception:
        try:
            os.close(descriptor)
        except OSError:
            pass
        tmp.unlink(missing_ok=True)
        raise


def _replace_atomic_temp(binary: Path, tmp: Path) -> None:
    try:
        os.replace(tmp, binary)
    except OSError as error:
        if isinstance(error, PermissionError) or error.errno == errno.EBUSY:
            raise BinaryInUse(binary, tmp) from error
        raise


def atomic_write(binary: Path, data: bytes) -> None:
    tmp = _prepare_atomic_temp(binary, data)
    try:
        _replace_atomic_temp(binary, tmp)
    except BinaryInUse:
        raise
    except Exception:
        tmp.unlink(missing_ok=True)
        raise


def atomic_write_if_unchanged(
    binary: Path,
    data: bytes,
    expected_current: bytes,
    *,
    before_replace: Callable[[bytes], None] | None = None,
) -> None:
    tmp = _prepare_atomic_temp(binary, data)
    try:
        observed = binary.read_bytes()
        if observed != expected_current:
            tmp.unlink(missing_ok=True)
            raise ConcurrentFileChange(f"File changed during write: {binary}")
        if before_replace is not None:
            before_replace(observed)
        _replace_atomic_temp(binary, tmp)
    except (ConcurrentFileChange, BinaryInUse):
        raise
    except Exception:
        tmp.unlink(missing_ok=True)
        raise
