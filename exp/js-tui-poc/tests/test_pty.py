from __future__ import annotations

import fcntl
import os
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import sys
import termios
import time
import unittest
from pathlib import Path

import pyte


ROOT = Path(__file__).resolve().parents[1]
BUN = os.environ.get("POC_BUN") or shutil.which("bun")
if BUN is None:
    raise RuntimeError("bun executable not found; set POC_BUN to its absolute path")
COMMAND = [BUN, "run", "app.jsx"]


class InkSession:
    def __init__(self, columns: int = 80, rows: int = 24, extra_env: dict[str, str] | None = None):
        self.columns = columns
        self.rows = rows
        self.master, slave = pty.openpty()
        self.control_fd = os.dup(slave)
        self.initial_termios = termios.tcgetattr(slave)
        self.screen = pyte.Screen(columns, rows)
        self.stream = pyte.ByteStream(self.screen)
        self.output = bytearray()
        self._set_size(slave, columns, rows)
        env = dict(os.environ, TERM="xterm-256color", FORCE_COLOR="0", COLUMNS=str(columns), LINES=str(rows))
        env.update(extra_env or {})
        def claim_controlling_terminal() -> None:
            os.setsid()
            fcntl.ioctl(slave, termios.TIOCSCTTY, 0)

        self.process = subprocess.Popen(
            COMMAND,
            cwd=ROOT,
            stdin=slave,
            stdout=slave,
            stderr=slave,
            env=env,
            close_fds=True,
            preexec_fn=claim_controlling_terminal,
        )
        os.close(slave)

    def _set_size(self, fd: int, columns: int, rows: int) -> None:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))

    def resize(self, columns: int, rows: int = 24) -> None:
        self.columns = columns
        self.rows = rows
        self._set_size(self.master, columns, rows)
        self.screen.resize(rows, columns)
        self.process.send_signal(signal.SIGWINCH)

    def send(self, value: bytes) -> None:
        os.write(self.master, value)

    def type_text(self, value: str) -> None:
        for character in value:
            self.send(character.encode())
            self._drain(0.02)

    def wait_for(self, pattern: str, timeout: float = 4.0) -> str:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self._drain(0.1)
            text = self.text
            if re.search(pattern, text):
                return text
            if self.process.poll() is not None:
                break
        raise AssertionError(f"missing {pattern!r} in screen:\n{self.text}\nraw tail={bytes(self.output[-500:])!r}")

    def _drain(self, timeout: float) -> None:
        readable, _, _ = select.select([self.master], [], [], timeout)
        if not readable:
            return
        try:
            data = os.read(self.master, 65536)
        except OSError:
            return
        self.output.extend(data)
        self.stream.feed(data)

    @property
    def text(self) -> str:
        return "\n".join(line.rstrip() for line in self.screen.display)

    def close(self, key: bytes = b"\x1b") -> None:
        if self.process.poll() is None:
            self.send(key)
        try:
            self.process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=3)
        self._drain(0.1)
        try:
            restored = termios.tcgetattr(self.control_fd)
        finally:
            os.close(self.control_fd)
            os.close(self.master)
        for flag in (termios.ICANON, termios.ECHO, termios.ISIG, termios.IEXTEN):
            if bool(restored[3] & flag) != bool(self.initial_termios[3] & flag):
                raise AssertionError(
                    f"terminal flag {flag} was not restored: "
                    f"initial_lflag={self.initial_termios[3]} restored_lflag={restored[3]}"
                )
        for flag in (termios.IXON, termios.ICRNL):
            if bool(restored[0] & flag) != bool(self.initial_termios[0] & flag):
                raise AssertionError(f"terminal input flag {flag} was not restored")
        for index in (termios.VMIN, termios.VTIME):
            if restored[6][index] != self.initial_termios[6][index]:
                raise AssertionError(f"terminal control character {index} was not restored")
        if self.process.returncode != 0:
            raise AssertionError(f"TUI exited {self.process.returncode}")


class TestInkPty(unittest.TestCase):
    def assert_ready(self, session: InkSession, columns: int = 80) -> str:
        return session.wait_for(rf"VIEWPORT:{columns}x24 FOCUS:ON RAW:ON")

    def test_layout_positive_control_or_good_layout(self) -> None:
        session = InkSession(extra_env={"POC_BAD_LAYOUT": os.environ.get("POC_BAD_LAYOUT", "0")})
        try:
            self.assert_ready(session)
            header = session.screen.display[0]
            self.assertIn("RIGHT-EDGE", header)
        finally:
            session.close()

    def test_dynamic_filter_space_and_visible_bulk_toggle(self) -> None:
        session = InkSession()
        try:
            self.assert_ready(session)
            session.send(b"/")
            session.wait_for(r"MODE:FILTER FILTER:-")
            session.type_text("source")
            session.send(b"\r")
            text = session.wait_for(r"MODE:COMMAND FILTER:source")
            self.assertIn("VISIBLE:2", text)
            self.assertIn("stable source-exec", text)
            self.assertIn("canary source-exec", text)
            self.assertNotIn("agent-model", text)

            session.send(b"a")
            text = session.wait_for(r"> \[x\] /opt/claude/stable source-exec")
            self.assertIn("[ ] /srv/claude/canary source-exec STATE:unsupported DISABLED", text)

            session.send(b" ")
            session.wait_for(r"> \[ \] /opt/claude/stable source-exec")

            session.send(b"/")
            session.wait_for(r"MODE:FILTER FILTER:-")
            session.type_text("canary source")
            session.send(b"\r")
            text = session.wait_for(r"> \[ \] /srv/claude/canary source-exec STATE:unsupported DISABLED")
            self.assertIn("MODE:COMMAND FILTER:canary source", text)
            session.send(b" ")
            text = session.wait_for(r"EVENT:UNSUPPORTED_DISABLED")
            self.assertIn("[ ] /srv/claude/canary source-exec STATE:unsupported DISABLED", text)
        finally:
            session.close()

    def test_enter_shows_async_phase_and_refreshed_status(self) -> None:
        session = InkSession()
        try:
            self.assert_ready(session)
            session.send(b" ")
            session.wait_for(r"> \[x\] /opt/claude/stable source-exec STATE:clean")
            session.send(b"\r")
            session.wait_for(r"PHASE:APPLYING REFRESH:0")
            text = session.wait_for(r"PHASE:DONE REFRESH:1")
            self.assertIn("> [x] /opt/claude/stable source-exec STATE:patched", text)
        finally:
            session.close()

    def test_resize_keeps_header_and_reports_all_required_widths(self) -> None:
        session = InkSession()
        try:
            for columns in (80, 100, 120):
                if columns != 80:
                    session.resize(columns)
                self.assert_ready(session, columns)
                self.assertTrue(session.screen.display[0].endswith("RIGHT-EDGE"))
        finally:
            session.close()

    def test_q_exits_and_restores_terminal(self) -> None:
        session = InkSession()
        self.assert_ready(session)
        session.close(b"q")

    def test_escape_exits_and_restores_terminal(self) -> None:
        session = InkSession()
        self.assert_ready(session)
        session.close(b"\x1b")


if __name__ == "__main__":
    unittest.main(verbosity=2)