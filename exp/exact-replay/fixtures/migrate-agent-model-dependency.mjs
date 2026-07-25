import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const CLEAN_PATH = path.resolve(import.meta.dir, '../../../contract/golden/claude-v1/synthetic-2.1.175-clean.bin')
const CLEAN_SHA256 = '0a067e12954675a56d6a2aa25c4180c1746005d5cd9e438607d0fb913355ff61'
const SOURCE_SITE = {
  offset: 8,
  clean: Buffer.from('@bytecode', 'ascii'),
  patched: Buffer.from('@source__', 'ascii'),
}
const AGENT_SITE = {
  offset: 305,
  clean: Buffer.from('Q.enum(["sonnet","opus","haiku","fable"])', 'ascii'),
  patched: Buffer.from('Q.string()/* any model ................*/', 'ascii'),
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function applySite(bytes, site) {
  const actual = bytes.subarray(site.offset, site.offset + site.clean.length)
  if (!actual.equals(site.clean)) throw new Error(`clean site mismatch at offset ${site.offset}`)
  if (site.clean.length !== site.patched.length) throw new Error(`site length mismatch at offset ${site.offset}`)
  site.patched.copy(bytes, site.offset)
}

const clean = readFileSync(CLEAN_PATH)
if (sha256(clean) !== CLEAN_SHA256) throw new Error('immutable clean golden hash mismatch')

const targets = {
  'target-agent-model': [AGENT_SITE],
  'target-source-exec-agent-model': [SOURCE_SITE, AGENT_SITE],
}

for (const [name, sites] of Object.entries(targets)) {
  const bytes = Buffer.from(clean)
  for (const site of sites) applySite(bytes, site)
  const marker = bytes.subarray(SOURCE_SITE.offset, SOURCE_SITE.offset + SOURCE_SITE.clean.length)
  if (name === 'target-agent-model' && !marker.equals(SOURCE_SITE.clean)) {
    throw new Error('agent-model-only fixture must retain @bytecode')
  }
  if (!bytes.subarray(AGENT_SITE.offset, AGENT_SITE.offset + AGENT_SITE.patched.length).equals(AGENT_SITE.patched)) {
    throw new Error(`${name} does not contain the patched model site`)
  }
  const output = path.join(import.meta.dir, `synthetic-2.1.175-${name}.bin`)
  writeFileSync(output, bytes)
  process.stdout.write(`${name} ${bytes.length} ${sha256(bytes)}\n`)
}

if (sha256(readFileSync(CLEAN_PATH)) !== CLEAN_SHA256) throw new Error('immutable clean golden changed during migration')