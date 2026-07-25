import path from 'node:path'

const DYNAMIC_TIME_KEYS = new Set([
  'created_at',
  'discovered_at',
  'finished_at',
  'started_at',
  'timestamp',
  'updated_at',
])

function normalizeTempPath(value, tempRoots) {
  for (const root of tempRoots) {
    const relative = path.relative(root, value)
    if (relative === '') return '<temp>'
    if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      return `<temp>/${relative.split(path.sep).join('/')}`
    }
  }
  return value
}

function normalizeValue(value, key, options) {
  if (Array.isArray(value)) return value.map((item) => normalizeValue(item, null, options))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((childKey) => [childKey, normalizeValue(value[childKey], childKey, options)]),
    )
  }
  if (key === 'implementation' && typeof value === 'string') return '<implementation>'
  if (key === 'hostname' && typeof value === 'string') return '<hostname>'
  if (key === 'pid' && Number.isInteger(value)) return '<pid>'
  if (DYNAMIC_TIME_KEYS.has(key) && typeof value === 'string') return '<timestamp>'
  if (typeof value === 'string' && path.isAbsolute(value)) {
    return normalizeTempPath(value, options.tempRoots)
  }
  return value
}

export function normalizeOutput(value, { tempRoots = [] } = {}) {
  return normalizeValue(value, null, {
    tempRoots: tempRoots.map((root) => path.resolve(root)),
  })
}

export function parseAndNormalizeOutput(stdout, options) {
  const text = stdout.trim()
  if (!text) throw new Error('CLI stdout did not contain JSON')
  let value
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error(`CLI stdout must contain exactly one JSON document: ${error.message}`)
  }
  return normalizeOutput(value, options)
}