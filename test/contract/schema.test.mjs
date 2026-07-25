import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");
const SCHEMA_DIR = path.join(ROOT, "contract", "schemas");
const VECTOR_DIR = path.join(ROOT, "contract", "vectors");

const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);
const CREATED_AT = "2026-07-23T12:34:56.000Z";

const validSamples = {
  status: {
    schema_version: 1,
    path: "/opt/claude/versions/2.1.217",
    version: "2.1.217",
    size_bytes: 268573680,
    has_baseline: true,
    probe_error: null,
    features: {
      "source-exec": {
        slug: "source-exec",
        state: "patched",
        details: [],
        sites: 5,
        substates: [
          { identity: "source-exec:tag:0", state: "patched", optional_future_field: true },
        ],
      },
    },
  },
  "write-envelope": {
    schema_version: 1,
    success: true,
    exit_code: 0,
    action: "patch",
    results: [
      {
        binary: "/opt/claude/versions/2.1.217",
        applied: ["source-exec", "agent-model"],
        edits: 6,
        resigned: false,
      },
    ],
    errors: [],
  },
  error: {
    schema_version: 1,
    code: "baseline_not_found",
    message: "No matching baseline",
    binary: "/opt/claude/versions/2.1.217",
    feature: "source-exec",
    details: {},
  },
  target: {
    schema: "unbun.cc.target",
    schema_version: 1,
    path_key: HASH,
    canonical_path: "/opt/claude/versions/2.1.217",
    display_name: "claude",
    created_at: CREATED_AT,
  },
  baseline: {
    schema: "unbun.cc.baseline",
    schema_version: 1,
    feature_contract: "claude-v1",
    path_key: HASH,
    embedded_version: "2.1.217",
    blob: `blobs/${OTHER_HASH}.ccbak`,
    sha256: OTHER_HASH,
    lineage_algorithm: "claude-v1-exact-replay",
    lineage_sha256: HASH,
    size: 268573680,
    states: {
      "source-exec": "clean",
      "agent-model": "clean",
      channels: "clean",
    },
    created_at: CREATED_AT,
    created_by: "js",
  },
  snapshot: {
    schema: "unbun.cc.snapshot",
    schema_version: 1,
    feature_contract: "claude-v1",
    path_key: HASH,
    embedded_version: "2.1.217",
    slug: "before-change",
    blob: `blobs/${OTHER_HASH}.ccsnap`,
    sha256: OTHER_HASH,
    size: 268573680,
    observed_states: {
      "source-exec": "patched",
      "agent-model": "patched",
      channels: "clean",
    },
    created_at: CREATED_AT,
    created_by: "python",
  },
  "lock-owner": {
    schema: "unbun.cc.lock-owner",
    schema_version: 1,
    token: "123e4567-e89b-42d3-a456-426614174000",
    implementation: "js",
    pid: 12345,
    hostname: "host-name",
    started_at: CREATED_AT,
    command: "patch",
  },
  "exact-replay-result": {
    implementation: "js",
    format: "synthetic-elf-like",
    supported: true,
    normalized_size: 1031,
    baseline_lineage_sha256: HASH,
    expected_sha256: OTHER_HASH,
    current_sha256: OTHER_HASH,
    byte_equal: true,
    error: null,
  },
  quarantine: {
    schema: "unbun.cc.quarantine",
    schema_version: 1,
    original_path: `baselines/2.1.217/blobs/${OTHER_HASH}.ccbak`,
    reason: "baseline_hash_mismatch",
    observed_sha256: OTHER_HASH,
    discovered_at: CREATED_AT,
    discovered_by: "python",
  },
  "transaction-scenario": {
    schema_version: 1,
    protocol: "shared-store-v1-section-9",
    scenarios: [
      {
        id: "apply-agent-model",
        entry_features: [],
        requested_features: ["agent-model"],
        expected_features: ["agent-model"],
        expected_edits: 1,
        expected_write: true,
      },
    ],
  },
};

const clone = (value) => structuredClone(value);

function without(sample, key) {
  const result = clone(sample);
  delete result[key];
  return result;
}

const invalidSamples = {
  status: [
    without(validSamples.status, "features"),
    { ...validSamples.status, size_bytes: "268573680" },
    { ...validSamples.status, schema_version: 2 },
    { ...validSamples.status, version: "2.1.beta" },
  ],
  "write-envelope": [
    without(validSamples["write-envelope"], "success"),
    { ...validSamples["write-envelope"], exit_code: "0" },
    { ...validSamples["write-envelope"], schema_version: 2 },
    { ...validSamples["write-envelope"], exit_code: 4 },
  ],
  error: [
    without(validSamples.error, "code"),
    { ...validSamples.error, message: 17 },
    { ...validSamples.error, schema_version: 2 },
    { ...validSamples.error, code: "not_a_contract_code" },
  ],
  target: [
    without(validSamples.target, "path_key"),
    { ...validSamples.target, created_at: 17 },
    { ...validSamples.target, schema_version: 2 },
    { ...validSamples.target, schema: "unbun.cc.unknown" },
    { ...validSamples.target, path_key: "ABC123" },
  ],
  baseline: [
    without(validSamples.baseline, "blob"),
    { ...validSamples.baseline, size: "268573680" },
    { ...validSamples.baseline, schema_version: 2 },
    { ...validSamples.baseline, schema: "unbun.cc.unknown" },
    { ...validSamples.baseline, embedded_version: "2.1-beta" },
    { ...validSamples.baseline, blob: `/tmp/${OTHER_HASH}.ccbak` },
    { ...validSamples.baseline, blob: `blobs/../${OTHER_HASH}.ccbak` },
  ],
  snapshot: [
    without(validSamples.snapshot, "slug"),
    { ...validSamples.snapshot, size: "268573680" },
    { ...validSamples.snapshot, schema_version: 2 },
    { ...validSamples.snapshot, schema: "unbun.cc.unknown" },
    { ...validSamples.snapshot, slug: "Before_Change" },
    { ...validSamples.snapshot, embedded_version: "v2.1.217" },
    { ...validSamples.snapshot, blob: `../blobs/${OTHER_HASH}.ccsnap` },
  ],
  "lock-owner": [
    without(validSamples["lock-owner"], "token"),
    { ...validSamples["lock-owner"], pid: "12345" },
    { ...validSamples["lock-owner"], schema_version: 2 },
    { ...validSamples["lock-owner"], schema: "unbun.cc.unknown" },
    { ...validSamples["lock-owner"], token: "not-a-uuid" },
  ],
  "exact-replay-result": [
    without(validSamples["exact-replay-result"], "current_sha256"),
    { ...validSamples["exact-replay-result"], implementation: "rust" },
    { ...validSamples["exact-replay-result"], normalized_size: "1031" },
    {
      ...validSamples["exact-replay-result"],
      supported: false,
      expected_sha256: null,
      byte_equal: true,
      error: "not_implemented",
    },
    {
      ...validSamples["exact-replay-result"],
      supported: false,
      expected_sha256: null,
      byte_equal: false,
      error: "baseline_stale_build",
    },
    {
      ...validSamples["exact-replay-result"],
      byte_equal: false,
      error: null,
    },
  ],
  quarantine: [
    without(validSamples.quarantine, "original_path"),
    { ...validSamples.quarantine, observed_sha256: 17 },
    { ...validSamples.quarantine, schema_version: 2 },
    { ...validSamples.quarantine, schema: "unbun.cc.unknown" },
    { ...validSamples.quarantine, original_path: "/tmp/artifact" },
    { ...validSamples.quarantine, original_path: "baselines/../artifact" },
  ],
  "transaction-scenario": [
    without(validSamples["transaction-scenario"], "protocol"),
    { ...validSamples["transaction-scenario"], schema_version: 2 },
    { ...validSamples["transaction-scenario"], protocol: "shared-store-v2" },
    { ...validSamples["transaction-scenario"], scenarios: [] },
  ],
};

async function loadJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

const schemaEntries = await Promise.all(
  Object.keys(validSamples).map(async (name) => [
    name,
    await loadJson(path.join(SCHEMA_DIR, `${name}.schema.json`)),
  ]),
);

const { default: Ajv2020 } = await import("ajv/dist/2020.js");
const { default: addFormats } = await import("ajv-formats");
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
for (const [, schema] of schemaEntries) {
  ajv.addSchema(schema);
}

const validators = Object.fromEntries(
  schemaEntries.map(([name, schema]) => [name, ajv.getSchema(schema.$id)]),
);

describe("contract JSON schemas", () => {
  for (const [name, sample] of Object.entries(validSamples)) {
    test(`${name} accepts its valid example and unknown optional fields`, () => {
      const validate = validators[name];
      expect(validate(sample), JSON.stringify(validate.errors)).toBe(true);
      expect(
        validate({ ...sample, future_observation: { supported: true } }),
        JSON.stringify(validate.errors),
      ).toBe(true);
    });

    test(`${name} rejects malformed and unsupported inputs`, () => {
      const validate = validators[name];
      expect(invalidSamples[name].length).toBeGreaterThanOrEqual(4);
      for (const invalid of invalidSamples[name]) {
        expect(validate(invalid), JSON.stringify({ invalid, errors: validate.errors })).toBe(false);
      }
    });
  }

  test("write-envelope validates nested structured errors", () => {
    const validate = validators["write-envelope"];
    const withValidError = {
      ...validSamples["write-envelope"],
      success: false,
      exit_code: 1,
      errors: [validSamples.error],
    };
    expect(validate(withValidError), JSON.stringify(validate.errors)).toBe(true);

    const withInvalidError = clone(withValidError);
    withInvalidError.errors[0].code = "not_a_contract_code";
    expect(validate(withInvalidError), JSON.stringify(validate.errors)).toBe(false);
  });

  test("status accepts an unavailable version when probing cannot extract it", () => {
    const validate = validators.status;
    const unavailable = {
      ...validSamples.status,
      version: null,
      probe_error: { code: "version_probe_failed" },
    };
    expect(validate(unavailable), JSON.stringify(validate.errors)).toBe(true);
  });

  test("lock-owner accepts an uppercase UUID v4 token", () => {
    const validate = validators["lock-owner"];
    const sample = {
      ...validSamples["lock-owner"],
      token: "123E4567-E89B-42D3-A456-426614174000",
    };
    expect(validate(sample), JSON.stringify(validate.errors)).toBe(true);
  });
});

describe("contract vectors", () => {
  test("error catalog exactly freezes the v1 code, exit, and meaning", async () => {
    const catalog = await loadJson(path.join(VECTOR_DIR, "error-codes-v1.json"));
    expect(catalog.schema_version).toBe(1);
    expect(catalog.errors).toHaveLength(19);
    expect(catalog.errors.map(({ code }) => code)).toEqual([
      "store_version_unsupported",
      "target_identity_mismatch",
      "target_locked",
      "baseline_not_found",
      "channels_patched_no_baseline",
      "unsupported_or_mixed_no_baseline",
      "version_probe_failed",
      "baseline_conflict",
      "baseline_invalid",
      "baseline_stale_build",
      "snapshot_exists",
      "snapshot_not_found",
      "snapshot_ambiguous",
      "snapshot_invalid",
      "concurrent_binary_change",
      "content_mismatch",
      "rollback_failed",
      "binary_in_use",
      "codesign_failed",
    ]);
    expect(catalog.errors.every(({ exit_code }) => [1, 2, 3].includes(exit_code))).toBe(true);
    expect(catalog.errors.every(({ meaning }) => typeof meaning === "string" && meaning.length > 0)).toBe(true);
  });

  test("canonical path vectors freeze POSIX and Windows edge cases", async () => {
    const vectors = await loadJson(path.join(VECTOR_DIR, "canonical-path-v1.json"));
    expect(vectors.schema_version).toBe(1);
    expect(vectors.algorithm).toBe("canonical-path-v1");

    const cases = new Map(vectors.cases.map((entry) => [entry.id, entry]));
    for (const id of [
      "posix-symlink",
      "posix-space",
      "posix-nfc",
      "windows-drive",
      "windows-unc",
      "windows-separator",
      "windows-u-umlaut",
      "windows-sharp-s",
      "windows-ascii-lowercase-only",
    ]) {
      expect(cases.has(id), `missing canonical path case ${id}`).toBe(true);
    }

    for (const entry of cases.values()) {
      expect(entry.canonical_path).toBe(entry.canonical_path.normalize("NFC"));
      expect(entry.path_key).toMatch(/^[0-9a-f]{64}$/);
      const digest = new Bun.CryptoHasher("sha256")
        .update(new TextEncoder().encode(entry.canonical_path))
        .digest("hex");
      expect(entry.path_key).toBe(digest);
    }

    expect(cases.get("windows-u-umlaut").canonical_path).toContain("Ü");
    expect(cases.get("windows-sharp-s").canonical_path).toContain("ß");
    expect(cases.get("windows-ascii-lowercase-only").canonical_path).toContain("Ü");
    expect(cases.get("windows-ascii-lowercase-only").canonical_path).not.toContain("ü");
  });

  test("transaction scenarios validate independently of either implementation", async () => {
    const vectors = await loadJson(path.join(VECTOR_DIR, "transaction-v1.json"));
    const validate = validators["transaction-scenario"];
    expect(validate(vectors), JSON.stringify(validate.errors)).toBe(true);
    expect(new Set(vectors.scenarios.map(({ id }) => id)).size).toBe(vectors.scenarios.length);
  });
});