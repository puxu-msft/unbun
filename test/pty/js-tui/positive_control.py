from __future__ import annotations

import errno
import fcntl
import os
import pty
import select
import struct
import subprocess
import termios
import unittest
from pathlib import Path

import pyte


ROOT = Path(__file__).resolve().parents[3]
BUN = os.environ.get("JS_TUI_BUN", "bun")
ENTRY = "test/pty/js-tui/fixtures/bad-layout.jsx"


def read_pty(master: int) -> bytes:
    try:
        return os.read(master, 65536)
    except OSError as error:
        if error.errno == errno.EIO:
            return b""
        raise


class TestScreenGridPositiveControl(unittest.TestCase):
    def test_right_edge_sentinel_survives_at_80_columns(self) -> None:
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))

        def claim_controlling_terminal() -> None:
            os.setsid()
            fcntl.ioctl(slave, termios.TIOCSCTTY, 0)

        process = subprocess.Popen(
            [BUN, "run", ENTRY],
            cwd=ROOT,
            stdin=slave,
            stdout=slave,
            stderr=slave,
            env={**os.environ, "TERM": "xterm-256color", "FORCE_COLOR": "0"},
            close_fds=True,
            preexec_fn=claim_controlling_terminal,
        )
        os.close(slave)
        screen = pyte.Screen(80, 24)
        stream = pyte.ByteStream(screen)
        try:
            while process.poll() is None:
                readable, _, _ = select.select([master], [], [], 0.2)
                if readable:
                    data = read_pty(master)
                    if data:
                        stream.feed(data)
            readable, _, _ = select.select([master], [], [], 0.1)
            if readable:
                data = read_pty(master)
                if data:
                    stream.feed(data)
        finally:
            if process.poll() is None:
                process.kill()
            process.wait(timeout=3)
            os.close(master)

        self.assertIn("RIGHT-EDGE", screen.display[0])


if __name__ == "__main__":
    unittest.main(verbosity=2)
