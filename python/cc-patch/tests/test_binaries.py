from pathlib import Path

from cc_patch import binaries


def make_large_file(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as handle:
        handle.truncate(binaries.MIN_BINARY_SIZE)
    return path


def test_finds_native_binary_in_fake_extension_tree(tmp_path):
    native = tmp_path / ".vscode-server" / "extensions" / "anthropic.claude-code-2.1.175-linux-x64" / "resources" / "native-binary"
    native.mkdir(parents=True)
    binary = native / "claude"
    binary.write_bytes(b"x")
    assert binary in binaries.iter_editor_extension_candidates(tmp_path)


def test_ignores_non_anthropic_extensions(tmp_path):
    native = tmp_path / ".cursor" / "extensions" / "some.other-ext" / "resources" / "native-binary"
    native.mkdir(parents=True)
    (native / "claude").write_bytes(b"x")
    assert binaries.iter_editor_extension_candidates(tmp_path) == []


def test_is_claude_binary_checks_size_and_suffix(tmp_path):
    assert not binaries.is_claude_binary(make_large_file(tmp_path / "claude.txt"))
    assert not binaries.is_claude_binary(tmp_path / "missing")
    small = tmp_path / "claude"
    small.write_bytes(b"small")
    assert not binaries.is_claude_binary(small)
    assert binaries.is_claude_binary(make_large_file(tmp_path / "claude"))
    assert binaries.is_claude_binary(make_large_file(tmp_path / "claude.exe"))
    assert binaries.is_claude_binary(make_large_file(tmp_path / "2.1.175"))


def test_path_candidates_deduplicate_directories(monkeypatch, tmp_path):
    monkeypatch.setenv("PATH", f"{tmp_path}{binaries.os.pathsep}{tmp_path}")
    assert binaries.iter_path_candidates() == [tmp_path / ("claude.exe" if binaries.IS_WINDOWS else "claude")]


def test_detect_binaries_deduplicates_sorts_and_filters_backups(monkeypatch, tmp_path):
    local = make_large_file(tmp_path / ".local" / "bin" / "claude")
    versions = tmp_path / ".local" / "share" / "claude" / "versions"
    older = make_large_file(versions / "2.1.174")
    newer = make_large_file(versions / "2.1.175")
    make_large_file(versions / "2.1.176.ccbak")
    make_large_file(versions / "2.1.176.ccsnap")
    make_large_file(versions / "2.1.176.ccpatched")
    uppercase_backup_dir = versions / "2.1.177.CCBAK"
    uppercase_backup = make_large_file(uppercase_backup_dir / "claude")
    local.with_name("claude.exe").symlink_to(local)

    monkeypatch.setattr(binaries, "iter_editor_extension_candidates", lambda _home: [])
    monkeypatch.setattr(binaries, "iter_path_candidates", lambda: [])
    monkeypatch.setattr(binaries, "iter_homebrew_candidates", lambda: [])
    monkeypatch.setattr(binaries, "iter_winget_candidates", lambda: [])

    assert binaries.detect_binaries(tmp_path) == [local.resolve(), older.resolve(), newer.resolve(), uppercase_backup.resolve()]
