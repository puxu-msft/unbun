"""打包副本与共享契约源的防漂移锁（L3C-10 的配套守卫）。

为让 wheel 安装产物也能执行 fail-closed 平台写 gate，`platform-writes-v1.json` 被复制进
`cc_patch/data/` 并随 wheel 发布（源码树优先、安装环境回落到该副本）。副本天然带来漂移风险：
若 `contract/vectors/platform-writes-v1.json` 更新而副本没跟上，安装产物就会依据**过期的
gate 数据**决定是否允许写 production 二进制——这正是 gate 最不能出错的地方。

本测试把二者钉成逐字节一致，任何一侧单独改动都会失败，强制同步更新。
"""

from __future__ import annotations

import hashlib
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = PACKAGE_ROOT.parents[1]
CONTRACT_SOURCE = REPO_ROOT / "contract" / "vectors" / "platform-writes-v1.json"
PACKAGED_COPY = PACKAGE_ROOT / "src" / "cc_patch" / "data" / "platform-writes-v1.json"


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_packaged_platform_matrix_is_byte_identical_to_the_contract_source() -> None:
    assert CONTRACT_SOURCE.is_file(), f"missing shared contract source: {CONTRACT_SOURCE}"
    assert PACKAGED_COPY.is_file(), f"missing packaged copy: {PACKAGED_COPY}"

    assert _sha256(PACKAGED_COPY) == _sha256(CONTRACT_SOURCE), (
        "cc_patch/data/platform-writes-v1.json drifted from "
        "contract/vectors/platform-writes-v1.json. The packaged copy is what an installed "
        "wheel uses to decide whether a production write is allowed, so it must be updated "
        "in lockstep with the shared contract."
    )
