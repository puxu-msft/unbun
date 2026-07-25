# Exact replay proof PoC

Phase 1 Tasks 1.1 through 1.4 freeze the fixture corpus and result contract, implement independent JavaScript and Python synthetic exact replay PoCs, and cross-check every case through their process boundaries. Both PoC boundaries now have `maturity=mature-poc`: they independently replay from the frozen clean baseline, compare complete bytes before success, and emit schema-valid results with matching exit semantics and hashes. They remain PoCs rather than production patch paths.

## Fixture facts

[`fixtures/manifest.json`](fixtures/manifest.json) is the inventory and semantic oracle. Its baseline and all-target fixtures reference the existing 1031-byte frozen golden pair. The four unique intermediate dependency closures and the replayable/unreplayable mixed cases are pinned beside the manifest. Agent-only and explicit source-plus-agent bytes are derived from the immutable clean golden by the independent `fixtures/migrate-agent-model-dependency.mjs` script using an audited fixed site registry, never by a production implementation. The migration is manually diffed: agent-only changes only bytes 307-345 and retains `@bytecode` at bytes 8-16; explicit source-plus-agent additionally changes only the source marker. The all-target fixture remains the independently frozen all-patched golden byte for byte.

These fixtures are synthetic ASCII blobs containing Claude-like patch anchors. They are not executable files and do not have an ELF header, so their format is recorded as `synthetic-elf-like`, `executable=false`, and `arch=synthetic`. Task 1.4 completes their cross-implementation contract but does not relabel them as executable ELF fixtures.

Task 1.4 also builds a real temporary Bun SFX with `bun build --compile --bytecode`. The runtime oracle edits `6 * 7` to equal-length `6 * 8` in two independent temporary copies, leaves one copy's `@bytecode` markers intact, flips all markers to `@source__` in the other, and executes the original plus both copies. On Bun 1.3.14, both edited copies print `48`; the intact-marker copy does not retain the original `42` behavior. The required bytecode-cache-versus-source-path contrast is therefore `not-proven`, and the ELF write gate remains disabled. This is a real runtime counterexample, not a marker-only test. The generated original fixture's SHA-256 is asserted unchanged before and after the experiment.

Tests never modify a pinned source fixture. Drift cases copy the clean golden to a temporary directory and inject exactly one byte. Offset `30` is outside the audited feature-owned ranges and represents same-version/different-build drift. Offset `600` is inside the channels decision-body owned range while leaving all three mature feature detectors in the clean state. A future implementation can therefore observe and replay the complete clean substate, but must reject the resulting full-byte mismatch instead of masking feature-owned bytes.

## Process contract

Both entrypoints accept the same required arguments and one PoC-only optional output argument:

```text
--manifest <manifest.json> --case <case-id> --current <binary-copy> [--write-expected <temporary-path>]
```

Each entrypoint writes exactly one JSON object to stdout. On a successful replay, `--write-expected` independently materializes that implementation's complete expected bytes at a caller-provided temporary path; rejected cases create no output file. The shared harness runs both directions, explicitly compares the produced bytes byte-for-byte with the pinned current fixture, and asks the other implementation to verify those bytes. [`../../contract/schemas/exact-replay-result.schema.json`](../../contract/schemas/exact-replay-result.schema.json) is unchanged and requires these fields:

```json
{
  "implementation": "js",
  "format": "synthetic-elf-like",
  "supported": true,
  "normalized_size": 1031,
  "baseline_lineage_sha256": "0a067e12954675a56d6a2aa25c4180c1746005d5cd9e438607d0fb913355ff61",
  "expected_sha256": "0a067e12954675a56d6a2aa25c4180c1746005d5cd9e438607d0fb913355ff61",
  "current_sha256": "0a067e12954675a56d6a2aa25c4180c1746005d5cd9e438607d0fb913355ff61",
  "byte_equal": true,
  "error": null
}
```

An unsupported result cannot claim byte equality or provide an expected replay hash. Once an implementation reports `supported=true`, a successful proof requires a non-null expected hash, `byte_equal=true`, and `error=null`; a supported rejection requires a non-null expected hash, `byte_equal=false`, and a stable rejection code. Hash equality is diagnostic only. Tasks 1.2 and 1.3 must perform the full normalized byte comparison before returning success.

Run the synthetic cross-implementation gate and the real ELF runtime evidence test with:

```bash
bun test test/contract/exact-replay-harness.test.mjs test/contract/exact-replay-elf.test.mjs test/contract/schema.test.mjs
```