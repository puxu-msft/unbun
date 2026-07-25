"""L4-01 回归：symlink 安装布局下写入目标与身份键必须同源（Python 侧）。

这条缺陷的教训比缺陷本身重要：它在 JS 侧已作为 L3B-01 修复（含 `test/patch/symlink-target.test.mjs`），
但因为 L3 是**按实现分线**评审的，Python 侧原样存活、且没有任何测试覆盖，直到 L4 合并态评审才发现。
双实现项目里，一侧发现的 Blocker 应默认视为两侧的 Blocker，直到另一侧被证否。

原状后果（在 `bin/claude -> versions/<ver>` 布局，即 `which claude` 的真实形态下）：
  ① os.replace 把 symlink 本身换成普通文件，真实二进制原封未动，却返回 edits=1 报成功；
  ② 同一用户路径算出两个 path_key，baseline 落在旧 key 下不可达；
  ③ 打上不可逆的 channels 后 revert 抛 channels_patched_no_baseline —— 永久无法回退。
"""

from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

PACKAGE_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = PACKAGE_DIR.parents[1]
CLEAN_GOLDEN = REPO_ROOT / "contract" / "golden" / "claude-v1" / "synthetic-2.1.175-clean.bin"


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _run_cli(args: list[str], store: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-m", "cc_patch", *args],
        cwd=PACKAGE_DIR,
        env={**os.environ, "UNBUN_CC_STORE": str(store), "PYTHONPATH": str(PACKAGE_DIR / "src")},
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        timeout=180,
    )


@pytest.fixture()
def layout(tmp_path: Path):
    """造 `bin/claude -> versions/2.1.175` 的真实安装布局。"""
    (tmp_path / "versions").mkdir()
    (tmp_path / "bin").mkdir()
    real = tmp_path / "versions" / "2.1.175"
    link = tmp_path / "bin" / "claude"
    shutil.copyfile(CLEAN_GOLDEN, real)
    real.chmod(0o755)
    link.symlink_to(real)
    return real, link, tmp_path / "store"


def test_patch_through_symlink_modifies_the_real_binary(layout) -> None:
    real, link, store = layout
    before = _sha256(real)

    result = _run_cli(["patch", "--binary", str(link), "--feature", "agent-model", "--json"], store)

    assert result.returncode == 0, result.stderr[:400]
    assert link.is_symlink(), "the symlink must survive; it must not be replaced by a regular file"
    assert _sha256(real) != before, "the real binary behind the symlink must be the one patched"


def test_symlink_and_real_path_share_one_store_namespace(layout) -> None:
    real, link, store = layout
    _run_cli(["patch", "--binary", str(link), "--feature", "agent-model", "--json"], store)
    _run_cli(["--binary", str(real), "--check", "--json"], store)

    targets = list((store / "v1" / "targets").iterdir())
    assert len(targets) == 1, (
        f"a symlink and its target must hash to one path_key, found {[t.name for t in targets]}"
    )


def test_irreversible_channels_can_still_be_reverted_through_the_symlink(layout) -> None:
    """最关键的一条：pathKey 漂移会让不可逆的 channels 永久失去 baseline。"""
    real, link, store = layout
    clean = _sha256(real)

    patched = _run_cli(["patch", "--binary", str(link), "--feature", "channels", "--json"], store)
    assert patched.returncode == 0, patched.stderr[:400]
    assert _sha256(real) != clean

    reverted = _run_cli(["revert", "--binary", str(link), "--json"], store)
    assert reverted.returncode == 0, f"revert must find the baseline: {reverted.stderr[:400]}"
    assert _sha256(real) == clean, "revert must restore the clean bytes exactly"


def test_status_reports_the_object_that_would_actually_be_written(layout) -> None:
    """status.path 会经 TUI 回流成写入目标，必须报 canonical 路径（与 JS 对齐）。"""
    real, link, store = layout

    result = _run_cli(["--binary", str(link), "--check", "--json"], store)

    assert result.returncode == 0, result.stderr[:400]
    assert str(real) in result.stdout
    assert f'"{link}"' not in result.stdout
