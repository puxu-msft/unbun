from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

from cc_patch import atomicio
from cc_patch.store import StoreError, StoreV1


Verifier = Callable[[bytes], None]
CommittedVerifier = Callable[[bytes, bool], None]


def commit(
    binary: Path,
    result: bytes,
    entry_data: bytes,
    *,
    store: StoreV1,
    path_key: str,
    verify_before_replace: Verifier,
    verify_committed: CommittedVerifier,
    codesign: Callable[[], None] | None = None,
) -> bool:
    try:
        atomicio.atomic_write_if_unchanged(
            binary,
            result,
            entry_data,
            before_replace=verify_before_replace,
        )
    except atomicio.ConcurrentFileChange as error:
        raise StoreError(
            "concurrent_binary_change",
            1,
            f"Binary changed immediately before replace: {binary}",
        ) from error
    except atomicio.BinaryInUse as error:
        quarantine = store.quarantine_ready_temp(
            path_key,
            error.ready_temp,
            discovered_by="python",
        )
        raise StoreError(
            "binary_in_use",
            3,
            f"Binary is in use; verified replacement moved to {quarantine / 'artifact'}",
        ) from error

    try:
        verify_committed(binary.read_bytes(), False)
        if codesign is not None:
            try:
                codesign()
            except Exception as error:
                raise StoreError("codesign_failed", 3, str(error)) from error
            verify_committed(binary.read_bytes(), True)
    except Exception as original_error:
        try:
            atomicio.atomic_write(binary, entry_data)
            if binary.read_bytes() != entry_data:
                raise RuntimeError("rollback readback differs from transaction entry")
        except Exception as rollback_error:
            diagnostic = store.quarantine_data(
                path_key,
                entry_data,
                reason="rollback_failed",
                discovered_by="python",
            )
            raise StoreError(
                "rollback_failed",
                2,
                "Post-write verification failed and rollback failed; "
                f"entry diagnostic preserved at {diagnostic / 'artifact'}; "
                f"original error: {type(original_error).__name__}: {original_error}; "
                f"rollback error: {type(rollback_error).__name__}: {rollback_error}",
            ) from rollback_error
        if isinstance(original_error, StoreError):
            raise original_error
        raise StoreError("content_mismatch", 2, str(original_error)) from original_error
    return codesign is not None