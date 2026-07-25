import subprocess
from pathlib import Path

import pytest

from cc_patch import codesign


def completed(args, returncode=0, stdout="", stderr=""):
    return subprocess.CompletedProcess(args, returncode, stdout, stderr)


def test_macos_calls_injected_runner_in_order(monkeypatch, fake_codesign):
    binary = Path("/tmp/claude")
    logs = []
    monkeypatch.setattr(codesign.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(codesign.shutil, "which", lambda _name: "/usr/bin/codesign")

    codesign.maybe_resign_macos(binary, logs.append, runner=fake_codesign.runner)

    assert fake_codesign.calls == [
        ["/usr/bin/codesign", "--remove-signature", str(binary)],
        ["/usr/bin/codesign", "-s", "-", str(binary)],
    ]
    assert logs == ["  OK macOS ad-hoc codesign"]


def test_non_macos_does_not_call_runner(monkeypatch):
    calls = []
    monkeypatch.setattr(codesign.platform, "system", lambda: "Linux")
    codesign.maybe_resign_macos(Path("/tmp/claude"), lambda _message: None, runner=lambda args: calls.append(args))
    assert calls == []


def test_missing_codesign_raises_with_manual_commands(monkeypatch):
    binary = Path("/tmp/claude")
    monkeypatch.setattr(codesign.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(codesign.shutil, "which", lambda _name: None)

    with pytest.raises(codesign.CodesignError) as error:
        codesign.maybe_resign_macos(binary, lambda _message: None)

    assert (error.value.code, error.value.exit_code) == ("codesign_failed", 3)
    assert "codesign --remove-signature /tmp/claude" in str(error.value)
    assert "codesign -s - /tmp/claude" in str(error.value)


def test_remove_signature_failure_is_propagated(monkeypatch):
    monkeypatch.setattr(codesign.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(codesign.shutil, "which", lambda _name: "/usr/bin/codesign")

    with pytest.raises(codesign.CodesignError, match="removing the old signature failed") as error:
        codesign.maybe_resign_macos(
            Path("/tmp/claude"),
            lambda _message: None,
            runner=lambda args: completed(args, returncode=1, stderr="failed"),
        )
    assert (error.value.code, error.value.exit_code) == ("codesign_failed", 3)


def test_sign_failure_has_stable_code_and_exit(monkeypatch):
    monkeypatch.setattr(codesign.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(codesign.shutil, "which", lambda _name: "/usr/bin/codesign")
    calls = 0

    def runner(args):
        nonlocal calls
        calls += 1
        return completed(args, returncode=1 if calls == 2 else 0, stderr="sign failed")

    with pytest.raises(codesign.CodesignError, match="ad-hoc re-signing failed") as error:
        codesign.maybe_resign_macos(Path("/tmp/claude"), lambda _message: None, runner=runner)

    assert (error.value.code, error.value.exit_code) == ("codesign_failed", 3)
