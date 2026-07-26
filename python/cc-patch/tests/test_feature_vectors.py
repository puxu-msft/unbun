import json
from dataclasses import replace
from pathlib import Path

import pytest

from cc_patch import features, probe
from cc_patch.features import agent_model, channels, source_exec
from cc_patch.models import FeatureSubstate


REPO_ROOT = Path(__file__).parents[3]
VECTOR_DIR = REPO_ROOT / "contract" / "vectors" / "feature-claude-v1" / "fixtures"
GOLDEN_DIR = REPO_ROOT / "contract" / "golden" / "claude-v1"


def load_vector(name: str) -> dict:
    return json.loads((VECTOR_DIR / name).read_text())


def make_virtual_binary(case: dict) -> bytes:
    data = bytearray(case["size"])
    for segment in case["segments"]:
        value = segment["ascii"].encode("latin-1")
        offset = segment["offset"]
        data[offset : offset + len(value)] = value
    return bytes(data)


def test_feature_protocol_exposes_structured_stable_substates():
    data = b"// @bun @bytecode xx // @bun @source__"

    observed = source_exec.FEATURE.observe_substates(data)

    assert observed == [
        FeatureSubstate("source-exec:tag:0", 7, 10, "clean"),
        FeatureSubstate("source-exec:tag:1", 28, 10, "patched"),
    ]
    replay = bytearray(data)
    assert source_exec.FEATURE.replay_substates(replay, observed, "patched") == 1
    assert source_exec.FEATURE.detect(bytes(replay)).state == "patched"


def test_dependency_vectors_are_consumed_directly():
    inputs = load_vector("dependency-input.json")
    expected = load_vector("dependency-expected.json")

    assert {name: feature.requires for name, feature in features.REGISTRY.items()} == inputs[
        "requires"
    ]
    assert [features.resolve_closure(request) for request in inputs["requests"]] == expected[
        "closures"
    ]


@pytest.mark.parametrize("case_id", ["first-tail-multi-tag", "32mb-boundary", "overlapping-windows"])
def test_source_exec_virtual_vectors_match_full_and_windowed(case_id):
    inputs = load_vector("source-exec-input.json")
    expected = load_vector("source-exec-expected.json")["results"][case_id]
    case = next(item for item in inputs["cases"] if item["id"] == case_id)
    data = make_virtual_binary(case)

    full = source_exec.FEATURE.detect(data)
    windowed = probe.detect_features(data)["source-exec"]

    assert full == windowed
    assert full.state == expected["state"]
    assert [site.offset for site in full.substates] == expected["sites"]


def test_source_exec_discovers_tags_in_the_middle_of_a_large_binary():
    """覆盖盲区回归：discovery 曾只扫首尾各 32MB，中段的 `// @bun` 标记会被静默漏掉。

    candidates_complete 只检查候选是否跨越边界、不检查「有没有没扫过的区域」，所以连
    fail-closed 回落都不会触发，直接违反「不允许返回较少站点的快速近似」。
    """
    case = {
        "size": 200_000_000,
        "segments": [
            {"offset": 1_000, "ascii": "// @bun @bytecode"},
            {"offset": 100_000_000, "ascii": "// @bun @bytecode"},
            {"offset": 199_000_000, "ascii": "// @bun @bytecode"},
        ],
    }
    data = make_virtual_binary(case)

    full = source_exec.FEATURE.detect(data)
    windowed = probe.detect_features(data)["source-exec"]

    assert len(full.substates) == 3
    assert full == windowed


def test_source_exec_state_vectors_and_replay_all_sites():
    inputs = load_vector("source-exec-input.json")
    expected = load_vector("source-exec-expected.json")["results"]
    states = next(item for item in inputs["cases"] if item["id"] == "states")["inputs"]

    for state, chunks in states.items():
        data = ";".join(chunks).encode("latin-1")
        status = source_exec.FEATURE.detect(data)
        assert status.state == expected[state]["state"]
        assert status.sites == expected[state]["sites"]

    manual = bytearray(b"// @bun @bytecode;second;// @bun @bytecode")
    observed = source_exec.FEATURE.observe_substates(bytes(manual))
    assert len(observed) == 2
    assert source_exec.FEATURE.replay_substates(manual, observed, "patched") == 2
    assert manual.count(source_exec.BUN_SOURCE_FALLBACK_MARKER) == 2

    clean = bytearray(b"// @bun @bytecode;second;// @bun @bytecode")
    observed = source_exec.FEATURE.observe_substates(bytes(clean))
    with pytest.raises(ValueError, match="site collection is incomplete"):
        source_exec.FEATURE.replay_substates(clean, [observed[1]], "patched")


def test_agent_model_audited_vectors_preserve_receiver_and_reject_unknown_enum():
    inputs = load_vector("agent-model-input.json")
    expected = load_vector("agent-model-expected.json")["variants"]

    for variant in inputs["audited_variants"]:
        data = variant["ascii"].encode("latin-1")
        status = agent_model.FEATURE.detect(data)
        assert status.state == expected[variant["id"]]["state"]
        assert status.sites == expected[variant["id"]]["sites"]
        replay = bytearray(data)
        assert agent_model.FEATURE.replay_substates(replay, status.substates, "patched") == 1
        assert bytes(replay).startswith(expected[variant["id"]]["replacement_prefix"].encode("latin-1"))

    unknown = inputs["unknown_variant"].encode("latin-1")
    status = agent_model.FEATURE.detect(unknown)
    assert status.state == "unsupported"
    assert status.detail_codes == (expected["unknown-variant"]["code"],)


def test_agent_model_replay_rejects_forged_receiver_swap():
    clean = (
        b"model:S.enum([\"sonnet\",\"opus\",\"haiku\",\"fable\"])"
        + agent_model.DESCRIBE_SUFFIX
        + b";model:E.enum([\"sonnet\",\"opus\",\"haiku\",\"fable\"])"
        + agent_model.DESCRIBE_SUFFIX
    )
    observed = agent_model.FEATURE.observe_substates(clean)
    assert [site.receiver for site in observed] == ["S", "E"]

    swapped = bytearray(clean.replace(b"model:S.", b"model:X.").replace(b"model:E.", b"model:S.").replace(b"model:X.", b"model:E."))

    with pytest.raises(ValueError, match="receiver mismatch: S"):
        agent_model.FEATURE.replay_substates(swapped, observed, "patched")


def test_agent_model_multiple_suffixes_and_manual_second_suffix_are_all_sites():
    inputs = load_vector("agent-model-input.json")
    data = inputs["multiple_suffixes"].encode("latin-1")
    status = agent_model.FEATURE.detect(data)
    assert status.sites == 2

    manual = bytearray(data + b";tag:" + inputs["audited_variants"][2]["ascii"].encode("latin-1"))
    observed = agent_model.FEATURE.observe_substates(bytes(manual))
    assert len(observed) == 3
    assert agent_model.FEATURE.replay_substates(manual, observed, "patched") == 3
    assert manual.count(agent_model.REPLACE_CORE) == 3

    clean = bytearray(data)
    observed = agent_model.FEATURE.observe_substates(bytes(clean))
    with pytest.raises(ValueError, match="site collection is incomplete"):
        agent_model.FEATURE.replay_substates(clean, [observed[1]], "patched")


@pytest.mark.parametrize("feature_name", ["source-exec", "agent-model", "channels"])
@pytest.mark.parametrize(
    ("mutation", "message"),
    [
        (lambda sites: [replace(sites[0], identity="forged"), *sites[1:]], "site identity mismatch"),
        (lambda sites: [replace(sites[0], offset=sites[0].offset + 1), *sites[1:]], "site identity mismatch"),
        (lambda sites: [sites[0], replace(sites[1], identity=sites[0].identity), *sites[2:]], "site identity mismatch"),
        (lambda sites: [replace(sites[0], state="unsupported"), *sites[1:]], "unknown state"),
    ],
)
def test_replay_rejects_forged_or_invalid_full_vector(feature_name, mutation, message):
    fixtures = {
        "source-exec": b"// @bun @bytecode;x;// @bun @bytecode",
        "agent-model": (
            b"model:S." + agent_model.ENUM_CORE + agent_model.DESCRIBE_SUFFIX
            + b";model:E." + agent_model.ENUM_CORE + agent_model.DESCRIBE_SUFFIX
        ),
        "channels": build_channels_case(
            load_vector("channels-input.json")["decision_clean"],
            [
                load_vector("channels-input.json")["support"]["essential_clean"],
                load_vector("channels-input.json")["support"]["permissions_clean"],
                load_vector("channels-input.json")["support"]["cap_strip_clean"],
            ],
        ),
    }
    feature = features.REGISTRY[feature_name]
    data = bytearray(fixtures[feature_name])
    observed = feature.observe_substates(bytes(data))
    assert len(observed) >= 2

    with pytest.raises(ValueError, match=message):
        feature.replay_substates(data, mutation(observed))


def test_channels_replay_rejects_incomplete_vector():
    inputs = load_vector("channels-input.json")
    data = bytearray(
        build_channels_case(
            inputs["decision_clean"],
            [
                inputs["support"]["essential_clean"],
                inputs["support"]["permissions_clean"],
                inputs["support"]["cap_strip_clean"],
            ],
        )
    )
    observed = channels.FEATURE.observe_substates(bytes(data))

    with pytest.raises(ValueError, match="site collection is incomplete"):
        channels.FEATURE.replay_substates(data, observed[1:])


def build_channels_case(decision: str, support: list[str]) -> bytes:
    return (decision + ";" + ";".join(support)).encode("latin-1")


def test_channels_vectors_skip_all_register_decoys_and_collect_all_site_kinds():
    inputs = load_vector("channels-input.json")
    support = inputs["support"]
    base_support = [
        support["essential_clean"],
        support["permissions_clean"],
        support["cap_strip_clean"],
    ]

    for key in ("tail_register_decoy", "multiple_decoys"):
        decision = inputs[key].replace("REAL_DECISION", inputs["decision_clean"])
        status = channels.FEATURE.detect(build_channels_case(decision, base_support))
        assert status.state == "clean"
        assert [site.identity for site in status.substates] == [
            "channels:decision:0",
            "channels:feature-flag:0",
            "channels:permissions:0",
            "channels:cap-strip:0",
        ]


def test_channels_essential_and_best_effort_vectors_have_structured_codes():
    inputs = load_vector("channels-input.json")
    support = inputs["support"]
    missing_essential = build_channels_case(
        inputs["decision_clean"],
        [support["permissions_clean"], support["cap_strip_clean"]],
    )
    status = channels.FEATURE.detect(missing_essential)
    assert status.state == "mixed"
    assert status.detail_codes == ("channels_essential_site_missing",)

    best_effort_mixed = channels.FEATURE.detect(
        build_channels_case(
            inputs["decision_clean"],
            [support["essential_clean"], support["permissions_clean"], support["cap_strip_patched"]],
        )
    )
    assert best_effort_mixed.state == "mixed"

    optional_absent = channels.FEATURE.detect(
        build_channels_case(inputs["decision_clean"], [support["essential_clean"]])
    )
    assert optional_absent.state == "clean"
    assert [(site.identity, site.state, site.essential) for site in optional_absent.substates] == [
        ("channels:decision:0", "clean", True),
        ("channels:feature-flag:0", "clean", True),
        ("channels:permissions:absent", "absent", False),
        ("channels:cap-strip:absent", "absent", False),
    ]
    assert [site.offset for site in optional_absent.substates if site.state == "absent"] == [
        len(build_channels_case(inputs["decision_clean"], [support["essential_clean"]]))
    ] * 2


def test_channels_replay_rejects_absent_observation_as_non_replayable_state():
    inputs = load_vector("channels-input.json")
    data = bytearray(
        build_channels_case(
            inputs["decision_clean"],
            [inputs["support"]["essential_clean"]],
        )
    )
    observed = channels.FEATURE.observe_substates(bytes(data))
    assert any(site.state == "absent" for site in observed)

    with pytest.raises(ValueError, match="site collection is incomplete|unknown state"):
        channels.FEATURE.replay_substates(data, observed)


def test_channels_replay_substates_rebuilds_mixed_target_exactly_from_clean():
    inputs = load_vector("channels-input.json")
    support = inputs["support"]
    clean = build_channels_case(
        inputs["decision_clean"],
        [support["essential_clean"], support["permissions_clean"], support["cap_strip_clean"]],
    )
    target = build_channels_case(
        inputs["decision_clean"],
        [support["essential_clean"], support["permissions_clean"], support["cap_strip_patched"]],
    )
    vector = channels.FEATURE.observe_substates(target)
    replay = bytearray(clean)

    assert channels.FEATURE.replay_substates(replay, vector) == 1
    assert bytes(replay) == target


def test_historical_golden_full_and_windowed_statuses_are_identical():
    expected = {
        "synthetic-2.1.175-clean.bin": "clean",
        "synthetic-2.1.175-all-patched.bin": "patched",
    }
    for filename, state in expected.items():
        data = (GOLDEN_DIR / filename).read_bytes()
        windowed = probe.detect_features(data)
        for name, feature in features.REGISTRY.items():
            full = feature.detect(data)
            assert windowed[name] == full
            assert full.state == state