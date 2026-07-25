import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

const SCHEMAS = Object.freeze({
  target: 'target.schema.json',
  baseline: 'baseline.schema.json',
  snapshot: 'snapshot.schema.json',
  'lock-owner': 'lock-owner.schema.json',
  quarantine: 'quarantine.schema.json',
})

const INVALID_CODES = Object.freeze({
  target: 'target_identity_mismatch',
  baseline: 'baseline_invalid',
  snapshot: 'snapshot_invalid',
  'lock-owner': 'target_locked',
  quarantine: 'baseline_invalid',
})

const ajv = new Ajv2020({ allErrors: true, strict: true })
addFormats(ajv)
const validators = new Map(Object.entries(SCHEMAS).map(([type, file]) => {
  const schema = JSON.parse(readFileSync(new URL(`../../../contract/schemas/${file}`, import.meta.url), 'utf8'))
  return [type, ajv.compile(schema)]
}))
const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

export class StoreError extends Error {
  constructor(code, message, exitCode = 2, details = {}) {
    super(`${code}: ${message}`)
    this.name = 'StoreError'
    this.code = code
    this.exitCode = exitCode
    this.details = details
  }
}

function invalid(type, message, details) {
  throw new StoreError(INVALID_CODES[type] ?? 'baseline_invalid', message, 2, details)
}

export function validateManifest(type, value) {
  const validate = validators.get(type)
  if (!validate) throw new TypeError(`unknown manifest type: ${type}`)
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(type, 'manifest root must be an object')
  if (Number.isInteger(value.schema_version) && value.schema_version > 1) {
    throw new StoreError('store_version_unsupported', `unsupported schema version ${value.schema_version}`, 1)
  }
  if (!validate(value)) invalid(type, 'manifest failed schema validation', { errors: structuredClone(validate.errors) })
  return value
}

export function parseManifest(text, type) {
  if (Buffer.isBuffer(text) || text instanceof Uint8Array) {
    if (text.length >= 3 && text[0] === 0xef && text[1] === 0xbb && text[2] === 0xbf) invalid(type, 'UTF-8 BOM is not allowed')
    try {
      text = utf8Decoder.decode(text)
    } catch (error) {
      invalid(type, 'manifest is not valid UTF-8', { cause: error.message })
    }
  }
  if (typeof text !== 'string') throw new TypeError('manifest input must be a string or byte array')
  if (text.charCodeAt(0) === 0xfeff) invalid(type, 'UTF-8 BOM is not allowed')
  let value
  try {
    value = JSON.parse(text)
  } catch (error) {
    invalid(type, 'manifest is not valid JSON', { cause: error.message })
  }
  return validateManifest(type, value)
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function statesEqual(left, right) {
  return ['source-exec', 'agent-model', 'channels'].every((name) => left?.[name] === right?.[name])
}

export async function validateAssetManifest(type, manifest, bytes, {
  directoryVersion,
  pathKey,
  inspect,
  computeLineageSha256,
} = {}) {
  validateManifest(type, manifest)
  if (type !== 'baseline' && type !== 'snapshot') throw new TypeError(`unsupported asset manifest type: ${type}`)
  const code = type === 'baseline' ? 'baseline_invalid' : 'snapshot_invalid'
  const fail = (message) => { throw new StoreError(code, message, 2) }
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) fail('asset bytes are required')
  if (pathKey !== undefined && manifest.path_key !== pathKey) fail('manifest path key does not match target directory')
  if (directoryVersion !== undefined && manifest.embedded_version !== directoryVersion) fail('manifest version does not match directory')
  if (bytes.length !== manifest.size) fail('asset size does not match manifest')
  if (sha256(bytes) !== manifest.sha256) fail('asset hash does not match manifest')
  if (typeof inspect !== 'function') fail('asset inspector is required')
  const observed = await inspect(bytes, manifest)
  if (observed?.embeddedVersion !== manifest.embedded_version) fail('asset embedded version does not match manifest')
  if (type === 'baseline') {
    if (!statesEqual(manifest.states, { 'source-exec': 'clean', 'agent-model': 'clean', channels: 'clean' })) fail('baseline manifest states are not clean')
    if (!statesEqual(observed?.states, manifest.states)) fail('baseline observed states do not match manifest')
    if (typeof computeLineageSha256 !== 'function') fail('baseline lineage adapter is required')
    if (await computeLineageSha256(bytes, manifest) !== manifest.lineage_sha256) fail('baseline lineage hash does not match manifest')
  }
  return manifest
}