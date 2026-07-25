from pathlib import Path
import threading

from textual.widgets import Input, OptionList

from cc_patch import orchestrate
from cc_patch.models import WriteOutcome
from cc_patch.store import StoreError
from cc_patch.tui import app as tui_app


def _fake_quick_status(_view):
    return {
        "source-exec": "clean",
        "agent-model": "clean",
        "channels": "clean",
    }


async def test_group_headers_are_disabled_and_feature_options_are_indented(
    monkeypatch, tmp_path
):
    binaries = [tmp_path / "claude-a", tmp_path / "claude-b"]
    for binary in binaries:
        binary.write_bytes(b'fixture overview",VERSION:"2.1.175" tail')

    monkeypatch.setattr(tui_app.binaries, "detect_binaries", lambda: binaries)
    monkeypatch.setattr(tui_app.probe, "quick_status", _fake_quick_status)

    app = tui_app.CcPatchApp()
    async with app.run_test() as pilot:
        await pilot.pause()
        feature_list = app.query_one(OptionList)
        assert feature_list.option_count == 8
        assert feature_list.get_option_at_index(0).disabled is True
        assert feature_list.get_option_at_index(4).disabled is True
        prompts = [str(feature_list.get_option_at_index(index).prompt) for index in range(8)]
        assert "claude-a" in prompts[0]
        assert "claude-b" in prompts[4]
        assert [prompt.strip().split()[2] for prompt in prompts[1:4]] == [
            "source-exec",
            "agent-model",
            "channels",
        ]
        assert all(prompt.startswith("    ") for prompt in prompts[1:4])


async def test_space_toggle_and_cancel(monkeypatch, tmp_path):
    binary = tmp_path / "claude"
    binary.write_bytes(b'fixture overview",VERSION:"2.1.175" tail')
    monkeypatch.setattr(tui_app.probe, "quick_status", _fake_quick_status)

    app = tui_app.CcPatchApp([binary])
    async with app.run_test() as pilot:
        await pilot.pause()
        await pilot.press("space")
        assert app.selected == {0}
        feature_list = app.query_one(OptionList)
        assert str(feature_list.get_option_at_index(1).prompt).strip().startswith("[x]")
        await pilot.press("q")
        await pilot.pause()
    assert app.result is None


async def test_slash_focuses_and_clears_filter_then_visible_all_is_scoped(
    monkeypatch, tmp_path
):
    binary = tmp_path / "claude"
    binary.write_bytes(b'fixture overview",VERSION:"2.1.175" tail')
    monkeypatch.setattr(tui_app.probe, "quick_status", _fake_quick_status)

    app = tui_app.CcPatchApp([binary])
    async with app.run_test() as pilot:
        await pilot.pause()
        filter_input = app.query_one(Input)
        filter_input.value = "old"
        app.query_one(OptionList).focus()
        await pilot.press("/")
        assert filter_input.has_focus
        assert filter_input.value == ""
        await pilot.press(*"claude channels")
        await pilot.press("enter")
        assert app.query_one(OptionList).has_focus
        assert [row.feature for row in app._visible] == ["channels"]
        await pilot.press("space")
        assert app.selected == {2}
        await pilot.press("space")
        assert app.selected == set()
        await pilot.press("a")
        assert app.selected == {2}


async def test_clearing_all_selected_features_runs_full_revert(monkeypatch, tmp_path):
    binary = tmp_path / "claude"
    binary.write_bytes(b'fixture overview",VERSION:"2.1.175" tail')
    monkeypatch.setattr(
        tui_app.probe,
        "quick_status",
        lambda _view: {slug: "patched" for slug in tui_app.REGISTRY},
    )
    calls = []

    def fake_write(binary, target_features, *, current_data, log):
        calls.append((binary, target_features))
        return WriteOutcome(binary, target_features, 1, False)

    monkeypatch.setattr(tui_app.orchestrate, "write_features", fake_write)

    app = tui_app.CcPatchApp([binary])
    async with app.run_test() as pilot:
        await pilot.pause()
        assert app.selected == {0, 1, 2}
        await pilot.press("a")
        assert app.selected == set()
        await pilot.press("enter")
        await app.workers.wait_for_complete()
        await pilot.pause()

    assert app.result == {str(binary): []}
    assert calls == [(binary, [])]


async def test_only_changed_binary_is_reverted_in_multi_binary_view(monkeypatch, tmp_path):
    binaries = [tmp_path / "claude-a", tmp_path / "claude-b"]
    for binary in binaries:
        binary.write_bytes(b'fixture overview",VERSION:"2.1.175" tail')
    monkeypatch.setattr(
        tui_app.probe,
        "quick_status",
        lambda _view: {slug: "patched" for slug in tui_app.REGISTRY},
    )
    calls = []

    def fake_write(binary, target_features, *, current_data, log):
        calls.append((binary, target_features))
        return WriteOutcome(binary, target_features, 1, False)

    monkeypatch.setattr(tui_app.orchestrate, "write_features", fake_write)

    app = tui_app.CcPatchApp(binaries)
    async with app.run_test() as pilot:
        await pilot.pause()
        for index in range(3):
            await pilot.press("space")
            if index < 2:
                await pilot.press("down")
        await pilot.press("enter")
        await app.workers.wait_for_complete()
        await pilot.pause()

    assert app.result == {str(binaries[0]): []}
    assert calls == [(binaries[0], [])]


async def test_dependency_closure_equal_to_current_is_not_selected_target(monkeypatch, tmp_path):
    binary = tmp_path / "claude"
    binary.write_bytes(b'fixture overview",VERSION:"2.1.175" tail')
    monkeypatch.setattr(
        tui_app.probe,
        "quick_status",
        lambda _view: {
            "source-exec": "patched",
            "agent-model": "clean",
            "channels": "patched",
        },
    )

    app = tui_app.CcPatchApp([binary])
    async with app.run_test() as pilot:
        await pilot.pause()
        assert app.selected == {0, 2}
        await pilot.press("space")
        assert app.selected == {2}
        assert app._selected_targets() == {}
        summary = str(app.query_one("#summary").content)
        assert "0 pending" in summary
        group_prompt = str(app.query_one(OptionList).get_option_at_index(0).prompt)
        assert "->" not in group_prompt
        assert "replay mixed" not in group_prompt


async def test_dependency_targets_keep_agent_independent_and_expand_channels(
    monkeypatch, tmp_path
):
    binary = tmp_path / "claude"
    binary.write_bytes(b'fixture overview",VERSION:"2.1.175" tail')
    monkeypatch.setattr(tui_app.probe, "quick_status", _fake_quick_status)

    app = tui_app.CcPatchApp([binary])
    async with app.run_test() as pilot:
        await pilot.pause()
        await pilot.press("down")
        await pilot.press("space")
        assert app._selected_targets() == {str(binary): ["agent-model"]}
        assert app._pending_action(binary, app._selected_targets()) == (
            "patch[agent-model]"
        )

        await pilot.press("space")
        await pilot.press("down")
        await pilot.press("space")
        assert app._selected_targets() == {str(binary): ["channels"]}
        assert app._pending_action(binary, app._selected_targets()) == (
            "patch[source-exec,channels]"
        )


async def test_selected_mixed_feature_is_always_replayed_to_patched(monkeypatch, tmp_path):
    binary = tmp_path / "claude"
    binary.write_bytes(b'fixture overview",VERSION:"2.1.175" tail')
    monkeypatch.setattr(
        tui_app.probe,
        "quick_status",
        lambda _view: {
            "source-exec": "mixed",
            "agent-model": "clean",
            "channels": "clean",
        },
    )
    calls = []

    def fake_write(binary, target_features, *, current_data, log):
        calls.append((binary, target_features))
        return WriteOutcome(binary, target_features, 1, False)

    monkeypatch.setattr(tui_app.orchestrate, "write_features", fake_write)

    app = tui_app.CcPatchApp([binary])
    async with app.run_test() as pilot:
        await pilot.pause()
        assert app.selected == {0}
        await pilot.press("enter")
        await app.workers.wait_for_complete()
        await pilot.pause()

    assert app.result == {str(binary): ["source-exec"]}
    assert calls == [(binary, ["source-exec"])]


async def test_unselected_mixed_feature_previews_revert(monkeypatch, tmp_path):
    binary = tmp_path / "claude"
    binary.write_bytes(b'fixture overview",VERSION:"2.1.175" tail')
    monkeypatch.setattr(
        tui_app.probe,
        "quick_status",
        lambda _view: {
            "source-exec": "clean",
            "agent-model": "mixed",
            "channels": "clean",
        },
    )

    app = tui_app.CcPatchApp([binary])
    async with app.run_test() as pilot:
        await pilot.pause()
        await pilot.press("down")
        await pilot.press("space")
        assert app.selected == set()
        assert app._selected_targets() == {str(binary): []}
        group_prompt = str(
            app.query_one(OptionList).get_option_at_index(0).prompt
        )
        assert "revert[agent-model](mixed)" in group_prompt


async def test_filter_preserves_hidden_selection(monkeypatch, tmp_path):
    binary = tmp_path / "claude-alpha"
    binary.write_bytes(b'fixture overview",VERSION:"2.1.175" tail')
    monkeypatch.setattr(tui_app.probe, "quick_status", _fake_quick_status)

    app = tui_app.CcPatchApp([binary])
    async with app.run_test() as pilot:
        await pilot.pause()
        await pilot.press("down")
        await pilot.press("space")
        assert app.selected == {1}

        input_widget = app.query_one(Input)
        input_widget.focus()
        input_widget.value = "channels"
        await pilot.pause()
        feature_list = app.query_one(OptionList)
        assert feature_list.option_count == 2
        assert "channels" in str(feature_list.get_option_at_index(1).prompt)

        input_widget.value = ""
        await pilot.pause()
        assert feature_list.option_count == 4
        assert str(feature_list.get_option_at_index(2).prompt).strip().startswith("[x]")


async def test_toggle_all_only_changes_visible_filtered_rows(monkeypatch, tmp_path):
    binary = tmp_path / "claude-alpha"
    binary.write_bytes(b'fixture overview",VERSION:"2.1.175" tail')
    monkeypatch.setattr(tui_app.probe, "quick_status", _fake_quick_status)

    app = tui_app.CcPatchApp([binary])
    async with app.run_test() as pilot:
        await pilot.pause()
        input_widget = app.query_one(Input)
        input_widget.focus()
        input_widget.value = "channels"
        await pilot.pause()

        app.query_one(OptionList).focus()
        await pilot.press("a")
        assert app.selected == {2}

        input_widget.value = ""
        await pilot.pause()
        feature_list = app.query_one(OptionList)
        assert str(feature_list.get_option_at_index(1).prompt).strip().startswith("[ ]")
        assert str(feature_list.get_option_at_index(2).prompt).strip().startswith("[ ]")
        assert str(feature_list.get_option_at_index(3).prompt).strip().startswith("[x]")


async def test_unsupported_feature_is_disabled_and_excluded_from_toggle_all(
    monkeypatch, tmp_path
):
    binary = tmp_path / "claude"
    binary.write_bytes(b'fixture overview",VERSION:"2.1.175" tail')
    monkeypatch.setattr(
        tui_app.probe,
        "quick_status",
        lambda _view: {
            "source-exec": "clean",
            "agent-model": "clean",
            "channels": "unsupported",
        },
    )

    app = tui_app.CcPatchApp([binary])
    async with app.run_test() as pilot:
        await pilot.pause()
        feature_list = app.query_one(OptionList)
        assert feature_list.get_option_at_index(3).disabled is True
        assert "UNSUPPORTED" in str(feature_list.get_option_at_index(3).prompt)

        await pilot.press("a")
        assert app.selected == {0, 1}
        assert app._selected_targets() == {str(binary): ["source-exec", "agent-model"]}


async def test_enter_in_filter_moves_focus_without_applying(monkeypatch, tmp_path):
    binary = tmp_path / "claude"
    binary.write_bytes(b'fixture overview",VERSION:"2.1.175" tail')
    monkeypatch.setattr(tui_app.probe, "quick_status", _fake_quick_status)
    calls = []

    def fake_write(binary, target_features, *, current_data, log):
        calls.append((binary, target_features))
        return WriteOutcome(binary, target_features, 1, False)

    monkeypatch.setattr(tui_app.orchestrate, "write_features", fake_write)

    app = tui_app.CcPatchApp([binary])
    async with app.run_test() as pilot:
        await pilot.pause()
        await pilot.press("space")
        input_widget = app.query_one(Input)
        input_widget.focus()
        input_widget.value = "source"

        await pilot.press("enter")
        await pilot.pause()
        assert app.result is None
        assert calls == []
        assert app.query_one(OptionList).has_focus

        await pilot.press("enter")
        await app.workers.wait_for_complete()
        await pilot.pause()

    assert calls == [(binary, ["source-exec"])]


async def test_filter_with_no_matches_shows_actionable_feedback(monkeypatch, tmp_path):
    binary = tmp_path / "claude"
    binary.write_bytes(b'fixture overview",VERSION:"2.1.175" tail')
    monkeypatch.setattr(tui_app.probe, "quick_status", _fake_quick_status)

    app = tui_app.CcPatchApp([binary])
    async with app.run_test() as pilot:
        await pilot.pause()
        input_widget = app.query_one(Input)
        input_widget.focus()
        input_widget.value = "not-a-feature"
        await pilot.pause()

        assert app.query_one(OptionList).option_count == 0
        assert "No matches" in str(app.query_one("#warning").content)
        await pilot.press("enter")
        assert input_widget.has_focus


async def test_filter_with_only_unsupported_matches_shows_feedback(monkeypatch, tmp_path):
    binary = tmp_path / "claude"
    binary.write_bytes(b'fixture overview",VERSION:"2.1.175" tail')
    monkeypatch.setattr(
        tui_app.probe,
        "quick_status",
        lambda _view: {
            "source-exec": "clean",
            "agent-model": "clean",
            "channels": "unsupported",
        },
    )

    app = tui_app.CcPatchApp([binary])
    async with app.run_test() as pilot:
        await pilot.pause()
        input_widget = app.query_one(Input)
        input_widget.focus()
        input_widget.value = "channels"
        await pilot.pause()

        assert "No actionable features" in str(app.query_one("#warning").content)
        await pilot.press("enter")
        assert input_widget.has_focus


async def test_escape_cancels(monkeypatch, tmp_path):
    binary = tmp_path / "claude"
    binary.write_bytes(b'fixture overview",VERSION:"2.1.175" tail')
    monkeypatch.setattr(tui_app.probe, "quick_status", _fake_quick_status)

    app = tui_app.CcPatchApp([binary])
    async with app.run_test() as pilot:
        await pilot.pause()
        await pilot.press("escape")
        await pilot.pause()
    assert app.result is None


async def test_enter_directly_runs_selected_target_in_worker(monkeypatch, tmp_path):
    binaries = [tmp_path / "claude-a", tmp_path / "claude-b"]
    for binary in binaries:
        binary.write_bytes(b'fixture overview",VERSION:"2.1.175" tail')
    monkeypatch.setattr(tui_app.probe, "quick_status", _fake_quick_status)

    main_thread = threading.get_ident()
    calls = []

    def fake_write(binary, target_features, *, current_data, log):
        calls.append((binary, target_features, threading.get_ident(), current_data))
        return WriteOutcome(binary, target_features, 1, False)

    monkeypatch.setattr(tui_app.orchestrate, "write_features", fake_write)

    app = tui_app.CcPatchApp(binaries)
    async with app.run_test() as pilot:
        await pilot.pause()
        await pilot.press("space")
        await pilot.press("down")
        await pilot.press("down")
        await pilot.press("down")
        await pilot.press("space")
        await pilot.press("enter")
        await app.workers.wait_for_complete()
        await pilot.pause()
        assert "Done: 2 / 2 succeeded" in str(app.query_one("#progress").content)

    assert app.result == {
        str(binaries[0]): ["source-exec"],
        str(binaries[1]): ["source-exec"],
    }
    assert [call[:2] for call in calls] == [
        (binaries[0], ["source-exec"]),
        (binaries[1], ["source-exec"]),
    ]
    assert all(call[2] != main_thread for call in calls)
    assert len(app.outcomes) == 2
    assert app.exit_code == 0


async def test_enter_is_ignored_while_initial_probe_is_loading(monkeypatch, tmp_path):
    binary = tmp_path / "claude"
    binary.write_bytes(b'fixture overview",VERSION:"2.1.175" tail')
    started = threading.Event()
    release = threading.Event()

    def slow_status(_view):
        started.set()
        release.wait(timeout=5)
        return _fake_quick_status(_view)

    monkeypatch.setattr(tui_app.probe, "quick_status", slow_status)

    app = tui_app.CcPatchApp([binary])
    async with app.run_test() as pilot:
        assert started.wait(timeout=5)
        input_widget = app.query_one(Input)
        input_widget.focus()
        input_widget.value = "not-a-feature"
        await pilot.pause()
        assert str(app.query_one("#warning").content) == ""
        input_widget.value = ""
        await pilot.press("enter")
        await pilot.pause()
        assert app.result is None
        assert app._loading is True
        assert app.is_running
        release.set()
        await app.workers.wait_for_complete()
        await pilot.pause()
        assert app._loading is False
        assert app.query_one(OptionList).option_count == 4


async def test_worker_guard_error_is_visible_and_nonfatal(monkeypatch, tmp_path):
    binary = tmp_path / "claude"
    binary.write_bytes(b'fixture overview",VERSION:"2.1.175" tail')
    monkeypatch.setattr(tui_app.probe, "quick_status", _fake_quick_status)

    def reject(*_args, **_kwargs):
        raise orchestrate.NoBaselineRejected(
            orchestrate.NoBaselineReason.CHANNELS_PATCHED_NO_BASELINE
        )

    monkeypatch.setattr(tui_app.orchestrate, "write_features", reject)

    app = tui_app.CcPatchApp([binary])
    async with app.run_test() as pilot:
        await pilot.pause()
        await pilot.press("space")
        await pilot.press("enter")
        await app.workers.wait_for_complete()
        await pilot.pause()
        progress = str(app.query_one("#progress").content)
        assert "error" in progress
        assert "channels is patched but has no clean baseline" in progress

    assert app._exception is None
    assert app.exit_code == 1
    assert app.outcomes == []
    assert len(app.errors) == 1


async def _run_guard_case(monkeypatch, tmp_path, error):
    binary = tmp_path / "claude"
    binary.write_bytes(b'fixture overview",VERSION:"2.1.175" tail')
    monkeypatch.setattr(tui_app.probe, "quick_status", _fake_quick_status)

    def reject(*_args, **_kwargs):
        raise error

    monkeypatch.setattr(tui_app.orchestrate, "write_features", reject)
    app = tui_app.CcPatchApp([binary])
    async with app.run_test() as pilot:
        await pilot.pause()
        await pilot.press("space")
        await pilot.press("enter")
        await app.workers.wait_for_complete()
        await pilot.pause()
        progress = str(app.query_one("#progress").content)
    return app, progress


async def test_version_drift_guard_message_and_exit_code(monkeypatch, tmp_path):
    app, progress = await _run_guard_case(
        monkeypatch,
        tmp_path,
        orchestrate.VersionDriftRejected("2.1.174", "2.1.175"),
    )
    assert "Baseline version differs from current binary" in progress
    assert app.exit_code == 1


async def test_concurrent_change_guard_message_and_exit_code(monkeypatch, tmp_path):
    app, progress = await _run_guard_case(
        monkeypatch,
        tmp_path,
        orchestrate.ConcurrentBinaryChange("changed"),
    )
    assert "Binary was modified concurrently during the operation" in progress
    assert app.exit_code == 1


async def test_dependent_feature_guard_message_and_exit_code(monkeypatch, tmp_path):
    app, progress = await _run_guard_case(
        monkeypatch,
        tmp_path,
        orchestrate.DependentFeatureStillEnabled("source-exec", ["channels"]),
    )
    assert "Remove features depending on source-exec first: channels" in progress
    assert app.exit_code == 1


async def test_content_mismatch_guard_message_and_exit_code(monkeypatch, tmp_path):
    app, progress = await _run_guard_case(
        monkeypatch,
        tmp_path,
        orchestrate.ContentMismatch("bad readback"),
    )
    assert "Content consistency check failed: bad readback" in progress
    assert app.exit_code == 2


async def test_shared_store_error_message_and_exit_code(monkeypatch, tmp_path):
    app, progress = await _run_guard_case(
        monkeypatch,
        tmp_path,
        StoreError("target_locked", 1, "Target is locked by another writer"),
    )
    assert "Target is locked by another writer" in progress
    assert "Feature action" not in progress
    assert app.exit_code == 1


async def test_unknown_error_uses_severity_three(monkeypatch, tmp_path):
    app, progress = await _run_guard_case(
        monkeypatch,
        tmp_path,
        RuntimeError("boom"),
    )
    assert "RuntimeError: boom" in progress
    assert app.exit_code == 3


async def test_double_enter_does_not_start_parallel_writes(monkeypatch, tmp_path):
    binary = tmp_path / "claude"
    binary.write_bytes(b'fixture overview",VERSION:"2.1.175" tail')
    monkeypatch.setattr(tui_app.probe, "quick_status", _fake_quick_status)
    started = threading.Event()
    release = threading.Event()
    calls = []

    def slow_write(binary, target_features, *, current_data, log):
        calls.append((binary, target_features))
        started.set()
        release.wait(timeout=5)
        return WriteOutcome(binary, target_features, 1, False)

    monkeypatch.setattr(tui_app.orchestrate, "write_features", slow_write)

    app = tui_app.CcPatchApp([binary])
    async with app.run_test() as pilot:
        await pilot.pause()
        await pilot.press("space")
        await pilot.press("enter")
        assert started.wait(timeout=5)
        await pilot.press("enter")
        await pilot.pause()
        release.set()
        await app.workers.wait_for_complete()
        await pilot.pause()

    assert calls == [(binary, ["source-exec"])]


async def test_runtime_degraded_channels_dependency_is_warned(monkeypatch, tmp_path):
    binary = tmp_path / "claude"
    binary.write_bytes(b'fixture overview",VERSION:"2.1.175" tail')
    monkeypatch.setattr(
        tui_app.probe,
        "quick_status",
        lambda _view: {
            "source-exec": "clean",
            "agent-model": "clean",
            "channels": "patched",
        },
    )

    app = tui_app.CcPatchApp([binary])
    async with app.run_test() as pilot:
        await pilot.pause()
        feature_list = app.query_one(OptionList)
        assert "[!] dependency source-exec not in effect" in str(
            feature_list.get_option_at_index(3).prompt
        )
        assert "apply source-exec or revert all" in str(
            app.query_one("#warning").content
        )


def test_run_tui_non_tty_returns_none(monkeypatch, tmp_path):
    binary = tmp_path / "claude"
    monkeypatch.setattr(tui_app.sys.stdin, "isatty", lambda: True)
    monkeypatch.setattr(tui_app.sys.stdout, "isatty", lambda: False)

    assert tui_app.run_tui([binary]) is None


async def test_apply_stays_in_tui_and_refreshes_state(monkeypatch, tmp_path):
    binary = tmp_path / "claude"
    binary.write_bytes(b'fixture overview",VERSION:"2.1.175" tail')
    monkeypatch.setattr(tui_app.probe, "quick_status", _fake_quick_status)

    def fake_write(binary, target_features, *, current_data, log):
        return WriteOutcome(binary, target_features, 1, False)

    monkeypatch.setattr(tui_app.orchestrate, "write_features", fake_write)

    app = tui_app.CcPatchApp([binary])
    async with app.run_test() as pilot:
        await pilot.pause()
        await pilot.press("space")
        await pilot.press("enter")
        await app.workers.wait_for_complete()
        await pilot.pause()
        # 执行完成后不自动退出，仍留在 TUI。
        assert app.is_running
        progress = str(app.query_one("#progress").content)
        assert "Done" in progress
        assert "state refreshed" in progress
        # 重探刷新：quick_status 仍为全 clean，选中集应重置为空（无 patched/mixed）。
        assert app.selected == set()


async def test_shared_transaction_updates_badge_and_can_execute_again(
    tmp_path, make_bundle
):
    binary = tmp_path / "claude"
    clean = bytes(make_bundle())
    binary.write_bytes(clean)

    app = tui_app.CcPatchApp([binary])
    async with app.run_test() as pilot:
        await pilot.pause()
        assert app.rows[0].state == "clean"
        assert app.rows[0].has_baseline is False

        await pilot.press("space")
        await pilot.press("enter")
        await app.workers.wait_for_complete()
        await pilot.pause()

        assert app.is_running
        assert app.rows[0].state == "patched"
        assert app.rows[0].has_baseline is True
        assert app.selected == {0}
        assert "PATCHED" in str(
            app.query_one(OptionList).get_option_at_index(1).prompt
        )

        await pilot.press("space")
        await pilot.press("enter")
        await app.workers.wait_for_complete()
        await pilot.pause()

        assert app.is_running
        assert binary.read_bytes() == clean
        assert app.rows[0].state == "clean"
        assert app.selected == set()
        assert "CLEAN" in str(
            app.query_one(OptionList).get_option_at_index(1).prompt
        )
        assert "Done: 1 / 1 succeeded" in str(
            app.query_one("#progress").content
        )


async def test_shared_transaction_replays_mixed_target(tmp_path, make_bundle):
    binary = tmp_path / "claude"
    clean_tag = b"// @bun @bytecode @bun-cjs\n"
    patched_tag = b"// @bun @source__ @bun-cjs\n"
    clean = bytes(make_bundle()).replace(clean_tag, clean_tag + clean_tag, 1)
    binary.write_bytes(clean)

    orchestrate.write_features(binary, ["source-exec"], current_data=clean)
    mixed = binary.read_bytes().replace(patched_tag, clean_tag, 1)
    binary.write_bytes(mixed)

    app = tui_app.CcPatchApp([binary])
    async with app.run_test() as pilot:
        await pilot.pause()
        assert app.rows[0].state == "mixed"
        assert app.selected == {0}
        assert "replay mixed" in str(
            app.query_one(OptionList).get_option_at_index(0).prompt
        )

        await pilot.press("enter")
        await app.workers.wait_for_complete()
        await pilot.pause()

        assert app.is_running
        assert app.rows[0].state == "patched"
        assert app.selected == {0}
        assert binary.read_bytes().count(patched_tag) == 2
        assert binary.read_bytes().count(clean_tag) == 0


async def test_can_execute_again_after_completion(monkeypatch, tmp_path):
    binary = tmp_path / "claude"
    binary.write_bytes(b'fixture overview",VERSION:"2.1.175" tail')
    monkeypatch.setattr(tui_app.probe, "quick_status", _fake_quick_status)
    calls = []

    def fake_write(binary, target_features, *, current_data, log):
        calls.append((binary, target_features))
        return WriteOutcome(binary, target_features, 1, False)

    monkeypatch.setattr(tui_app.orchestrate, "write_features", fake_write)

    app = tui_app.CcPatchApp([binary])
    async with app.run_test() as pilot:
        await pilot.pause()
        await pilot.press("space")
        await pilot.press("enter")
        await app.workers.wait_for_complete()
        await pilot.pause()
        assert len(calls) == 1
        assert app.is_running
        # 第二批：完成后选中集已重置，可再次勾选并执行。
        await pilot.press("space")
        await pilot.press("enter")
        await app.workers.wait_for_complete()
        await pilot.pause()
        assert len(calls) == 2
        assert app.is_running


async def test_enter_with_no_pending_change_is_noop_and_stays(monkeypatch, tmp_path):
    binary = tmp_path / "claude"
    binary.write_bytes(b'fixture overview",VERSION:"2.1.175" tail')
    monkeypatch.setattr(tui_app.probe, "quick_status", _fake_quick_status)
    calls = []

    def fake_write(*args, **kwargs):
        calls.append(args)
        return WriteOutcome(Path("x"), [], 0, False)

    monkeypatch.setattr(tui_app.orchestrate, "write_features", fake_write)

    app = tui_app.CcPatchApp([binary])
    async with app.run_test() as pilot:
        await pilot.pause()
        # 全 clean、无勾选 → 无待执行变更；enter 应为 no-op，不退出、不写盘。
        await pilot.press("enter")
        await pilot.pause()
        assert app.is_running
        assert calls == []
        assert app.result == {}
        assert "Nothing to apply" in str(app.query_one("#progress").content)


async def test_progress_shows_executing_feedback_while_running(monkeypatch, tmp_path):
    binary = tmp_path / "claude"
    binary.write_bytes(b'fixture overview",VERSION:"2.1.175" tail')
    monkeypatch.setattr(tui_app.probe, "quick_status", _fake_quick_status)
    started = threading.Event()
    release = threading.Event()

    def slow_write(binary, target_features, *, current_data, log):
        started.set()
        release.wait(timeout=5)
        return WriteOutcome(binary, target_features, 1, False)

    monkeypatch.setattr(tui_app.orchestrate, "write_features", slow_write)

    app = tui_app.CcPatchApp([binary])
    async with app.run_test() as pilot:
        await pilot.pause()
        await pilot.press("space")
        await pilot.press("enter")
        assert started.wait(timeout=5)
        await pilot.pause()
        assert "Running" in str(app.query_one("#progress").content)
        release.set()
        await app.workers.wait_for_complete()
        await pilot.pause()
