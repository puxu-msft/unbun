from __future__ import annotations

import errno
import fcntl
import json
import os
import pty
import select
import struct
import subprocess
import sys
import termios
import time
from pathlib import Path

import pyte
import pytest


_DRIVER = r'''
import json
import os
from pathlib import Path

from cc_patch.tui.app import CcPatchApp, FeatureRow

rows = [FeatureRow(**{**row, "binary": Path(row["binary"])}) for row in json.loads(os.environ["CC_PATCH_RENDER_ROWS"])]

class RenderApp(CcPatchApp):
    def _load_rows(self):
        return rows

if os.environ.get("CC_PATCH_BAD_LAYOUT") == "1":
    RenderApp.CSS += """
    #warning { dock: bottom; }
    #progress { dock: bottom; }
    #summary { dock: bottom; }
    """

RenderApp([Path(row.binary) for row in rows]).run()
'''

_TRANSACTION_DRIVER = r'''
import os
from pathlib import Path

from cc_patch.tui.app import CcPatchApp

CcPatchApp([Path(os.environ["CC_PATCH_RENDER_BINARY"])]).run()
'''

_FEATURES = ("source-exec", "agent-model", "channels")


def _rows_for_binaries(
    tmp_path: Path,
    binaries: list[tuple[str, bool, dict[str, str]]],
) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    index = 0
    for binary_index, (version, baseline, statuses) in enumerate(binaries):
        if binary_index == 0:
            path = tmp_path / "versions" / version / "claude"
        else:
            path = (
                tmp_path
                / "vscode-server"
                / "extensions"
                / f"anthropic.claude-code-{version}-linux-x64"
                / "resources"
                / "native-binary"
                / "claude"
            )
        for feature in _FEATURES:
            rows.append(
                {
                    "index": index,
                    "binary": str(path),
                    "version": version,
                    "size_mb": 247.0,
                    "feature": feature,
                    "state": statuses[feature],
                    "has_baseline": baseline,
                }
            )
            index += 1
    return rows


def _fixture_rows(tmp_path: Path) -> list[dict[str, object]]:
    return _rows_for_binaries(
        tmp_path,
        [
            (
                "2.1.207",
                True,
                {"source-exec": "patched", "agent-model": "clean", "channels": "patched"},
            ),
            (
                "2.1.195",
                False,
                {"source-exec": "clean", "agent-model": "mixed", "channels": "unsupported"},
            ),
        ],
    )


def _history_row_text(row: object, cols: int) -> str:
    try:
        return "".join(row[column].data if column in row else " " for column in range(cols)).rstrip()  # type: ignore[operator]
    except Exception:
        return ""


def _screen_text(screen: pyte.HistoryScreen) -> str:
    top = [_history_row_text(row, screen.columns) for row in screen.history.top]
    current = [
        _history_row_text(screen.buffer[row], screen.columns)
        for row in range(screen.lines)
    ]
    bottom = [_history_row_text(row, screen.columns) for row in screen.history.bottom]
    return "\n".join([*top, *current, *bottom])


def _normalized_grid(text: str) -> str:
    relevant = (
        "cc-patch |",
        "baseline:",
        "source-exec",
        "agent-model",
        "channels",
        "pending",
    )
    return "\n".join(
        line.rstrip() for line in text.splitlines() if any(token in line for token in relevant)
    )


def _spawn_render(
    rows: list[dict[str, object]],
    cols: int,
    *,
    keys: bytes,
    expected_text: str,
    bad_layout: bool = False,
    deadline_seconds: float = 10,
) -> tuple[int, str]:
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, cols, 0, 0))
    env = dict(os.environ)
    env["CC_PATCH_RENDER_ROWS"] = json.dumps(rows)
    if bad_layout:
        env["CC_PATCH_BAD_LAYOUT"] = "1"
    process = subprocess.Popen(
        [sys.executable, "-c", _DRIVER],
        stdin=slave,
        stdout=slave,
        stderr=slave,
        close_fds=True,
        cwd=Path(__file__).parents[1],
        env=env,
    )
    os.close(slave)
    screen = pyte.HistoryScreen(cols, 24, history=2000, ratio=0.5)
    stream = pyte.ByteStream(screen)
    sent_keys = False
    sent_quit = False
    saw_expected = False
    saw_ready = False
    captured_text = ""
    deadline = time.monotonic() + deadline_seconds
    try:
        while time.monotonic() < deadline:
            readable, _, _ = select.select([master], [], [], 0.05)
            if readable:
                try:
                    data = os.read(master, 65536)
                except OSError as error:
                    if error.errno == errno.EIO:
                        break
                    raise
                if data:
                    stream.feed(data)
            text = _screen_text(screen)
            if "pending" in text and "checked=target" in text:
                saw_ready = True
            if saw_ready and not sent_keys:
                os.write(master, keys)
                sent_keys = True
            if sent_keys and expected_text in text:
                captured_text = text
                saw_expected = True
                time.sleep(0.05)
                readable, _, _ = select.select([master], [], [], 0)
                if readable:
                    try:
                        data = os.read(master, 65536)
                    except OSError as error:
                        if error.errno != errno.EIO:
                            raise
                    else:
                        if data:
                            stream.feed(data)
                        captured_text = _screen_text(screen)
                if process.poll() is None:
                    os.write(master, b"\x1b")
                sent_quit = True
            if process.poll() is not None:
                break
        if not sent_quit:
            os.write(master, b"\x1b")
            sent_quit = True
        return_code = process.wait(timeout=3)
        while True:
            readable, _, _ = select.select([master], [], [], 0.05)
            if not readable:
                break
            try:
                data = os.read(master, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not data:
                break
            stream.feed(data)
    finally:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=3)
        os.close(master)
    final_text = _screen_text(screen)
    assert saw_ready, final_text
    assert sent_keys, final_text
    assert saw_expected, final_text
    assert sent_quit, final_text
    return return_code, captured_text


def _spawn_transaction(binary: Path, store: Path, cols: int) -> tuple[int, str, bytes]:
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, cols, 0, 0))
    initial_termios = termios.tcgetattr(slave)
    env = dict(os.environ)
    env["CC_PATCH_RENDER_BINARY"] = str(binary)
    env["UNBUN_CC_STORE"] = str(store)
    process = subprocess.Popen(
        [sys.executable, "-c", _TRANSACTION_DRIVER],
        stdin=slave,
        stdout=slave,
        stderr=slave,
        close_fds=True,
        cwd=Path(__file__).parents[1],
        env=env,
    )
    os.close(slave)
    screen = pyte.HistoryScreen(cols, 24, history=2000, ratio=0.5)
    stream = pyte.ByteStream(screen)
    raw_output = bytearray()
    sent_toggle = False
    sent_apply = False
    sent_quit = False
    applied_text = ""
    deadline = time.monotonic() + 10
    try:
        while time.monotonic() < deadline:
            readable, _, _ = select.select([master], [], [], 0.05)
            if readable:
                try:
                    data = os.read(master, 65536)
                except OSError as error:
                    if error.errno == errno.EIO:
                        break
                    raise
                if data:
                    raw_output.extend(data)
                    stream.feed(data)
            text = _screen_text(screen)
            if not sent_toggle and "0 pending" in text and "source-exec" in text:
                os.write(master, b" ")
                sent_toggle = True
            if sent_toggle and not sent_apply and "1 pending" in text:
                os.write(master, b"\r")
                sent_apply = True
            source_lines = [
                line for line in text.splitlines() if "source-exec" in line
            ]
            if (
                sent_apply
                and not sent_quit
                and "Done: 1 / 1 succeeded" in text
                and any("PATCHED" in line for line in source_lines)
            ):
                applied_text = text
                os.write(master, b"\x1b")
                sent_quit = True
            if process.poll() is not None:
                break
        if not sent_quit and process.poll() is None:
            os.write(master, b"\x1b")
        return_code = process.wait(timeout=3)
        while True:
            readable, _, _ = select.select([master], [], [], 0.05)
            if not readable:
                break
            try:
                data = os.read(master, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not data:
                break
            raw_output.extend(data)
            stream.feed(data)
        restored_termios = termios.tcgetattr(master)
    finally:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=3)
        os.close(master)
    assert sent_toggle, _screen_text(screen)
    assert sent_apply, _screen_text(screen)
    assert sent_quit, _screen_text(screen)
    assert applied_text, _screen_text(screen)
    assert restored_termios == initial_termios
    return return_code, applied_text, bytes(raw_output)


def _group_lines(text: str) -> list[str]:
    return [line.rstrip() for line in text.splitlines() if "baseline:" in line]


def _summary_lines(text: str) -> list[str]:
    return [line.rstrip() for line in text.splitlines() if "pending" in line]


def _progress_lines(text: str) -> list[str]:
    return [
        line.rstrip()
        for line in text.splitlines()
        if any(token in line for token in ("Running", "Done:", "Nothing to apply", "Probed"))
    ]


def test_real_terminal_progress_line_is_visible_and_not_overlapped_by_summary(tmp_path):
    # 回归：三行反馈曾各自 dock:bottom 重叠到同一行，令 #progress 不可见。
    # 用 mixed 态（入站即被自动勾选）-> 单个 enter 即触发执行，避免多步按键竞态。
    # 执行后 progress（Done/refreshed）与 summary（N pending）须为两条独立可见行。
    _, text = _spawn_render(
        _rows_for_binaries(
            tmp_path,
            [
                (
                    "2.1.207",
                    True,
                    {"source-exec": "mixed", "agent-model": "clean", "channels": "clean"},
                )
            ],
        ),
        100,
        keys=b"\r",  # enter 直接执行（mixed 已自动勾选）
        expected_text="Done:",
    )

    progress = _progress_lines(text)
    summary = _summary_lines(text)
    assert progress, text
    # progress（完成…）行可见，且「状态已刷新」确已渲染到屏幕（宽终端下可能换行到下一行）。
    assert any("Done:" in line for line in progress), text
    assert "refreshed" in text, text
    assert summary, text
    # progress 行与 summary 行是不同屏幕行（不再重叠），且 progress 行不含 summary 内容。
    assert all("pending" not in line for line in progress), text
    assert all("Done:" not in line for line in summary), text


def test_real_terminal_harness_rejects_known_bad_footer_layout(tmp_path):
    rows = _rows_for_binaries(
        tmp_path,
        [
            (
                "2.1.207",
                True,
                {"source-exec": "mixed", "agent-model": "clean", "channels": "clean"},
            )
        ],
    )

    with pytest.raises(AssertionError, match="cc-patch"):
        _spawn_render(
            rows,
            100,
            keys=b"\r",
            expected_text="Done:",
            bad_layout=True,
            deadline_seconds=1,
        )


def test_real_terminal_transaction_updates_badge_and_restores_terminal(
    tmp_path, make_bundle
):
    binary = tmp_path / "claude"
    binary.write_bytes(bytes(make_bundle()))

    return_code, text, raw_output = _spawn_transaction(
        binary, tmp_path / "shared-store", 100
    )

    assert return_code == 0
    source_lines = [line for line in text.splitlines() if "source-exec" in line]
    assert any("[x]" in line and "PATCHED" in line for line in source_lines), text
    assert "Done: 1 / 1 succeeded" in text
    assert b"\x1b[?25h" in raw_output
    assert b"\x1b[?1049l" in raw_output


@pytest.mark.parametrize("cols", [80, 100, 120])
def test_real_terminal_keeps_feature_status_and_grouping_visible(tmp_path, cols):
    return_code, text = _spawn_render(
        _fixture_rows(tmp_path),
        cols,
        keys=b"\x1b[B ",
        expected_text="-> patch[agent-model]",
    )

    assert return_code == 0
    for feature in _FEATURES:
        assert feature in text
    for state in ("CLEAN", "PATCHED", "MIXED", "UNSUPPORTED"):
        assert state in text
    group_lines = _group_lines(text)
    feature_lines = [
        line
        for line in text.splitlines()
        if any(f"] {feature}" in line for feature in _FEATURES)
    ]
    assert len(group_lines) == 2
    assert all(line.startswith(" ") for line in feature_lines)
    assert all(
        len(line) - len(line.lstrip())
        > len(group_lines[0]) - len(group_lines[0].lstrip())
        for line in feature_lines
    )
    assert "-> patch[agent-model]" in group_lines[0]


def test_real_terminal_badge_patches_new_feature(tmp_path):
    _, text = _spawn_render(
        _rows_for_binaries(
            tmp_path,
            [("2.1.207", True, {feature: "clean" for feature in _FEATURES})],
        ),
        80,
        keys=b" ",
        expected_text="-> patch[source-exec]",
    )

    assert "-> patch[source-exec]" in _group_lines(text)[0]
    assert _summary_lines(text) == [
        " 1 pending | checked=target | enter run | space toggle | a visible | esc quit"
    ]


def test_real_terminal_badge_shows_full_revert(tmp_path):
    _, text = _spawn_render(
        _rows_for_binaries(
            tmp_path,
            [("2.1.207", True, {feature: "patched" for feature in _FEATURES})],
        ),
        80,
        keys=b"a",
        expected_text="-> revert all",
    )

    assert "-> revert all" in _group_lines(text)[0]
    assert "1 pending" in _summary_lines(text)[0]


def test_real_terminal_badge_shows_mixed_replay(tmp_path):
    _, text = _spawn_render(
        _rows_for_binaries(
            tmp_path,
            [
                (
                    "2.1.207",
                    True,
                    {"source-exec": "mixed", "agent-model": "clean", "channels": "clean"},
                )
            ],
        ),
        80,
        keys=b"\x1b[B\x1b[A",
        expected_text="-> replay mixed",
    )

    assert "-> replay mixed" in _group_lines(text)[0]
    assert "1 pending" in _summary_lines(text)[0]


def test_real_terminal_dependency_closure_no_change_has_no_badge(tmp_path):
    _, text = _spawn_render(
        _rows_for_binaries(
            tmp_path,
            [
                (
                    "2.1.207",
                    True,
                    {"source-exec": "patched", "agent-model": "clean", "channels": "patched"},
                )
            ],
        ),
        80,
        keys=b" ",
        expected_text="0 pending",
    )

    assert "->" not in _group_lines(text)[0]
    assert "replay mixed" not in text
    assert "0 pending" in _summary_lines(text)[0]


def test_real_terminal_unchanged_binary_has_no_badge_and_summary_is_single_line(tmp_path):
    _, text = _spawn_render(
        _rows_for_binaries(
            tmp_path,
            [
                ("2.1.207", True, {feature: "clean" for feature in _FEATURES}),
                ("2.1.195", False, {feature: "clean" for feature in _FEATURES}),
            ],
        ),
        80,
        keys=b" ",
        expected_text="-> patch[source-exec]",
    )

    groups = _group_lines(text)
    assert "-> patch[source-exec]" in groups[0]
    assert "->" not in groups[1]
    summary = _summary_lines(text)
    assert len(summary) == 1
    assert "1 pending" in summary[0]


def test_real_terminal_render_is_deterministic_across_widths(tmp_path):
    rows = _fixture_rows(tmp_path)
    for cols in (80, 100, 120):
        snapshots = []
        for _ in range(3):
            return_code, text = _spawn_render(
                rows,
                cols,
                keys=b"\x1b[B ",
                expected_text="-> patch[agent-model]",
            )
            assert return_code == 0
            snapshots.append(_normalized_grid(text))
        assert snapshots[1:] == snapshots[:-1]
