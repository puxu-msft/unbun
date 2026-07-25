from __future__ import annotations

import errno
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import subprocess
import tempfile
import termios
import time
import unittest
from pathlib import Path

import pyte


ROOT = Path(__file__).resolve().parents[3]
BUN = os.environ.get("JS_TUI_BUN", "bun")
DRIVER = "test/pty/js-tui/driver.mjs"


def read_pty(master: int) -> bytes:
    try:
        return os.read(master, 65536)
    except OSError as error:
        if error.errno == errno.EIO:
            return b""
        raise


class InkSession:
    def __init__(self, columns: int = 80, scenario: str = "standard"):
        self.columns = columns
        self.rows = 24
        self.master, slave = pty.openpty()
        self.control_fd = os.dup(slave)
        self.initial_termios = termios.tcgetattr(slave)
        self.screen = pyte.Screen(columns, self.rows)
        self.stream = pyte.ByteStream(self.screen)
        self.output = bytearray()
        self.temp = tempfile.TemporaryDirectory(prefix="unbun-js-tui-")
        self.trace = Path(self.temp.name) / "writes.jsonl"
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", self.rows, columns, 0, 0))

        def claim_controlling_terminal() -> None:
            os.setsid()
            fcntl.ioctl(slave, termios.TIOCSCTTY, 0)

        self.process = subprocess.Popen(
            [BUN, "run", DRIVER],
            cwd=ROOT,
            stdin=slave,
            stdout=slave,
            stderr=slave,
            env={
                **os.environ,
                "TERM": "xterm-256color",
                "FORCE_COLOR": "0",
                "JS_TUI_SCENARIO": scenario,
                "JS_TUI_TRACE": str(self.trace),
            },
            close_fds=True,
            preexec_fn=claim_controlling_terminal,
        )
        os.close(slave)

    @property
    def text(self) -> str:
        return "\n".join(line.rstrip() for line in self.screen.display)

    def drain(self, timeout: float = 0.1) -> None:
        readable, _, _ = select.select([self.master], [], [], timeout)
        while readable:
            data = read_pty(self.master)
            if not data:
                return
            self.output.extend(data)
            self.stream.feed(data)
            readable, _, _ = select.select([self.master], [], [], 0)

    def wait_for(self, pattern: str, timeout: float = 5.0) -> str:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.drain()
            if re.search(pattern, self.text):
                return self.text
            if self.process.poll() is not None:
                break
        raise AssertionError(f"missing {pattern!r} in screen:\n{self.text}\nraw tail={bytes(self.output[-600:])!r}")

    def send(self, value: bytes) -> None:
        os.write(self.master, value)

    def type_text(self, value: str) -> None:
        for character in value:
            self.send(character.encode())
            self.drain(0.01)

    def resize(self, columns: int) -> None:
        self.columns = columns
        fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", self.rows, columns, 0, 0))
        self.screen.resize(self.rows, columns)
        self.process.send_signal(signal.SIGWINCH)

    def writes(self) -> list[dict[str, object]]:
        if not self.trace.exists():
            return []
        return [json.loads(line) for line in self.trace.read_text().splitlines() if line]

    def close(self, key: bytes = b"\x1b", expected_exit: int = 0) -> None:
        if self.process.poll() is None:
            self.send(key)
        try:
            self.process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=3)
        self.drain(0.05)
        try:
            restored = termios.tcgetattr(self.control_fd)
        finally:
            os.close(self.control_fd)
            os.close(self.master)
            self.temp.cleanup()
        for flag in (termios.ICANON, termios.ECHO, termios.ISIG, termios.IEXTEN):
            self.assert_flag(restored[3], self.initial_termios[3], flag)
        for flag in (termios.IXON, termios.ICRNL):
            self.assert_flag(restored[0], self.initial_termios[0], flag)
        for index in (termios.VMIN, termios.VTIME):
            if restored[6][index] != self.initial_termios[6][index]:
                raise AssertionError(f"terminal control character {index} was not restored")
        if b"\x1b[?1049h" not in self.output or b"\x1b[?1049l" not in self.output:
            raise AssertionError("alternate screen enter/leave sequence missing")
        if b"\x1b[?25h" not in self.output:
            raise AssertionError("cursor restore sequence missing")
        if self.process.returncode != expected_exit:
            raise AssertionError(f"TUI exited {self.process.returncode}, expected {expected_exit}: {bytes(self.output[-600:])!r}")

    @staticmethod
    def assert_flag(restored: int, initial: int, flag: int) -> None:
        if bool(restored & flag) != bool(initial & flag):
            raise AssertionError(f"terminal flag {flag} was not restored")


class TestProductionInkPty(unittest.TestCase):
    def test_layout_is_stable_at_all_required_widths(self) -> None:
        session = InkSession()
        try:
            for columns in (80, 100, 120):
                if columns != 80:
                    session.resize(columns)
                text = session.wait_for(rf"VIEWPORT:{columns}x24 .* PHASE:READY")
                self.assertTrue(session.screen.display[0].endswith("RIGHT-EDGE"), session.screen.display[0])
                self.assertIn("/tmp/fixtures/stable/claude", text)
                self.assertIn("/tmp/fixtures/canary/claude", text)
                self.assertEqual(sum("Ready" in line for line in session.screen.display), 1)
                self.assertEqual(sum("0 pending" in line for line in session.screen.display), 1)
        finally:
            session.close()

    def test_filter_visible_toggle_and_unsupported_disabled(self) -> None:
        session = InkSession()
        try:
            session.wait_for(r"PHASE:READY")
            session.send(b"/")
            session.wait_for(r"MODE:FILTER FILTER:-")
            session.type_text("canary channels")
            session.send(b"\r")
            text = session.wait_for(r"FILTER:canary channels")
            self.assertIn("channels UNSUPPORTED DISABLED", text)
            self.assertNotIn("source-exec", text)
            session.send(b" ")
            session.send(b"a")
            self.assertIn("[ ] channels UNSUPPORTED DISABLED", session.wait_for(r"0 pending"))
            self.assertEqual(session.writes(), [])
        finally:
            session.close()

    def test_filter_keeps_hidden_selection_and_channels_plan_is_dependency_closed(self) -> None:
        session = InkSession()
        try:
            session.wait_for(r"PHASE:READY")
            session.send(b"/")
            session.wait_for(r"MODE:FILTER FILTER:-")
            session.type_text("stable channels")
            session.send(b"\r")
            session.wait_for(r"FILTER:stable channels")
            session.send(b" ")
            text = session.wait_for(r"patch\[source-exec,channels\]")
            self.assertIn("1 pending", text)
            session.send(b"/")
            session.wait_for(r"MODE:FILTER FILTER:-")
            session.type_text("stable agent-model")
            session.send(b"\r")
            self.assertIn("patch[source-exec,channels]", session.wait_for(r"FILTER:stable agent-model"))
        finally:
            session.close()

    def test_mixed_replay_double_submit_reprobe_and_second_submit(self) -> None:
        session = InkSession(scenario="mixed")
        try:
            text = session.wait_for(r"replay mixed")
            self.assertIn("[x] source-exec MIXED", text)
            session.send(b"\r")
            session.wait_for(r"PHASE:APPLYING")
            session.send(b"q")
            session.send(b"\r")
            text = session.wait_for(r"Done: 1/1 succeeded \| refreshed=1")
            self.assertIn("[x] source-exec PATCHED", text)
            self.assertEqual(len(session.writes()), 1)
            session.send(b" ")
            session.wait_for(r"revert all")
            session.send(b"\r")
            text = session.wait_for(r"Done: 1/1 succeeded \| refreshed=2")
            self.assertIn("[ ] source-exec CLEAN", text)
            writes = session.writes()
            self.assertEqual(len(writes), 2)
            self.assertEqual(writes[0]["targetFeatures"], ["source-exec"])
            self.assertEqual(writes[1]["targetFeatures"], [])
        finally:
            session.close()

    def test_multi_binary_progress_and_formal_error_remain_visible(self) -> None:
        session = InkSession(scenario="error")
        try:
            session.wait_for(r"PHASE:READY")
            session.send(b"a")
            session.wait_for(r"2 pending")
            session.send(b"\r")
            session.wait_for(r"Applying 0/2")
            text = session.wait_for(r"Done: 0/2 succeeded \| refreshed=1")
            self.assertIn("ERROR target_locked: fixture transaction rejected", text)
            self.assertEqual(len(session.writes()), 2)
        finally:
            session.close(expected_exit=1)

    def test_q_and_escape_restore_terminal(self) -> None:
        for key in (b"q", b"\x1b"):
            session = InkSession()
            session.wait_for(r"PHASE:READY")
            session.close(key)


if __name__ == "__main__":
    unittest.main(verbosity=2)