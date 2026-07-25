#!/usr/bin/env bash
# ARCHIVED — PoC/实验 provenance，勿运行。见 tools/unbun/
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DIST="${DIST:-$HERE}"

command -v bun >/dev/null || { echo "need bun in PATH" >&2; exit 1; }

bun build --compile "$HERE/entry.js" --outfile "$DIST/claude-shim"
