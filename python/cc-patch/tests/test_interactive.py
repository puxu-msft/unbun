from argparse import Namespace
from pathlib import Path

import pytest

from cc_patch import interactive
from cc_patch.models import BinaryProbe, FeatureStatus


@pytest.mark.parametrize(
    ("raw", "count", "expected"),
    [
        ("", 3, [0, 1, 2]),
        ("a", 2, [0, 1]),
        ("all", 2, [0, 1]),
        ("ALL", 2, [0, 1]),
        ("q", 3, []),
        ("quit", 3, []),
        ("none", 3, []),
        ("2", 3, [1]),
        ("1, 3", 3, [0, 2]),
        ("1-3", 4, [0, 1, 2]),
        ("3-1", 4, [0, 1, 2]),
        ("1-2 2 3", 3, [0, 1, 2]),
    ],
)
def test_parse_selection_valid(raw, count, expected):
    assert interactive.parse_selection(raw, count) == expected


@pytest.mark.parametrize("raw", ["4", "0", "1-5", "x", "1,foo"])
def test_parse_selection_invalid(raw):
    assert interactive.parse_selection(raw, 3) is None


def bins(count):
    return [Path(f"/fake/claude{i}") for i in range(count)]


def stub_prober(path):
    return BinaryProbe(
        path,
        "2.1.175",
        {"source-exec": FeatureStatus("source-exec", "clean", [], 1)},
        200.0,
        False,
    )


def test_prompt_returns_chosen_subset():
    paths = bins(3)
    chosen = interactive.prompt_binary_selection(
        paths, "patch", reader=lambda _prompt: "1,3", out=lambda _message: None, prober=stub_prober
    )
    assert chosen == [paths[0], paths[2]]


def test_prompt_reprompts_on_invalid_then_accepts():
    paths = bins(2)
    answers = iter(["bogus", "2"])
    chosen = interactive.prompt_binary_selection(
        paths,
        "patch",
        reader=lambda _prompt: next(answers),
        out=lambda _message: None,
        prober=stub_prober,
    )
    assert chosen == [paths[1]]


def test_prompt_eof_returns_empty():
    def boom(_prompt):
        raise EOFError

    assert interactive.prompt_binary_selection(
        bins(2), "patch", reader=boom, out=lambda _message: None, prober=stub_prober
    ) == []


def test_prompt_probes_every_binary():
    paths = bins(3)
    seen = []

    def prober(path):
        seen.append(path)
        return stub_prober(path)

    interactive.prompt_binary_selection(
        paths, "check", reader=lambda _prompt: "q", out=lambda _message: None, prober=prober
    )
    assert seen == paths


def args(**overrides):
    values = {
        "binary": None,
        "check": False,
        "all": False,
        "command": "patch",
        "profile": False,
    }
    values.update(overrides)
    return Namespace(**values)


def test_select_explicit_binary_skips_detection(monkeypatch):
    monkeypatch.setattr(interactive, "detect_binaries", lambda: pytest.fail("should not detect"))
    assert interactive.select_binaries(args(binary="/x/claude"), interactive=True) == [Path("/x/claude")]


def test_select_all_flag_skips_prompt(monkeypatch):
    paths = bins(2)
    monkeypatch.setattr(interactive, "detect_binaries", lambda: paths)
    monkeypatch.setattr(interactive, "prompt_binary_selection", lambda *_args: pytest.fail("should not prompt"))
    assert interactive.select_binaries(args(all=True), interactive=True) == paths


def test_select_profile_flag_skips_prompt(monkeypatch):
    paths = bins(2)
    monkeypatch.setattr(interactive, "detect_binaries", lambda: paths)
    monkeypatch.setattr(interactive, "prompt_binary_selection", lambda *_args: pytest.fail("should not prompt"))
    assert interactive.select_binaries(args(profile=True), interactive=True) == paths


def test_select_single_binary_skips_prompt(monkeypatch):
    paths = bins(1)
    monkeypatch.setattr(interactive, "detect_binaries", lambda: paths)
    assert interactive.select_binaries(args(), interactive=True) == paths


def test_select_noninteractive_refuses_to_write_to_all_detected_binaries(monkeypatch):
    """L4-05：非 TTY + 多目标 + mutating 子命令，必须拒绝而不是静默全选。

    此前这里断言 `== paths`，把「defaulting to all」固化成了契约——那等于让一次
    `ccpatch patch` 在自动化环境里静默改写检测到的每一个 live 二进制。JS 侧结构上
    不存在这条路径（只解析单个 realpath），Python 侧必须显式拒绝。
    """
    paths = bins(2)
    monkeypatch.setattr(interactive, "detect_binaries", lambda: paths)
    assert interactive.select_binaries(args(command="patch"), interactive=False) == []


def test_select_noninteractive_still_reports_on_all_for_read_only(monkeypatch):
    """反向对照：只读路径不受影响，仍可一次报告全部目标。"""
    paths = bins(2)
    monkeypatch.setattr(interactive, "detect_binaries", lambda: paths)
    assert interactive.select_binaries(args(command=None), interactive=False) == paths
    assert interactive.select_binaries(args(check=True), interactive=False) == paths


def test_select_noninteractive_allows_explicit_all_for_writes(monkeypatch):
    """显式 --all 是用户明确表达的批量意图，应放行。"""
    paths = bins(2)
    monkeypatch.setattr(interactive, "detect_binaries", lambda: paths)
    assert interactive.select_binaries(args(command="patch", all=True), interactive=False) == paths


def test_select_no_binaries_returns_none(monkeypatch):
    monkeypatch.setattr(interactive, "detect_binaries", lambda: [])
    assert interactive.select_binaries(args(), interactive=True) is None


def test_select_interactive_prompt_used_for_multiple(monkeypatch):
    paths = bins(3)
    calls = []
    monkeypatch.setattr(interactive, "detect_binaries", lambda: paths)

    def prompt(found, action):
        calls.append((found, action))
        return [found[1]]

    monkeypatch.setattr(interactive, "prompt_binary_selection", prompt)
    assert interactive.select_binaries(args(), interactive=True) == [paths[1]]
    assert calls == [(paths, "patch")]
