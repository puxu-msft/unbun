import { readFile } from 'node:fs/promises'

const REGISTRY_ORDER = ['source-exec', 'agent-model', 'channels']
const REQUIRES = {
  'source-exec': [],
  'agent-model': [],
  channels: ['source-exec'],
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortValue(value[key])]),
    )
  }
  return value
}

function closeRequest(requestSet) {
  if (!Array.isArray(requestSet)) throw new TypeError('request_set must be an array')
  const selected = new Set()
  function add(feature) {
    if (!Object.hasOwn(REQUIRES, feature)) throw new Error(`unknown feature: ${feature}`)
    if (selected.has(feature)) return
    for (const dependency of REQUIRES[feature]) add(dependency)
    selected.add(feature)
  }
  for (const feature of requestSet) add(feature)
  return REGISTRY_ORDER.filter((feature) => selected.has(feature))
}

function requestSets(requests) {
  if (!Array.isArray(requests)) throw new TypeError('requests must be an array')
  return requests.map((requestSet) => ({
    request_set: requestSet,
    closed_set: closeRequest(requestSet),
  }))
}

function evaluateVector(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new TypeError('vector root must be an object')
  }
  const common = {
    feature_contract: 'claude-v1',
    implementation: 'js',
    runner_role: 'read-only-contract',
  }
  if (Array.isArray(document.requests) && Array.isArray(document.registry_order)) {
    return {
      ...common,
      kind: 'dependency-closure',
      request_sets: requestSets(document.requests),
    }
  }
  if (document.algorithm === 'claude-v1-exact-replay' && Array.isArray(document.targets)) {
    return {
      ...common,
      kind: 'lineage-targets',
      algorithm: document.algorithm,
      baseline: document.baseline ?? null,
      cases: document.cases ?? null,
      targets: requestSets(document.targets),
    }
  }
  return {
    ...common,
    kind: 'contract-vector',
    document,
  }
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8').trim()
}

try {
  const vectorPath = await readStdin()
  if (!vectorPath) throw new Error('stdin must contain a vector path')
  const document = JSON.parse(await readFile(vectorPath, 'utf8'))
  process.stdout.write(`${JSON.stringify(sortValue(evaluateVector(document)))}\n`)
} catch (error) {
  process.stderr.write(`js-vector-runner: ${error.message}\n`)
  process.exitCode = 1
}