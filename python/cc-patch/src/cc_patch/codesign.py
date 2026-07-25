import platform
import shutil
import subprocess
from collections.abc import Callable
from pathlib import Path

from cc_patch.store import StoreError


Runner = Callable[[list[str]], subprocess.CompletedProcess]


class CodesignError(StoreError):
    def __init__(self, message: str):
        super().__init__("codesign_failed", 3, message)


def maybe_resign_macos(binary: Path, log, runner: Runner | None = None) -> None:
    if platform.system() != "Darwin":
        return
    codesign = shutil.which("codesign")
    manual = f"  codesign --remove-signature {binary}\n  codesign -s - {binary}"
    if not codesign:
        raise CodesignError(f"Patch written, but re-signing is required and codesign was not found. Run manually:\n{manual}")
    run = runner or (lambda args: subprocess.run(args, capture_output=True, text=True))
    remove = run([codesign, "--remove-signature", str(binary)])
    if remove.returncode != 0:
        raise CodesignError(
            f"Patch written, but removing the old signature failed: {(remove.stderr or remove.stdout).strip()}\nRun manually:\n{manual}"
        )
    sign = run([codesign, "-s", "-", str(binary)])
    if sign.returncode != 0:
        raise CodesignError(
            f"Patch written, but ad-hoc re-signing failed: {(sign.stderr or sign.stdout).strip()}\nRun manually:\n{manual}"
        )
    log("  OK macOS ad-hoc codesign")
