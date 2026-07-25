from dataclasses import dataclass, field

import pytest

from cc_patch import features
from cc_patch.models import FeatureStatus


@dataclass
class FakeFeature:
    name: str
    requires: list[str] = field(default_factory=list)
    title: str = "fake"
    description: str = "fake feature"
    reversible: bool = True

    def detect(self, data: bytes) -> FeatureStatus:
        return FeatureStatus(self.name, "unsupported", [], 0)

    def probe_window(self, view: bytes) -> tuple[int, int] | None:
        return None

    def apply(self, data: bytearray) -> int:
        return 0

    def reverse(self, data: bytearray) -> int:
        return 0


def install_registry(monkeypatch, *items: FakeFeature) -> None:
    monkeypatch.setattr(features, "REGISTRY", {item.name: item for item in items})


def test_builtin_registry_loads_all_features_in_dependency_order():
    assert list(features.REGISTRY) == ["source-exec", "agent-model", "channels"]
    assert features.resolve_closure(["agent-model", "channels"]) == [
        "source-exec",
        "agent-model",
        "channels",
    ]


def test_resolve_closure_includes_dependency_before_selected(monkeypatch):
    source_exec = FakeFeature("source-exec")
    agent_model = FakeFeature("agent-model", ["source-exec"])
    install_registry(monkeypatch, source_exec, agent_model)

    assert features.resolve_closure(["agent-model"]) == ["source-exec", "agent-model"]


def test_resolve_closure_deduplicates_and_orders_dependencies(monkeypatch):
    source_exec = FakeFeature("source-exec")
    agent_model = FakeFeature("agent-model", ["source-exec"])
    channels = FakeFeature("channels", ["source-exec"], reversible=False)
    install_registry(monkeypatch, source_exec, agent_model, channels)

    result = features.resolve_closure(
        ["source-exec", "agent-model", "channels", "source-exec"]
    )

    assert result.count("source-exec") == 1
    assert set(result) == {"source-exec", "agent-model", "channels"}
    assert result.index("source-exec") < result.index("agent-model")
    assert result.index("source-exec") < result.index("channels")


def test_resolve_closure_rejects_dependency_cycle(monkeypatch):
    install_registry(
        monkeypatch,
        FakeFeature("A", ["B"]),
        FakeFeature("B", ["A"]),
    )

    with pytest.raises(ValueError, match="A.*B|B.*A"):
        features.resolve_closure(["A"])


def test_resolve_closure_rejects_unknown_slug(monkeypatch):
    install_registry(monkeypatch, FakeFeature("source-exec"))

    with pytest.raises(KeyError, match="missing"):
        features.resolve_closure(["missing"])
