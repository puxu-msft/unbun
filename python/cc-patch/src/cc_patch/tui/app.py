from __future__ import annotations

import mmap
import sys
from dataclasses import dataclass
from pathlib import Path

from rich.text import Text
from textual import work
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Vertical
from textual.widgets import Footer, Input, OptionList, Static
from textual.widgets.option_list import Option

from cc_patch import binaries, orchestrate, probe
from cc_patch.features import REGISTRY, resolve_closure
from cc_patch.models import WriteOutcome
from cc_patch.store import StoreError

_SEL_ON = "[x]"
_SEL_OFF = "[ ]"
# feature 名列宽 = 最长 feature 名，用于状态列对齐。
_FEATURE_COL_WIDTH = max(len(slug) for slug in REGISTRY)
# 状态 -> (徽章英文词, 语义色名)。徽章以「主题背景色 on 状态色」渲染成填充药丸；
# 英文词本身即无色终端下的双通道回退（不依赖颜色也能读懂）。
_STATUS_DISPLAY = {
    "clean": ("CLEAN", "success"),
    "patched": ("PATCHED", "warning"),
    "mixed": ("MIXED", "warning"),
    "unsupported": ("UNSUPPORTED", "error"),
}
_STATUS_ORDER = ("clean", "patched", "mixed", "unsupported")
_SUMMARY = "{n} pending | checked=target | enter run | space toggle | a visible | esc quit"


@dataclass(frozen=True)
class FeatureRow:
    index: int
    binary: Path
    version: str | None
    size_mb: float | None
    feature: str
    state: str
    has_baseline: bool


class CcPatchApp(App):
    """按二进制分组展示 feature 状态的 TUI。"""

    CSS = """
    #header { dock: top; height: 1; padding: 0 1; color: $text; }
    Input { dock: top; }
    OptionList { height: 1fr; border: none; padding: 0; }
    OptionList > .option-list--option { padding: 0; }
    #warning { height: auto; padding: 0 1; color: $warning; }
    #progress { height: auto; padding: 0 1; color: $text; }
    #summary { height: 1; padding: 0 1; color: $text; }
    #footer-panel { dock: bottom; height: auto; }
    Footer { display: none; }
    """

    BINDINGS = [
        Binding("/", "focus_filter", "filter", show=True),
        Binding("space", "toggle_row", "toggle", show=True),
        Binding("a", "toggle_all", "toggle visible", show=True),
        Binding("enter", "confirm", "run", show=True, priority=True),
        Binding("q", "cancel", "quit", show=False),
        Binding("escape", "cancel", "quit", show=True),
    ]

    def __init__(self, binary_paths: list[Path] | None = None):
        super().__init__()
        self.binary_paths = binary_paths
        self.rows: list[FeatureRow] = []
        self._visible: list[FeatureRow] = []
        self.selected: set[int] = set()
        self.result: dict[str, list[str]] | None = None
        self.outcomes: list[WriteOutcome] = []
        self.errors: list[str] = []
        self.exit_code = 0
        self._loading = True
        self._applying = False
        self._binary_labels: dict[Path, str] = {}

    def compose(self) -> ComposeResult:
        yield Input(
            placeholder="Filter by path or feature; Enter focuses results...",
            id="filter",
        )
        yield Static("", id="header")
        yield OptionList(id="features")
        # 三行反馈须纵向堆叠而非各自 dock:bottom（会重叠到同一行、令 #progress 不可见）。
        with Vertical(id="footer-panel"):
            yield Static("", id="warning", markup=False)
            yield Static("", id="progress", markup=False)
            yield Static(_SUMMARY.format(n=0), id="summary", markup=False)
        yield Footer()

    def on_mount(self) -> None:
        feature_list = self.query_one(OptionList)
        self.query_one("#header", Static).update(self._header_text("probing"))
        self.query_one("#progress", Static).update("Probing binaries (read-only)...")
        self._load_worker()
        feature_list.focus()

    @work(thread=True)
    def _load_worker(self) -> None:
        """在 worker 线程执行二进制检测与 mmap 探测，避免阻塞 Textual 事件循环。"""
        try:
            rows = self._load_rows()
        except Exception as error:  # noqa: BLE001 - 探测失败须回主线程现形，不能掀翻 App。
            self.call_from_thread(self._finish_load, [], error)
            return
        self.call_from_thread(self._finish_load, rows, None)

    def _finish_load(self, rows: list[FeatureRow], error: Exception | None) -> None:
        self._loading = False
        self.rows = rows
        self.selected = {
            row.index for row in self.rows if row.state in {"patched", "mixed"}
        }
        self._binary_labels = self._short_binary_labels()
        self._rebuild_rows()
        binary_count = len({row.binary for row in rows})
        plural = "binary" if binary_count == 1 else "binaries"
        self.query_one("#header", Static).update(
            self._header_text(f"{binary_count} {plural}")
        )
        if error is not None:
            self.query_one("#progress", Static).update(
                f"Probe failed: {type(error).__name__}: {error}"
            )
            self.exit_code = 1
        else:
            self.query_one("#progress", Static).update(
                f"Probed {binary_count} binaries, {len(rows)} rows."
            )

    def _load_rows(self) -> list[FeatureRow]:
        paths = self.binary_paths if self.binary_paths is not None else binaries.detect_binaries()
        store = orchestrate._get_store()
        rows: list[FeatureRow] = []
        index = 0
        for path in paths:
            try:
                size_mb = path.stat().st_size / (1024 * 1024)
                with path.open("rb") as handle:
                    view = mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ)
                    try:
                        version = probe.extract_version(view)
                        statuses = probe.quick_status(view)
                    finally:
                        view.close()
                identity = store.identity_for(path)
                has_baseline = version is not None and store.find_active_baseline(
                    identity.path_key, version
                ) is not None
            except (OSError, ValueError):
                size_mb = None
                version = None
                statuses = {slug: "unsupported" for slug in REGISTRY}
                has_baseline = False
            for slug in REGISTRY:
                rows.append(
                    FeatureRow(
                        index=index,
                        binary=path,
                        version=version,
                        size_mb=size_mb,
                        feature=slug,
                        state=statuses.get(slug, "unsupported"),
                        has_baseline=has_baseline,
                    )
                )
                index += 1
        return rows

    def _runtime_degraded(self, row: FeatureRow) -> bool:
        if row.state != "patched":
            return False
        states = {
            candidate.feature: candidate.state
            for candidate in self.rows
            if candidate.binary == row.binary
        }
        return any(states.get(required) != "patched" for required in REGISTRY[row.feature].requires)

    def _short_binary_labels(self) -> dict[Path, str]:
        paths = list(dict.fromkeys(row.binary for row in self.rows))
        if not paths:
            return {}
        depths = {path: min(2, len(path.parts)) for path in paths}
        while True:
            labels = {
                path: "/".join(path.parts[-depths[path] :])
                for path in paths
            }
            collisions: dict[str, list[Path]] = {}
            for path, label in labels.items():
                collisions.setdefault(label, []).append(path)
            duplicate_groups = [group for group in collisions.values() if len(group) > 1]
            if not duplicate_groups:
                break
            changed = False
            for group in duplicate_groups:
                for path in group:
                    if depths[path] < len(path.parts):
                        depths[path] += 1
                        changed = True
            if not changed:
                break
        return {
            path: (".../" if depths[path] < len(path.parts) else "") + labels[path]
            for path in paths
        }

    def _semantic_color(self, name: str) -> str:
        theme = self.current_theme
        if name == "text-muted":
            return theme.foreground
        return getattr(theme, name)

    def _status_badge(self, state: str) -> Text:
        """把状态渲染成填充药丸徽章：状态色背景 + 终端背景色文字。

        用 Rich 的 ``reverse`` 在渲染期交换前景/背景，故无需知道主题 background
        具体值，且随主题自适应。英文词是无色终端下的双通道回退（不依赖颜色也能读懂）。
        """
        word, color_name = _STATUS_DISPLAY.get(state, (state.upper(), "error"))
        color = self._semantic_color(color_name)
        return Text(f" {word} ", style=f"{color} reverse bold")

    def _legend_text(self) -> Text:
        legend = Text("legend ", style=self._semantic_color("text-muted"))
        for offset, state in enumerate(_STATUS_ORDER):
            if offset:
                legend.append(" ")
            legend.append_text(self._status_badge(state))
        legend.append("  ")
        legend.append("[!] degraded", style=self._semantic_color("warning"))
        return legend

    def _header_text(self, count_part: str) -> Text:
        header = Text("cc-patch | ", style=self._semantic_color("text-muted"))
        header.append(count_part, style="bold")
        header.append("   ")
        header.append_text(self._legend_text())
        return header

    def _pending_action(self, binary: Path, targets: dict[str, list[str]]) -> str | None:
        target = targets.get(str(binary))
        if target is None:
            return None
        binary_rows = [row for row in self.rows if row.binary == binary]
        current = [row.feature for row in binary_rows if row.state == "patched"]
        effective = resolve_closure(target)
        states = {row.feature: row.state for row in binary_rows}
        mixed_to_replay = [
            feature for feature in effective if states.get(feature) == "mixed"
        ]
        mixed_to_revert = [
            feature
            for feature in REGISTRY
            if states.get(feature) == "mixed" and feature not in effective
        ]
        added = [
            feature
            for feature in effective
            if feature not in current and feature not in mixed_to_replay
        ]
        removed = [feature for feature in current if feature not in effective]
        if not effective and current:
            return "revert all"
        actions = []
        if added:
            actions.append(f"patch[{','.join(added)}]")
        if removed:
            actions.append(f"revert[{','.join(removed)}]")
        if mixed_to_replay:
            actions.append("replay mixed")
        if mixed_to_revert:
            actions.append(f"revert[{','.join(mixed_to_revert)}](mixed)")
        return " + ".join(actions) if actions else None

    def _group_prompt(
        self,
        row: FeatureRow,
        targets: dict[str, list[str]] | None = None,
    ) -> Text:
        size = f"{row.size_mb:.1f}MB" if row.size_mb is not None else "?MB"
        baseline = "yes" if row.has_baseline else "no"
        muted = self._semantic_color("text-muted")
        prompt = Text("> ", style=muted)
        prompt.append(self._binary_labels.get(row.binary, str(row.binary)), style="bold")
        prompt.append(f" ({row.version or '?'}) | {size} | baseline:{baseline}", style=muted)
        action = self._pending_action(
            row.binary,
            targets if targets is not None else self._selected_targets(),
        )
        if action is not None:
            prompt.append(f"   -> {action}", style=self._semantic_color("warning"))
        return prompt

    def _feature_prompt(self, row: FeatureRow) -> Text:
        prompt = Text("    ")
        prompt.append(_SEL_ON if row.index in self.selected else _SEL_OFF)
        # feature 名按最长名左对齐补齐，令状态列纵向对齐（否则短名如 channels 会左移）。
        prompt.append(f" {row.feature:<{_FEATURE_COL_WIDTH}}   ")
        prompt.append_text(self._status_badge(row.state))
        if self._runtime_degraded(row):
            dependencies = ", ".join(REGISTRY[row.feature].requires)
            prompt.append(
                f"  [!] dependency {dependencies} not in effect",
                style=self._semantic_color("warning"),
            )
        return prompt

    @staticmethod
    def _matches(row: FeatureRow, needle: str) -> bool:
        tokens = needle.lower().split()
        if not tokens:
            return True
        fields = (str(row.binary).lower(), row.feature.lower())
        return all(any(token in field for field in fields) for token in tokens)

    def _rebuild_rows(self, needle: str = "") -> None:
        feature_list = self.query_one(OptionList)
        feature_list.clear_options()
        self._visible = [row for row in self.rows if self._matches(row, needle)]
        targets = self._selected_targets()
        previous_binary: Path | None = None
        first_feature_option: int | None = None
        for row in self._visible:
            if row.binary != previous_binary:
                feature_list.add_option(
                    Option(
                        self._group_prompt(row, targets),
                        id=f"binary:{row.binary}",
                        disabled=True,
                    )
                )
            disabled = row.state == "unsupported"
            feature_list.add_option(
                Option(self._feature_prompt(row), id=str(row.index), disabled=disabled)
            )
            if first_feature_option is None and not disabled:
                first_feature_option = feature_list.option_count - 1
            previous_binary = row.binary
        if first_feature_option is not None:
            feature_list.highlighted = first_feature_option
        degraded = [row for row in self.rows if self._runtime_degraded(row)]
        warning = self.query_one("#warning", Static)
        messages = []
        if not self._loading:
            if not self._visible:
                messages.append("No matches; change or clear the filter.")
            elif all(row.state == "unsupported" for row in self._visible):
                messages.append("No actionable features in the current filter.")
        if degraded:
            messages.append(
                "Warning: feature patched but dependency not in effect; apply source-exec or revert all."
            )
        warning.update(" | ".join(messages))
        self._update_intent_preview()

    def _refresh_selection(self) -> None:
        feature_list = self.query_one(OptionList)
        visible_by_id = {str(row.index): row for row in self._visible}
        visible_by_binary = {str(row.binary): row for row in self._visible}
        targets = self._selected_targets()
        for option_index, option in enumerate(feature_list.options):
            if option.id is None:
                continue
            if option.id.startswith("binary:"):
                binary_text = option.id.removeprefix("binary:")
                prompt = self._group_prompt(visible_by_binary[binary_text], targets)
            else:
                prompt = self._feature_prompt(visible_by_id[option.id])
            feature_list.replace_option_prompt_at_index(option_index, prompt)
        self._update_intent_preview(targets)

    def _highlighted_row(self) -> FeatureRow | None:
        option = self.query_one(OptionList).highlighted_option
        if option is None or option.id is None:
            return None
        return next((row for row in self._visible if str(row.index) == option.id), None)

    def _update_intent_preview(
        self,
        targets: dict[str, list[str]] | None = None,
    ) -> None:
        if self._loading:
            return
        pending = targets if targets is not None else self._selected_targets()
        self.query_one("#summary", Static).update(_SUMMARY.format(n=len(pending)))

    def on_input_changed(self, event: Input.Changed) -> None:
        self._rebuild_rows(event.value)

    def action_focus_filter(self) -> None:
        if self._loading or self._applying:
            return
        filter_input = self.query_one(Input)
        filter_input.value = ""
        filter_input.focus()

    def _focus_feature_list(self) -> None:
        if self._loading or self._applying:
            return
        feature_list = self.query_one(OptionList)
        if any(not option.disabled for option in feature_list.options):
            feature_list.focus()

    def action_toggle_row(self) -> None:
        if self._loading or self._applying:
            return
        row = self._highlighted_row()
        if row is None or row.state == "unsupported":
            return
        if row.index in self.selected:
            self.selected.remove(row.index)
        else:
            self.selected.add(row.index)
        self._refresh_selection()

    def action_toggle_all(self) -> None:
        if self._loading or self._applying:
            return
        visible_indices = {
            row.index for row in self._visible if row.state != "unsupported"
        }
        if not visible_indices:
            return
        if visible_indices <= self.selected:
            self.selected.difference_update(visible_indices)
        else:
            self.selected.update(visible_indices)
        self._refresh_selection()

    def _selected_targets(self) -> dict[str, list[str]]:
        """返回需要重放的目标集；任何 mixed 入站态都必须显式修复。"""
        targets: dict[str, list[str]] = {}
        binary_order = list(dict.fromkeys(row.binary for row in self.rows))
        for binary in binary_order:
            binary_rows = [row for row in self.rows if row.binary == binary]
            selected = [row.feature for row in binary_rows if row.index in self.selected]
            effective = set(resolve_closure(selected))
            current_patched = {
                row.feature for row in binary_rows if row.state == "patched"
            }
            has_mixed = any(row.state == "mixed" for row in binary_rows)
            if has_mixed or effective != current_patched:
                targets[str(binary)] = selected
        return targets

    def action_confirm(self) -> None:
        if self._loading or self._applying:
            return
        if self.query_one(Input).has_focus:
            self._focus_feature_list()
            return
        self.result = self._selected_targets()
        if not self.result:
            # 无待执行变更：给出明确反馈但不退出，留在 TUI 供继续操作。
            self.query_one("#progress", Static).update(
                "Nothing to apply (checked=target) | space toggle | a visible | esc quit"
            )
            return
        self._applying = True
        self.query_one("#progress", Static).update(
            f"Running: 0 / {len(self.result)}... please wait, do not close during write"
        )
        self._apply_worker(self.result)

    @work(thread=True)
    def _apply_worker(self, target: dict[str, list[str]]) -> None:
        outcomes: list[WriteOutcome] = []
        errors: list[str] = []
        exit_code = 0
        total = len(target)
        for done, (binary_text, features) in enumerate(target.items(), start=1):
            binary = Path(binary_text)
            try:
                current_data = binary.read_bytes()
                outcome = orchestrate.write_features(
                    binary,
                    features,
                    current_data=current_data,
                    log=lambda _message: None,
                )
            except Exception as error:  # noqa: BLE001 - worker 必须把 guard 与动作错误现形到 UI。
                detail = self._error_message(error)
                message = f"{binary}: {detail}"
                errors.append(message)
                exit_code = max(exit_code, self._error_exit_code(error))
                self.call_from_thread(
                    self._post_progress,
                    done,
                    total,
                    binary,
                    None,
                    message,
                )
                continue
            outcomes.append(outcome)
            self.call_from_thread(
                self._post_progress,
                done,
                total,
                binary,
                outcome,
                None,
            )
        # 写盘完成后，在同一 worker 线程内只读重探，拿到刷新后的 feature 现实态，
        # 避免另起 worker 造成竞态；探测失败则回退旧行，不掀翻 App。
        try:
            rows = self._load_rows()
        except Exception:  # noqa: BLE001 - 重探失败不应吞掉已完成的写盘结果。
            rows = None
        self.call_from_thread(self._finish_apply, outcomes, errors, exit_code, rows)

    @staticmethod
    def _error_message(error: Exception) -> str:
        if isinstance(error, orchestrate.DependentFeatureStillEnabled):
            return f"Remove features depending on {error.feature} first: {', '.join(error.dependants)}"
        if isinstance(error, orchestrate.VersionDriftRejected):
            return "Baseline version differs from current binary; downgrade rejected"
        if isinstance(error, orchestrate.NoBaselineRejected):
            messages = {
                orchestrate.NoBaselineReason.CHANNELS_PATCHED_NO_BASELINE: "channels is patched but has no clean baseline; reinstall a clean Claude Code",
                orchestrate.NoBaselineReason.VERSION_PROBE_FAILED: "Cannot probe binary version; write rejected",
                orchestrate.NoBaselineReason.REBUILD_ROUNDTRIP_FAILED: "Binary reversibility check failed; data may be corrupted",
                orchestrate.NoBaselineReason.UNSUPPORTED_OR_MIXED_NO_BASELINE: "Inbound binary structure cannot safely establish a baseline; reinstall a clean Claude Code",
                orchestrate.NoBaselineReason.INVALID_BASELINE: "Baseline content or version check failed; reinstall or rebuild the clean baseline",
            }
            return messages[error.reason]
        if isinstance(error, orchestrate.ConcurrentBinaryChange):
            return "Binary was modified concurrently during the operation (possible auto-upgrade); retry"
        if isinstance(error, orchestrate.ContentMismatch):
            return f"Content consistency check failed: {error}"
        if isinstance(error, StoreError):
            return str(error)
        if isinstance(error, OSError):
            return f"Cannot access binary or runtime environment: {error}"
        return f"Feature action or re-signing failed: {type(error).__name__}: {error}"

    @staticmethod
    def _error_exit_code(error: Exception) -> int:
        if isinstance(error, StoreError):
            return error.exit_code
        if isinstance(error, orchestrate.ContentMismatch):
            return 2
        if isinstance(
            error,
            (
                orchestrate.NoBaselineRejected,
                orchestrate.VersionDriftRejected,
                orchestrate.ConcurrentBinaryChange,
                orchestrate.DependentFeatureStillEnabled,
                OSError,
            ),
        ):
            return 1
        return 3

    def _post_progress(
        self,
        done: int,
        total: int,
        binary: Path,
        outcome: WriteOutcome | None,
        error: str | None,
    ) -> None:
        if error is not None:
            tail = f"error: {error}"
        else:
            tail = f"{binary} -> {outcome.edits if outcome is not None else 0} edit(s)"
        self.query_one("#progress", Static).update(
            f"Running: {done} / {total}...{tail}"
        )

    def _finish_apply(
        self,
        outcomes: list[WriteOutcome],
        errors: list[str],
        exit_code: int,
        rows: list[FeatureRow] | None,
    ) -> None:
        self._applying = False
        self.outcomes = outcomes
        self.errors = errors
        self.exit_code = exit_code
        summary = f"Done: {len(outcomes)} / {len(outcomes) + len(errors)} succeeded (exit code {exit_code})"
        if errors:
            summary += " | errors: " + "; ".join(errors)
        # 用重探结果刷新列表与选中集，令展示反映写盘后的现实态；随后停留在 TUI，
        # 用户可继续勾选执行下一批，或 q/esc 退出。
        if rows is not None:
            self.rows = rows
            self.selected = {
                row.index for row in self.rows if row.state in {"patched", "mixed"}
            }
            self._binary_labels = self._short_binary_labels()
            self._rebuild_rows()
            summary += " | state refreshed, keep selecting to run more | esc quit"
        else:
            summary += " | state refresh failed, restart the tool to re-check | esc quit"
        self.query_one("#progress", Static).update(summary)

    def action_cancel(self) -> None:
        if self._loading or self._applying:
            return
        self.result = None
        self.exit()


def run_tui(binary_paths: list[Path]) -> int | None:
    """在交互终端运行 TUI；非 TTY 返回 None 供 CLI 降级文本报告。"""
    if not (sys.stdin.isatty() and sys.stdout.isatty()):
        return None
    app = CcPatchApp(binary_paths)
    app.run()
    return app.exit_code
