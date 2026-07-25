"""Regenerate the synthetic golden fixtures after auditing a Claude Code upgrade.

The original 2.1.175 fixtures were first verified byte-for-byte against the retired
legacy implementations. Future regeneration must repeat that compatibility audit
before replacing tracked bytes.
Run with ``uv run --directory scripts/cc-patch python tests/golden/_generate.py``.
"""

import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_ROOT))

from cc_patch import features  # noqa: E402
from cc_patch.probe import extract_version  # noqa: E402
from tests.conftest import make_bundle  # noqa: E402


GOLDEN_DIR = Path(__file__).resolve().parent


def main() -> None:
    clean = bytes(make_bundle())
    version = extract_version(clean)
    if version is None:
        raise RuntimeError("合成 bundle 缺少有效版本锚点，拒绝生成 golden")

    patched = bytearray(clean)
    for feature in features.REGISTRY.values():
        feature.apply(patched)

    clean_path = GOLDEN_DIR / f"synthetic-{version}-clean.bin"
    patched_path = GOLDEN_DIR / f"synthetic-{version}-all-patched.bin"
    clean_path.write_bytes(clean)
    patched_path.write_bytes(patched)
    print(f"wrote {clean_path} ({len(clean)} bytes)")
    print(f"wrote {patched_path} ({len(patched)} bytes)")


if __name__ == "__main__":
    main()
