import argparse
import hashlib
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping


SUCCESS = 0
UNREPLAYABLE = 3
BASELINE_STALE = 4


class SubstateUnreplayable(ValueError):
    pass


class UnsupportedFormat(ValueError):
    pass


@dataclass(frozen=True)
class ReplaySite:
    offset: int
    clean: bytes
    patched: bytes


SITE_SPECS = {
    "source-exec": {
        "marker": ReplaySite(8, b"@bytecode", b"@source__"),
    },
    "agent-model": {
        "schema": ReplaySite(
            305,
            b'Q.enum(["sonnet","opus","haiku","fable"])',
            b"Q.string()/* any model ................*/",
        ),
    },
    "channels": {
        "decision": ReplaySite(
            583,
            (
                b'if(n6()!=="firstParty")return{action:"skip",kind:"provider",reason:"channels '
                b'are not available on third-party providers"};if(!oYH())return{action:"skip",'
                b'kind:"disabled",reason:"channels feature is not currently available"};let _='
                b'TGH(H);if(!_)return{action:"skip",kind:"session",reason:`not in list`};else '
                b'if(!_.dev)return{action:"skip",kind:"allowlist",reason:`server ${_.name} is not '
                b'on the approved channels allowlist`};return{action:"register"}'
            ),
            b'return{action:"register"}' + (b" " * 422),
        ),
        "feature_flag": ReplaySite(
            49,
            b'w$("tengu_harbor",!1)',
            b'w$("tengu_harbor",!0)',
        ),
        "permissions": ReplaySite(
            93,
            b'w$("tengu_harbor_permissions",!1)',
            b'w$("tengu_harbor_permissions",!0)',
        ),
        "cap_strip": ReplaySite(
            228,
            b"||!b$q(u8.config.pluginSource)",
            b"&&!b$q(u8.config.pluginSource)",
        ),
    },
}


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def normalize_synthetic_elf_like(data: bytes) -> bytes:
    return data


def _pe_error(detail: str) -> None:
    raise UnsupportedFormat(f"unsupported PE: {detail}")


def normalize_pe(data: bytes) -> bytes:
    if len(data) < 0x40:
        _pe_error("truncated DOS header")
    if data[:2] != b"MZ":
        _pe_error("invalid DOS magic")
    pe_offset = int.from_bytes(data[0x3C:0x40], "little")
    if pe_offset < 0x40 or pe_offset + 24 > len(data):
        _pe_error("PE header offset is out of bounds")
    if data[pe_offset : pe_offset + 4] != b"PE\0\0":
        _pe_error("invalid PE magic")

    coff_offset = pe_offset + 4
    machine = int.from_bytes(data[coff_offset : coff_offset + 2], "little")
    section_count = int.from_bytes(data[coff_offset + 2 : coff_offset + 4], "little")
    optional_size = int.from_bytes(data[coff_offset + 16 : coff_offset + 18], "little")
    if machine != 0x8664:
        _pe_error("COFF machine is not x86_64")
    if section_count == 0:
        _pe_error("COFF section count is zero")
    if optional_size != 0xF0:
        _pe_error("contradictory PE32+ optional-header size")

    optional_offset = coff_offset + 20
    optional_end = optional_offset + optional_size
    if optional_end > len(data):
        _pe_error("truncated optional header")
    if int.from_bytes(data[optional_offset : optional_offset + 2], "little") != 0x20B:
        _pe_error("contradictory PE32+ optional-header magic")
    file_alignment = int.from_bytes(data[optional_offset + 36 : optional_offset + 40], "little")
    size_of_headers = int.from_bytes(data[optional_offset + 60 : optional_offset + 64], "little")
    if file_alignment < 0x200 or file_alignment & (file_alignment - 1):
        _pe_error("invalid file alignment")

    section_table_end = optional_end + section_count * 40
    if section_table_end > len(data) or size_of_headers < section_table_end or size_of_headers > len(data):
        _pe_error("section table exceeds headers")
    for index in range(section_count):
        section_offset = optional_end + index * 40
        raw_size = int.from_bytes(data[section_offset + 16 : section_offset + 20], "little")
        raw_offset = int.from_bytes(data[section_offset + 20 : section_offset + 24], "little")
        if raw_size == 0:
            continue
        if (
            raw_offset < size_of_headers
            or raw_offset % file_alignment
            or raw_size % file_alignment
            or raw_offset + raw_size > len(data)
        ):
            _pe_error(f"section {index} raw data is inconsistent")
    return data


def _shifted_site_specs(offset: int) -> dict[str, dict[str, ReplaySite]]:
    return {
        feature: {
            name: ReplaySite(site.offset + offset, site.clean, site.patched)
            for name, site in sites.items()
        }
        for feature, sites in SITE_SPECS.items()
    }


def _format_operations(manifest: Mapping[str, object]):
    if manifest["format"] == "synthetic-elf-like":
        return normalize_synthetic_elf_like, SITE_SPECS
    if manifest["format"] == "pe":
        payload_offset = manifest.get("payload_offset")
        if not isinstance(payload_offset, int) or payload_offset < 0:
            _pe_error("manifest payload offset is invalid")
        return normalize_pe, _shifted_site_specs(payload_offset)
    return None


def _feature_states(feature: str, value: object, sites: Mapping[str, ReplaySite]) -> dict[str, str]:
    if isinstance(value, str):
        if value not in {"clean", "patched"}:
            raise SubstateUnreplayable(f"unknown state: {feature}")
        return {site_name: value for site_name in sites}
    if not isinstance(value, dict):
        raise SubstateUnreplayable(f"unknown state: {feature}")

    states = {}
    for site_name in sites:
        if site_name not in value:
            raise SubstateUnreplayable(f"missing state: {feature}.{site_name}")
        state = value[site_name]
        if state not in {"clean", "patched"}:
            raise SubstateUnreplayable(f"unknown state: {feature}.{site_name}")
        states[site_name] = state
    if set(value) != set(sites):
        unknown_site = next(iter(set(value) - set(sites)))
        raise SubstateUnreplayable(f"unknown site: {feature}.{unknown_site}")
    return states


def replay_substates(
    clean_baseline: bytes,
    substates: Mapping[str, object],
    site_specs: Mapping[str, Mapping[str, ReplaySite]] = SITE_SPECS,
) -> bytes:
    feature_order = ("source-exec", "agent-model", "channels")
    unknown_features = set(substates) - set(feature_order)
    if unknown_features:
        raise SubstateUnreplayable(f"unknown feature: {sorted(unknown_features)[0]}")

    replayed = bytearray(clean_baseline)
    for feature in feature_order:
        if feature not in substates:
            raise SubstateUnreplayable(f"missing state: {feature}")
        if feature not in site_specs:
            raise SubstateUnreplayable(f"missing feature: {feature}")

        expected_sites = SITE_SPECS[feature]
        feature_sites = site_specs[feature]
        states = _feature_states(feature, substates[feature], expected_sites)
        for site_name, state in states.items():
            if site_name not in feature_sites:
                raise SubstateUnreplayable(f"missing site: {feature}.{site_name}")
            site = feature_sites[site_name]
            if len(site.clean) != len(site.patched):
                raise SubstateUnreplayable(f"site length mismatch: {feature}.{site_name}")
            end = site.offset + len(site.clean)
            if site.offset < 0 or end > len(clean_baseline):
                raise SubstateUnreplayable(f"site out of bounds: {feature}.{site_name}")
            if clean_baseline[site.offset:end] != site.clean:
                raise SubstateUnreplayable(f"baseline site mismatch: {feature}.{site_name}")
            replayed[site.offset:end] = site.clean if state == "clean" else site.patched
    return bytes(replayed)


def _baseline_path(manifest: Mapping[str, object], manifest_path: Path | None) -> Path:
    base_dir = manifest_path.resolve().parent if manifest_path else Path(__file__).resolve().parent.parent / "fixtures"
    return (base_dir / manifest["baseline"]["path"]).resolve()


def _result_base(manifest: Mapping[str, object], current: bytes) -> dict[str, object]:
    return {
        "implementation": "python",
        "format": manifest["format"],
        "supported": False,
        "normalized_size": len(current),
        "baseline_lineage_sha256": manifest["baseline"]["sha256"],
        "expected_sha256": None,
        "current_sha256": sha256(current),
        "byte_equal": False,
        "error": "substate_unreplayable",
    }


def evaluate_case(
    manifest: Mapping[str, object],
    case_name: str,
    current: bytes,
    manifest_path: Path | None = None,
) -> tuple[dict[str, object], int]:
    result = _result_base(manifest, current)
    operations = _format_operations(manifest)
    if operations is None:
        result["error"] = "unsupported_format"
        return result, UNREPLAYABLE

    normalize, site_specs = operations

    scenario = manifest["cases"][case_name]
    baseline = _baseline_path(manifest, manifest_path).read_bytes()
    if len(baseline) != manifest["normalized_size"] or sha256(baseline) != manifest["baseline"]["sha256"]:
        raise ValueError("frozen baseline does not match manifest size and sha256")

    try:
        normalized_current = normalize(current)
        normalize(baseline)
        expected = replay_substates(baseline, scenario["substates"], site_specs)
        normalized_expected = normalize(expected)
    except UnsupportedFormat:
        result["error"] = "unsupported_format"
        return result, UNREPLAYABLE
    except SubstateUnreplayable:
        return result, UNREPLAYABLE

    size_equal = len(normalized_expected) == len(normalized_current)
    byte_equal = size_equal and normalized_expected == normalized_current
    result.update(
        {
            "supported": True,
            "expected_sha256": sha256(normalized_expected),
            "byte_equal": byte_equal,
            "error": None if byte_equal else "baseline_stale_build",
        }
    )
    return result, SUCCESS if byte_equal else BASELINE_STALE


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--case", required=True)
    parser.add_argument("--current", required=True)
    parser.add_argument("--write-expected")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    manifest_path = Path(args.manifest)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if args.case not in manifest.get("cases", {}):
        raise ValueError(f"unknown fixture case: {args.case}")
    current = Path(args.current).read_bytes()
    result, exit_code = evaluate_case(manifest, args.case, current, manifest_path)
    if args.write_expected and exit_code == SUCCESS:
        baseline = _baseline_path(manifest, manifest_path).read_bytes()
        operations = _format_operations(manifest)
        if operations is None:
            raise UnsupportedFormat(f"unsupported format: {manifest['format']}")
        normalize, site_specs = operations
        normalize(baseline)
        expected = normalize(replay_substates(baseline, manifest["cases"][args.case]["substates"], site_specs))
        if sha256(expected) != result["expected_sha256"]:
            raise ValueError("materialized expected bytes do not match result hash")
        Path(args.write_expected).write_bytes(expected)
    print(json.dumps(result, separators=(",", ":")))
    if exit_code != SUCCESS:
        diagnostic = f"exact replay rejected {args.case}: {result['error']}"
        if manifest["format"] == "pe" and result["error"] == "unsupported_format":
            try:
                normalize_pe(current)
            except UnsupportedFormat as error:
                diagnostic = str(error)
        print(diagnostic, file=sys.stderr)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
