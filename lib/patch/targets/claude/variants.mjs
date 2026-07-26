export const CLEAN = 'clean'
export const PATCHED = 'patched'
export const MIXED = 'mixed'
export const UNSUPPORTED = 'unsupported'
// optional 站点在某些 build 中整体不存在时的占位状态（见 validateReplay 的 allowAbsent）。
export const ABSENT = 'absent'

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

// `allowAbsent`：channels 的 optional 站点（permissions / cap-strip）可以在某些 build 中不存在，
// `observe_substates` 为它们产出 `state:'absent'` 的占位记录以保持站点集合形状稳定。replay 必须能
// 原样收下自己 observe 出来的东西（自反性），因此这些占位是合法的 desired 值——它们不参与写入。
export function validateReplay(currentSites, desiredSites, { allowAbsent = false } = {}) {
  if (!Array.isArray(desiredSites) || desiredSites.length !== currentSites.length) {
    throw substateError('site collection is incomplete')
  }
  for (let index = 0; index < currentSites.length; index++) {
    const current = currentSites[index]
    const desired = desiredSites[index]
    if (!desired || desired.id !== current.id || desired.offset !== current.offset || desired.length !== current.length) {
      throw substateError(`site identity mismatch at index ${index}`)
    }
    if (allowAbsent && desired.state === ABSENT) {
      // absent 占位只在 current 也是 absent 时合法，否则就是把真实站点谎报成缺失。
      if (current.state !== ABSENT) throw substateError(`site ${desired.id} is present but was observed as absent`)
      continue
    }
    if (desired.state !== CLEAN && desired.state !== PATCHED) {
      throw substateError(`unknown state for ${desired.id}`)
    }
  }
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