import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const ORIGINAL_OUTPUT = 'unbun-bytecode-oracle value=42'
const EDITED_OUTPUT = 'unbun-bytecode-oracle value=48'
const EXPECTED_RUNTIME_GATE = 'not-proven'
const BYTECODE_MARKER = Buffer.from('@bytecode')
const SOURCE_MARKER = Buffer.from('@source__')
const CLEAN_EXPRESSION = Buffer.from('6 * 7')
const EDITED_EXPRESSION = Buffer.from('6 * 8')
const created = []

afterEach(() => {
  for (const target of created.splice(0)) rmSync(target, { recursive: true, force: true })
})

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function run(binaryPath) {
  return execFileSync(binaryPath, { encoding: 'utf8' }).trim()
}

function replaceAll(bytes, from, to) {
  if (from.length !== to.length) throw new Error('runtime oracle replacements must be equal length')
  let count = 0
  for (let offset = 0; (offset = bytes.indexOf(from, offset)) !== -1; offset += from.length) {
    to.copy(bytes, offset)
    count += 1
  }
  return count
}

function editCopy(binaryPath, { sourceMode }) {
  const bytes = readFileSync(binaryPath)
  const expressionCount = replaceAll(bytes, CLEAN_EXPRESSION, EDITED_EXPRESSION)
  const markerCount = sourceMode ? replaceAll(bytes, BYTECODE_MARKER, SOURCE_MARKER) : 0
  writeFileSync(binaryPath, bytes)
  return {
    expressionCount,
    markerCount,
    remainingBytecodeMarkers: bytes.toString('latin1').match(/@bytecode/g)?.length ?? 0,
  }
}

function buildRuntimeOracle() {
  const root = mkdtempSync(path.join(tmpdir(), 'unbun-exact-replay-elf-'))
  created.push(root)
  const sourcePath = path.join(root, 'entry.js')
  const originalPath = path.join(root, 'original')
  const bytecodeCopyPath = path.join(root, 'edited-bytecode')
  const sourceCopyPath = path.join(root, 'edited-source')
  writeFileSync(sourcePath, [
    'const value = 6 * 7',
    "console.log('unbun-bytecode-oracle value=' + value)",
    '',
  ].join('\n'))
  execFileSync('bun', ['build', '--compile', '--bytecode', '--outfile', originalPath, sourcePath], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  for (const copyPath of [bytecodeCopyPath, sourceCopyPath]) {
    copyFileSync(originalPath, copyPath)
    chmodSync(copyPath, 0o755)
  }
  const originalBefore = sha256(readFileSync(originalPath))
  const bytecodeFacts = editCopy(bytecodeCopyPath, { sourceMode: false })
  const sourceFacts = editCopy(sourceCopyPath, { sourceMode: true })
  const outputs = {
    original: run(originalPath),
    editedBytecode: run(bytecodeCopyPath),
    editedSource: run(sourceCopyPath),
  }
  const runtimeGate = outputs.original === ORIGINAL_OUTPUT
    && outputs.editedBytecode === ORIGINAL_OUTPUT
    && outputs.editedSource === EDITED_OUTPUT
    ? 'proven'
    : 'not-proven'
  return {
    runtimeGate,
    outputs,
    bytecodeFacts,
    sourceFacts,
    originalBefore,
    originalAfter: sha256(readFileSync(originalPath)),
  }
}

describe('ELF Bun SFX source-exec runtime oracle', () => {
  test('records the real runtime counterexample as not-proven and keeps the original fixture immutable', () => {
    const evidence = buildRuntimeOracle()

    expect(evidence.originalAfter).toBe(evidence.originalBefore)
    expect(evidence.outputs.original).toBe(ORIGINAL_OUTPUT)
    expect(evidence.bytecodeFacts.expressionCount).toBeGreaterThan(0)
    expect(evidence.bytecodeFacts.remainingBytecodeMarkers).toBeGreaterThan(0)
    expect(evidence.sourceFacts.expressionCount).toBe(evidence.bytecodeFacts.expressionCount)
    expect(evidence.sourceFacts.markerCount).toBe(evidence.bytecodeFacts.remainingBytecodeMarkers)
    expect(evidence.sourceFacts.remainingBytecodeMarkers).toBe(0)

    expect(evidence.runtimeGate).toBe(EXPECTED_RUNTIME_GATE)
    expect(evidence.outputs.editedBytecode).toBe(EDITED_OUTPUT)
    expect(evidence.outputs.editedSource).toBe(EDITED_OUTPUT)
  })
})