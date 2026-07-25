import { readFileSync } from 'node:fs'

import Ajv2020 from 'ajv/dist/2020.js'

const ajv = new Ajv2020({ strict: true })
const schema = (name) => JSON.parse(readFileSync(new URL(`../../../contract/schemas/${name}.schema.json`, import.meta.url), 'utf8'))
ajv.addSchema(schema('error'))
const validators = Object.freeze({
  status: ajv.compile(schema('status')),
  envelope: ajv.compile(schema('write-envelope')),
})

const stableCodes = new Set(JSON.parse(
  readFileSync(new URL('../../../contract/vectors/error-codes-v1.json', import.meta.url), 'utf8'),
).errors.map((entry) => entry.code))

export function validateOutput(type, value) {
  const validate = validators[type]
  if (!validate) throw new TypeError(`unknown CLI output schema: ${type}`)
  if (!validate(value)) throw new Error(`invalid ${type} output: ${ajv.errorsText(validate.errors)}`)
  return value
}

export function structuredError(error, binary = null, feature = null) {
  const targetAccessFailure = ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error?.code)
  const code = stableCodes.has(error?.code) ? error.code : targetAccessFailure ? 'version_probe_failed' : 'content_mismatch'
  const exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : code === 'content_mismatch' ? 2 : 1
  return {
    exitCode,
    value: {
      schema_version: 1,
      code,
      message: error?.message || String(error),
      binary,
      feature,
      details: error?.details && typeof error.details === 'object' ? error.details : {},
    },
  }
}

export function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

export function writeEnvelope(action, results, errors) {
  const exitCode = errors.reduce((severity, error) => Math.max(severity, error.exitCode), 0)
  const envelope = validateOutput('envelope', {
    schema_version: 1,
    success: exitCode === 0,
    exit_code: exitCode,
    action,
    results,
    errors: errors.map((error) => error.value),
  })
  writeJson(envelope)
  process.exitCode = exitCode
  return envelope
}