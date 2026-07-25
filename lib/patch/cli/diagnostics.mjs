import { readFile } from 'node:fs/promises'

import { cleanupStaleLock, inspectTargetLock } from '../store/lock.mjs'
import { resolveStoreRoot } from '../store/root.mjs'
import { inspectClaudeBytes } from '../targets/claude/probe.mjs'
import { targetContext } from './context.mjs'
import { structuredError, writeEnvelope } from './output.mjs'

export function storeRoot() {
  return { schema_version: 1, root: resolveStoreRoot() }
}

export async function inspectLock(binaryPath) {
  const context = await targetContext(binaryPath)
  const state = await inspectTargetLock(context.targetDirectory)
  return {
    schema_version: 1,
    binary: context.binary,
    locked: state.locked,
    owner_known: state.ownerKnown,
    owner: state.owner,
  }
}

export async function cleanupLocks(options) {
  const results = []
  const errors = []
  for (const binary of options.binary) {
    try {
      const context = await targetContext(binary)
      await cleanupStaleLock(context.targetDirectory, { force: options.force })
      const inspection = inspectClaudeBytes(await readFile(context.binary))
      const applied = Object.entries(inspection.states)
        .filter(([, value]) => ['patched', 'mixed'].includes(value))
        .map(([name]) => name)
      results.push({ binary: context.binary, applied, edits: 0, resigned: false })
    } catch (error) {
      const structured = structuredError(error, binary)
      errors.push(structured)
      console.error(`${structured.value.code}: ${structured.value.message}`)
    }
  }
  return writeEnvelope('lock-cleanup', results, errors)
}