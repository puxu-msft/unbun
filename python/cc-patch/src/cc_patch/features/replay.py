from collections.abc import Sequence

from cc_patch.models import FeatureSubstate


class SubstateReplayError(ValueError):
    code = "substate_unreplayable"

    def __init__(self, message: str):
        super().__init__(f"substate_unreplayable: {message}")


def validate_replay(
    current: Sequence[FeatureSubstate],
    desired: Sequence[FeatureSubstate],
    *,
    allow_absent: bool = False,
) -> None:
    if len(desired) != len(current):
        raise SubstateReplayError("site collection is incomplete")
    valid_states = {"clean", "patched"}
    if allow_absent:
        valid_states.add("absent")
    for index, (current_site, desired_site) in enumerate(
        zip(current, desired, strict=True)
    ):
        if (
            desired_site.identity != current_site.identity
            or desired_site.offset != current_site.offset
            or desired_site.length != current_site.length
        ):
            raise SubstateReplayError(f"site identity mismatch at index {index}")
        if desired_site.state not in valid_states:
            raise SubstateReplayError(
                f"unknown state for {desired_site.identity}"
            )
