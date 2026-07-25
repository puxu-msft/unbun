import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '../..')
const VECTOR_PATH = path.join(ROOT, 'contract', 'vectors', 'platform-writes-v1.json')
const REQUIRED_CAPABILITIES = [
  'format_exact_replay',
  'shared_store_transaction',
  'runtime_execution_oracle',
  'source_exec_dependency_evidence',
  'production_write_gate',
]
const REQUIRED_PLATFORMS = ['linux', 'windows', 'macos']

function loadVector() {
  return JSON.parse(readFileSync(VECTOR_PATH, 'utf8'))
}

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

function aggregateProductionGate(capabilities) {
  if (capabilities.production_write_gate.status !== 'enabled') return capabilities.production_write_gate.status
  const prerequisites = [
    capabilities.format_exact_replay.status === 'proven',
    capabilities.shared_store_transaction.status === 'proven',
    capabilities.runtime_execution_oracle.status === 'proven',
    capabilities.source_exec_dependency_evidence.status === 'resolved',
    capabilities.production_write_gate.implementation === 'implemented',
  ]
  return prerequisites.every(Boolean) ? 'enabled' : 'disabled-incomplete-evidence'
}

function fullyEnabledCapabilities() {
  return {
    format_exact_replay: { status: 'proven' },
    shared_store_transaction: { status: 'proven' },
    runtime_execution_oracle: { status: 'proven' },
    source_exec_dependency_evidence: { status: 'resolved' },
    production_write_gate: { status: 'enabled', implementation: 'implemented' },
  }
}

describe('platform write capability contract', () => {
  test('keeps evidence layers separate and forbids a summary writes boolean', () => {
    const vector = loadVector()
    expect(vector.schema).toBe('unbun.cc.platform-writes')
    expect(vector.schema_version).toBe(1)
    expect(vector.lineage_algorithm).toBe('claude-v1-exact-replay')
    expect(vector.frozen_at).toBe('2026-07-25')
    expect(Object.keys(vector.platforms).sort()).toEqual([...REQUIRED_PLATFORMS].sort())

    for (const platform of REQUIRED_PLATFORMS) {
      const record = vector.platforms[platform]
      expect(Object.keys(record.capabilities).sort(), platform).toEqual([...REQUIRED_CAPABILITIES].sort())
      expect(record).not.toHaveProperty('writes')
      expect(record.capabilities).not.toHaveProperty('writes')
      expect(aggregateProductionGate(record.capabilities), platform).toBe(record.capabilities.production_write_gate.status)
    }
    expect(vector.platforms.linux.capabilities.production_write_gate.status).toBe('enabled')
    expect(vector.platforms.windows.capabilities.production_write_gate.status).not.toBe('enabled')
    expect(vector.platforms.macos.capabilities.production_write_gate.status).not.toBe('enabled')
  })

  test('freezes Linux cross proof and the implemented production write path', () => {
    const linux = loadVector().platforms.linux.capabilities
    expect(linux.format_exact_replay).toMatchObject({
      status: 'proven',
      scope: 'synthetic-elf-like',
      implementations: ['js', 'python'],
      full_byte_cross_verification: true,
    })
    expect(linux.shared_store_transaction).toMatchObject({
      status: 'proven',
      production_implementation: 'implemented',
      implementations: ['js', 'python'],
    })
    expect(linux.runtime_execution_oracle).toMatchObject({
      status: 'proven',
      ordinary_bun_source_exec_necessity: 'not-proven',
      agent_model_claude_temporary_copy: 'proven',
    })
    expect(linux.source_exec_dependency_evidence).toMatchObject({
      status: 'resolved',
      agent_model_dependency: 'refuted',
      channels_dependency: 'contract-preserved-runtime-not-independently-proven',
    })
    expect(linux.production_write_gate).toEqual({
      status: 'enabled',
      implementation: 'implemented',
      scope: 'temporary-copy-and-clean-baseline-only',
    })
  })

  test('does not promote PE structure and replay evidence without a Windows runtime oracle', () => {
    const windows = loadVector().platforms.windows.capabilities
    expect(windows.format_exact_replay).toMatchObject({
      status: 'proven',
      scope: 'synthetic-pe32-plus',
      structure_gate: 'enabled',
      full_byte_cross_verification: true,
    })
    expect(windows.runtime_execution_oracle.status).toBe('not-verified')
    expect(windows.production_write_gate).toMatchObject({
      status: 'disabled-pending-runtime',
      implementation: 'implemented-unverified-platform',
    })

    const misleadingSummary = {
      ...windows,
      production_write_gate: { status: 'enabled', implementation: 'not-implemented' },
    }
    expect(aggregateProductionGate(misleadingSummary)).toBe('disabled-incomplete-evidence')
  })

  test('requires every production prerequisite independently', () => {
    expect(aggregateProductionGate(fullyEnabledCapabilities())).toBe('enabled')
    const incompleteCases = [
      ['format_exact_replay', 'status', 'partial'],
      ['shared_store_transaction', 'status', 'contract-only'],
      ['runtime_execution_oracle', 'status', 'not-verified'],
      ['source_exec_dependency_evidence', 'status', 'partial'],
      ['production_write_gate', 'implementation', 'not-implemented'],
    ]
    for (const [capability, field, value] of incompleteCases) {
      const capabilities = fullyEnabledCapabilities()
      capabilities[capability][field] = value
      expect(aggregateProductionGate(capabilities), capability).toBe('disabled-incomplete-evidence')
    }
  })

  test('keeps macOS disabled until real codesign equivalence is proven', () => {
    const macos = loadVector().platforms.macos.capabilities
    expect(macos.format_exact_replay).toMatchObject({
      status: 'partial',
      parser: 'proven',
      synthetic_signature_normalization: 'proven',
      real_codesign_equivalence: 'not-proven',
    })
    expect(macos.production_write_gate).toMatchObject({
      status: 'disabled-not-proven',
      implementation: 'implemented-unverified-platform',
      reason: 'real-codesign-equivalence-not-proven',
    })
  })

  test('pins live 2.1.217 as read-only with no usable baseline', () => {
    const guard = loadVector().live_target_guard
    expect(guard).toEqual({
      version: '2.1.217',
      access: 'read-only',
      observed_features: {
        'source-exec': 'patched',
        'agent-model': 'patched',
        channels: 'patched',
      },
      clean_baseline: 'absent',
      baseline_creation: 'forbidden-from-patched-target',
      production_write_gate: 'disabled-no-baseline',
    })

    const livePath = path.join(os.homedir(), '.local', 'share', 'claude', 'versions', guard.version)
    if (!existsSync(livePath)) return
    const before = sha256(livePath)
    const pathKey = createHash('sha256').update(path.resolve(livePath)).digest('hex').slice(0, 12)
    const legacyBaseline = path.join(
      os.homedir(),
      '.claude',
      'scripts',
      'cc-patch',
      'backups',
      `${pathKey}__${path.basename(livePath)}__${guard.version}.ccbak`,
    )
    expect(existsSync(legacyBaseline)).toBe(false)
    expect(sha256(livePath)).toBe(before)
  })
})