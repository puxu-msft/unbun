"""L3C-01 回归：写权限只能由显式 mutating 子命令授予。

Blocker 原状：`command = args.command or "patch"` 让无子命令调用在非 TTY 下默认 patch 全部
feature——`ccpatch --binary X` 实测把 clean golden 从 0a067e… 改写成 3a8abf…，直接违反
「裸非 TTY 只读」不变量（JS 侧同形调用是只读 status）。

这些测试走**真实 subprocess**（而非直接调 main_entry），因为该 Blocker 恰恰藏在参数分发 +
TTY 判定的接缝里；旧测试只覆盖「完全无参数」的裸调用，因而假绿。
"""

from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
CLEAN_GOLDEN = REPO_ROOT / "contract" / "golden" / "claude-v1" / "synthetic-2.1.175-clean.bin"
PACKAGE_DIR = Path(__file__).resolve().parents[1]


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _run_cli(args: list[str], store: Path) -> subprocess.CompletedProcess:
    env = {**os.environ, "UNBUN_CC_STORE": str(store)}
    return subprocess.run(
        [sys.executable, "-m", "cc_patch", *args],
        cwd=PACKAGE_DIR,
        env={**env, "PYTHONPATH": str(PACKAGE_DIR / "src")},
        stdin=subprocess.DEVNULL,  # 非 TTY
        capture_output=True,
        text=True,
        timeout=120,
    )


@pytest.fixture()
def target(tmp_path: Path) -> Path:
    binary = tmp_path / "claude"
    shutil.copyfile(CLEAN_GOLDEN, binary)
    binary.chmod(0o755)
    return binary


# 任何**只读选项**的组合都不得授予写权限——写权限只来自显式子命令。
@pytest.mark.parametrize(
    "extra",
    [
        [],
        ["--json"],
        ["--feature", "agent-model"],
        ["--yes"],
        ["--all"],
        ["--json", "--yes", "--all"],
    ],
    ids=["bare", "json", "feature", "yes", "all", "combined"],
)
def test_no_subcommand_never_writes_regardless_of_options(target: Path, tmp_path: Path, extra: list[str]) -> None:
    before = _sha256(target)
    store = tmp_path / "store"

    result = _run_cli(["--binary", str(target), *extra], store)

    assert _sha256(target) == before, (
        f"bare `ccpatch --binary X {' '.join(extra)}` must stay read-only, "
        f"but the target binary was rewritten (stdout={result.stdout[:200]!r})"
    )


def test_explicit_patch_subcommand_still_writes(target: Path, tmp_path: Path) -> None:
    """反向对照：修复不得矫枉过正——显式 mutating 子命令必须仍然能写。"""
    before = _sha256(target)

    result = _run_cli(["patch", "--binary", str(target), "--feature", "agent-model"], tmp_path / "store")

    assert result.returncode == 0, f"explicit patch failed: {result.stderr[:400]}"
    assert _sha256(target) != before, "explicit `ccpatch patch` must still apply the feature"
