from __future__ import annotations

import errno
import fcntl
import hashlib
import json
import os
import pty
import select
import shutil
import signal
import struct
import subprocess
import termios
import time
from pathlib import Path

import pyte

from normalizer import ScreenFacts, assert_expected, normalize_screen


ROOT = Path(__file__).resolve().parents[2]
GOLDEN = ROOT / "contract/golden/claude-v1/synthetic-2.1.175-clean.bin"
MIN_DISCOVERABLE_SIZE = 10 * 1024 * 1024
KEYS = {"enter": b"\r", "space": b" ", "escape": b"\x1b", "q": b"q", "a": b"a", "/": b"/"}
BAD_LAYOUT_ENTRY = "test/pty/js-tui/fixtures/bad-layout.jsx"


def read_pty(master: int) -> bytes:
    try:
        return os.read(master, 65536)
    except OSError as error:
        if error.errno == errno.EIO:
            return b""
        raise


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build_fixture(path: Path, fixture: str = "clean") -> None:
    data = bytearray(
        b'fixture overview",VERSION:"2.1.999" without feature anchors'
        if fixture == "unsupported"
        else GOLDEN.read_bytes()
    )
    if fixture == "mixed":
        data.extend(b"\n// @bun @bytecode\n")
    path.write_bytes(data)
    with path.open("ab") as handle:
        handle.truncate(MIN_DISCOVERABLE_SIZE)
    path.chmod(0o755)


def capture_bad_layout(columns: int) -> list[str]:
    rows = 24
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
    bun = shutil.which("bun")
    if bun is None:
        os.close(master)
        os.close(slave)
        raise AssertionError("bun must be available")

    def claim_controlling_terminal() -> None:
        os.setsid()
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)

    process = subprocess.Popen(
        [bun, "run", BAD_LAYOUT_ENTRY],
        cwd=ROOT,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        env={**os.environ, "TERM": "xterm-256color", "FORCE_COLOR": "0", "NO_COLOR": "1"},
        close_fds=True,
        preexec_fn=claim_controlling_terminal,
    )
    os.close(slave)
    screen = pyte.Screen(columns, rows)
    stream = pyte.ByteStream(screen)
    try:
        while process.poll() is None:
            readable, _, _ = select.select([master], [], [], 0.2)
            if readable:
                data = read_pty(master)
                if data:
                    stream.feed(data)
        while True:
            readable, _, _ = select.select([master], [], [], 0)
            if not readable:
                break
            data = read_pty(master)
            if not data:
                break
            stream.feed(data)
        if process.returncode != 0:
            raise AssertionError(f"bad-layout fixture exited {process.returncode}")
        return list(screen.display)
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=3)
        os.close(master)


def make_source_mixed(path: Path) -> None:
    import sys

    source_root = str(ROOT / "python/cc-patch/src")
    if source_root not in sys.path:
        sys.path.insert(0, source_root)
    from cc_patch.features import REGISTRY

    data = bytearray(path.read_bytes())
    feature = REGISTRY["source-exec"]
    substates = feature.observe_substates(bytes(data))
    if len(substates) < 2:
        raise AssertionError("mixed fixture requires at least two source-exec sites")
    feature.replay_substates(data, [substates[0]], "patched")
    if feature.detect(data).state != "mixed":
        raise AssertionError("official source-exec feature did not produce mixed state")
    path.write_bytes(data)


class PtySession:
    def __init__(self, implementation: str, binary: Path, store: Path, home: Path, columns: int):
        self.implementation = implementation
        self.columns = columns
        self.rows = 30
        self.master, slave = pty.openpty()
        self.control_fd = os.dup(slave)
        self.initial_termios = termios.tcgetattr(slave)
        self.screen = pyte.Screen(columns, self.rows)
        self.stream = pyte.ByteStream(self.screen)
        self.output = bytearray()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", self.rows, columns, 0, 0))

        bun = shutil.which("bun")
        uv = shutil.which("uv")
        if bun is None or uv is None:
            raise AssertionError("bun and uv must be available before PATH isolation")
        command = [bun, "cli.mjs", "cc"] if implementation == "js" else [uv, "run", "--directory", "python/cc-patch", "ccpatch"]

        def claim_controlling_terminal() -> None:
            os.setsid()
            fcntl.ioctl(slave, termios.TIOCSCTTY, 0)

        self.process = subprocess.Popen(
            command,
            cwd=ROOT,
            stdin=slave,
            stdout=slave,
            stderr=slave,
            env={
                **os.environ,
                "HOME": str(home),
                "PATH": str(binary.parent),
                "UNBUN_CC_STORE": str(store),
                "TERM": "xterm-256color",
                "FORCE_COLOR": "0",
                "NO_COLOR": "1",
            },
            close_fds=True,
            preexec_fn=claim_controlling_terminal,
        )
        os.close(slave)

    @property
    def facts(self) -> ScreenFacts:
        return normalize_screen(list(self.screen.display))

    def drain(self, timeout: float = 0.08) -> None:
        readable, _, _ = select.select([self.master], [], [], timeout)
        while readable:
            data = read_pty(self.master)
            if not data:
                return
            self.output.extend(data)
            self.stream.feed(data)
            readable, _, _ = select.select([self.master], [], [], 0)

    def wait_for(self, expected: dict[str, object], timeout: float = 8.0) -> ScreenFacts:
        deadline = time.monotonic() + timeout
        last_error: AssertionError | None = None
        while time.monotonic() < deadline:
            self.drain()
            try:
                assert_expected(self.facts, expected)
                return self.facts
            except AssertionError as error:
                last_error = error
            if self.process.poll() is not None:
                break
        raise AssertionError(f"{self.implementation} wait failed: {last_error}\nscreen:\n" + "\n".join(self.screen.display) + f"\nraw tail={bytes(self.output[-800:])!r}")

    def send(self, key: str) -> None:
        os.write(self.master, KEYS.get(key, key.encode()))
        self.drain(0.2)

    def type_text(self, text: str) -> None:
        for character in text:
            os.write(self.master, character.encode())
            self.drain(0.01)

    def close(self) -> None:
        if self.process.poll() is None:
            self.send("escape")
        try:
            self.process.wait(timeout=4)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=3)
            raise AssertionError(f"{self.implementation} TUI did not exit")
        self.drain(0.05)
        try:
            restored = termios.tcgetattr(self.control_fd)
        finally:
            os.close(self.control_fd)
            os.close(self.master)
        for flag in (termios.ICANON, termios.ECHO, termios.ISIG, termios.IEXTEN):
            if bool(restored[3] & flag) != bool(self.initial_termios[3] & flag):
                raise AssertionError(f"{self.implementation} did not restore terminal flag {flag}")
        for flag in (termios.IXON, termios.ICRNL):
            if bool(restored[0] & flag) != bool(self.initial_termios[0] & flag):
                raise AssertionError(f"{self.implementation} did not restore terminal flag {flag}")
        for index in (termios.VMIN, termios.VTIME):
            if restored[6][index] != self.initial_termios[6][index]:
                raise AssertionError(f"{self.implementation} did not restore terminal control character {index}")
        if self.process.returncode != 0:
            raise AssertionError(f"{self.implementation} exited {self.process.returncode}: {bytes(self.output[-800:])!r}")


def run_steps(session: PtySession, steps: list[dict[str, object]]) -> list[ScreenFacts]:
    frames: list[ScreenFacts] = []
    for step in steps:
        if "wait" in step:
            frames.append(session.wait_for(step["wait"], float(step.get("timeout", 8))))
        elif "send" in step:
            session.send(str(step["send"]))
        elif "type" in step:
            session.type_text(str(step["type"]))
        else:
            raise AssertionError(f"unknown scenario step: {step}")
    return frames


def probe(command: str, binary: Path, store: Path) -> dict[str, str]:
    env = {**os.environ, "UNBUN_CC_STORE": str(store)}
    if command == "js":
        argv = [shutil.which("bun") or "bun", "cli.mjs", "cc", "status", "--binary", str(binary), "--json"]
    else:
        argv = [shutil.which("uv") or "uv", "run", "--directory", "python/cc-patch", "ccpatch", "--binary", str(binary), "--json", "--check"]
    result = subprocess.run(
        argv,
        cwd=ROOT,
        env=env,
        check=True,
        capture_output=True,
        text=True,
        timeout=20,
    )
    payload = json.loads(result.stdout)
    if isinstance(payload, list):
        payload = payload[0]
    return {slug: status["state"] for slug, status in payload["features"].items()}


def seed_clean_baseline(binary: Path, store: Path) -> None:
    env = {**os.environ, "UNBUN_CC_STORE": str(store)}
    bun = shutil.which("bun") or "bun"
    subprocess.run(
        [bun, "cli.mjs", "cc", "patch", "--binary", str(binary), "--feature", "source-exec", "--yes"],
        cwd=ROOT,
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )
    subprocess.run(
        [bun, "cli.mjs", "cc", "revert", "--binary", str(binary), "--feature", "source-exec", "--yes"],
        cwd=ROOT,
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )


def store_facts(store: Path) -> tuple[tuple[str, int, str], ...]:
    if not store.exists():
        return ()
    return tuple(
        (str(path.relative_to(store)), path.stat().st_size, sha256(path))
        for path in sorted(store.rglob("*"))
        if path.is_file() and "write.lock" not in path.parts
    )