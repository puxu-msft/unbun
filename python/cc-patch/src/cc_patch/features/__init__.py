from typing import Literal, Protocol, TypeAlias

from cc_patch.models import FeatureStatus, FeatureSubstate, ProbeSlice


ProbeWindow: TypeAlias = tuple[int, int]


class Feature(Protocol):
    name: str
    title: str
    description: str
    requires: list[str]
    reversible: bool

    def detect(self, data: bytes) -> FeatureStatus: ...

    def probe_windows(self, view: bytes) -> list[ProbeWindow] | None: ...

    def detect_windows(self, windows: list[ProbeSlice]) -> FeatureStatus | None: ...

    def observe_substates(self, data: bytes, base_offset: int = 0) -> list[FeatureSubstate]: ...

    def replay_substates(
        self,
        data: bytearray,
        substates: list[FeatureSubstate] | tuple[FeatureSubstate, ...],
        target_state: Literal["clean", "patched"] | None = None,
    ) -> int: ...

    def apply(self, data: bytearray) -> int: ...


class ReversibleFeature(Feature, Protocol):
    def reverse(self, data: bytearray) -> int: ...


REGISTRY: dict[str, Feature] = {}


def register(feature: Feature) -> None:
    if feature.name in REGISTRY:
        raise ValueError(f"duplicate feature: {feature.name}")
    REGISTRY[feature.name] = feature


def resolve_closure(selected: list[str]) -> list[str]:
    selected_unique = list(dict.fromkeys(selected))
    for slug in selected_unique:
        if slug not in REGISTRY:
            raise KeyError(slug)

    closure: set[str] = set()

    def collect(slug: str) -> None:
        if slug in closure:
            return
        if slug not in REGISTRY:
            raise KeyError(slug)
        closure.add(slug)
        for dependency in REGISTRY[slug].requires:
            collect(dependency)

    for slug in selected_unique:
        collect(slug)

    indegree = {slug: 0 for slug in closure}
    dependants = {slug: [] for slug in closure}
    for slug in closure:
        for dependency in REGISTRY[slug].requires:
            if dependency not in closure:
                continue
            indegree[slug] += 1
            dependants[dependency].append(slug)

    registry_order = {slug: index for index, slug in enumerate(REGISTRY)}
    ready = sorted(
        (slug for slug, degree in indegree.items() if degree == 0),
        key=registry_order.__getitem__,
    )
    ordered: list[str] = []
    while ready:
        slug = ready.pop(0)
        ordered.append(slug)
        for dependant in sorted(dependants[slug], key=registry_order.__getitem__):
            indegree[dependant] -= 1
            if indegree[dependant] == 0:
                ready.append(dependant)
                ready.sort(key=registry_order.__getitem__)

    if len(ordered) != len(closure):
        cycle = sorted(slug for slug, degree in indegree.items() if degree > 0)
        raise ValueError(f"feature dependency cycle: {', '.join(cycle)}")
    return ordered


# Import built-in features in dependency order so registration is complete for all callers.
from cc_patch.features import source_exec as source_exec  # noqa: E402,F401
from cc_patch.features import agent_model as agent_model  # noqa: E402,F401
from cc_patch.features import channels as channels  # noqa: E402,F401
