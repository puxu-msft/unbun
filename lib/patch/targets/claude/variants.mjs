export const CLEAN = 'clean'
export const PATCHED = 'patched'
export const MIXED = 'mixed'
export const UNSUPPORTED = 'unsupported'

export function findAll(bytes, pattern) {
  const sites = []
  for (let offset = 0; (offset = bytes.indexOf(pattern, offset)) !== -1; offset++) sites.push(offset)
  return sites
}

export function stateOf(states) {
  if (states.length === 0) return UNSUPPORTED
  if (states.every((state) => state === CLEAN)) return CLEAN
  if (states.every((state) => state === PATCHED)) return PATCHED
  return MIXED
}

export function writable(bytes, options = {}) {
  if (!Buffer.isBuffer(bytes)) throw new TypeError('feature input must be a Buffer')
  return options.mutate === true ? bytes : Buffer.from(bytes)
}

export function substateError(message) {
  const error = new Error(`substate_unreplayable: ${message}`)
  error.code = 'substate_unreplayable'
  return error
}

export function validateReplay(currentSites, desiredSites) {
  if (!Array.isArray(desiredSites) || desiredSites.length !== currentSites.length) {
    throw substateError('site collection is incomplete')
  }
  for (let index = 0; index < currentSites.length; index++) {
    const current = currentSites[index]
    const desired = desiredSites[index]
    if (!desired || desired.id !== current.id || desired.offset !== current.offset || desired.length !== current.length) {
      throw substateError(`site identity mismatch at index ${index}`)
    }
    if (desired.state !== CLEAN && desired.state !== PATCHED) {
      throw substateError(`unknown state for ${desired.id}`)
    }
  }
}

export function ordinalId(kind, index, total) {
  return total === 1 ? kind : `${kind}:${index}`
}

export function normalizeWindows(windows) {
  if (!Array.isArray(windows)) throw new TypeError('windows must be an array')
  return windows.map((window) => {
    if (!window || !Number.isSafeInteger(window.offset) || window.offset < 0 || !Buffer.isBuffer(window.bytes)) {
      throw new TypeError('window must contain a non-negative safe-integer offset and Buffer bytes')
    }
    return window
  })
}