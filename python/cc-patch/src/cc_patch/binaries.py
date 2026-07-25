import os
from pathlib import Path


MIN_BINARY_SIZE = 10_000_000  # SEA 二进制下限，过滤 shell wrapper
IS_WINDOWS = os.name == "nt"
BACKUP_SUFFIXES = {".ccbak", ".ccsnap", ".ccpatched"}


def is_claude_binary(path: Path) -> bool:
    """对疑似 Claude Code SEA 二进制返回 True（排除 shell wrapper）。"""
    try:
        if not path.is_file() or path.stat().st_size < MIN_BINARY_SIZE:
            return False
        suffix = path.suffix.lower()
        # 接受无扩展名、.exe、或形如 2.1.175 的点号版本文件名。
        return suffix in {"", ".exe"} or suffix.lstrip(".").isdigit()
    except OSError:
        return False


def _add_candidate(found: list[Path], seen: set[Path], candidate: Path) -> None:
    try:
        resolved = candidate.expanduser().resolve(strict=True)
    except OSError:
        return
    if not is_claude_binary(resolved) or resolved in seen:
        return
    seen.add(resolved)
    found.append(resolved)


def iter_editor_extension_candidates(home: Path) -> list[Path]:
    """编辑器扩展内置的 native-binary（VSCode / Cursor / Windsurf / VSCodium 等）。

    路径形如::

        <home>/.vscode-server/extensions/anthropic.claude-code-<ver>-<plat>/
            resources/native-binary/claude[.exe]
    """
    ext_roots = [
        ".vscode/extensions",
        ".vscode-server/extensions",
        ".vscode-insiders/extensions",
        ".vscode-server-insiders/extensions",
        ".vscodium/extensions",
        ".vscodium-server/extensions",
        ".cursor/extensions",
        ".cursor-server/extensions",
        ".windsurf/extensions",
        ".windsurf-server/extensions",
    ]
    bin_names = ("claude.exe", "claude") if IS_WINDOWS else ("claude",)
    candidates: list[Path] = []
    for rel in ext_roots:
        root = home.joinpath(*rel.split("/"))
        if not root.is_dir():
            continue
        for entry in sorted(root.iterdir()):
            if not entry.is_dir() or not entry.name.startswith("anthropic.claude-code-"):
                continue
            native_dir = entry / "resources" / "native-binary"
            for name in bin_names:
                candidates.append(native_dir / name)
    return candidates


def iter_path_candidates() -> list[Path]:
    names = ("claude.exe", "claude") if IS_WINDOWS else ("claude",)
    candidates: list[Path] = []
    seen_dirs: set[str] = set()
    for entry in os.environ.get("PATH", "").split(os.pathsep):
        if not entry:
            continue
        directory = Path(entry.strip('"')).expanduser()
        norm = str(directory).lower() if IS_WINDOWS else str(directory)
        if norm in seen_dirs:
            continue
        seen_dirs.add(norm)
        for name in names:
            candidates.append(directory / name)
    return candidates


def iter_homebrew_candidates() -> list[Path]:
    candidates: list[Path] = []
    for prefix in (Path("/opt/homebrew"), Path("/usr/local"), Path("/home/linuxbrew/.linuxbrew")):
        candidates.append(prefix / "bin/claude")
        caskroom = prefix / "Caskroom/claude-code"
        if caskroom.is_dir():
            for version_dir in sorted(caskroom.iterdir()):
                candidates.append(version_dir / "claude")
    return candidates


def iter_winget_candidates() -> list[Path]:
    if not IS_WINDOWS:
        return []
    candidates: list[Path] = []
    local_appdata = os.environ.get("LOCALAPPDATA")
    if local_appdata:
        base = Path(local_appdata)
        candidates.append(base / "Microsoft/WindowsApps/claude.exe")
        packages = base / "Microsoft/WinGet/Packages"
        if packages.is_dir():
            for pkg in sorted(packages.glob("Anthropic.ClaudeCode_*")):
                candidates.extend(sorted(pkg.rglob("claude.exe")))
        candidates.append(base / "Programs/Anthropic/Claude Code/claude.exe")
        candidates.append(base / "Programs/Claude Code/claude.exe")
    program_files = os.environ.get("ProgramFiles")
    if program_files:
        candidates.append(Path(program_files) / "Anthropic/Claude Code/claude.exe")
        candidates.append(Path(program_files) / "Claude Code/claude.exe")
    return candidates


def detect_binaries(home: Path | None = None) -> list[Path]:
    """自动检测官方安装方式 + 编辑器扩展内置的 Claude Code 二进制。"""
    home = home or Path.home()
    found: list[Path] = []
    seen: set[Path] = set()

    _add_candidate(found, seen, home / ".local/bin/claude.exe")
    _add_candidate(found, seen, home / ".local/bin/claude")

    versions_dir = home / ".local/share/claude/versions"
    if versions_dir.is_dir():
        for entry in sorted(versions_dir.iterdir()):
            if entry.suffix in BACKUP_SUFFIXES:
                continue
            if entry.is_file():
                _add_candidate(found, seen, entry)
            elif entry.is_dir():
                _add_candidate(found, seen, entry / "claude.exe")
                _add_candidate(found, seen, entry / "claude")

    for c in iter_editor_extension_candidates(home):
        _add_candidate(found, seen, c)
    for c in iter_path_candidates():
        _add_candidate(found, seen, c)
    for c in iter_homebrew_candidates():
        _add_candidate(found, seen, c)
    for c in iter_winget_candidates():
        _add_candidate(found, seen, c)

    return found
