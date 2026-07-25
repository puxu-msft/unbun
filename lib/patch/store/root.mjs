import path from 'node:path'

const UNEXPANDED = /(^|[\\/])~(?:[\\/]|$)|\$[A-Za-z_{]|%[^%]+%/

function required(value, name) {
  if (!value) throw new Error(`${name} is required to resolve the store root`)
  return value
}

function validateOverride(value, platform) {
  if (UNEXPANDED.test(value)) throw new Error('UNBUN_CC_STORE must not contain unexpanded shell variables')
  const absolute = platform === 'win32' ? path.win32.isAbsolute(value) : path.posix.isAbsolute(value)
  if (!absolute) throw new Error('UNBUN_CC_STORE must be a platform-native absolute path')
  return value
}

export function resolveStoreRoot({ platform = process.platform, env = process.env } = {}) {
  if (env.UNBUN_CC_STORE) return validateOverride(env.UNBUN_CC_STORE, platform)

  if (platform === 'win32') {
    return path.win32.join(required(env.LOCALAPPDATA, 'LOCALAPPDATA'), 'unbun', 'cc-patch')
  }

  if (env.XDG_DATA_HOME) return path.posix.join(env.XDG_DATA_HOME, 'unbun', 'cc-patch')
  const home = required(env.HOME, 'HOME')
  if (platform === 'darwin') return path.posix.join(home, 'Library', 'Application Support', 'unbun', 'cc-patch')
  return path.posix.join(home, '.local', 'share', 'unbun', 'cc-patch')
}

export function storeV1Root(storeRoot, { platform = process.platform } = {}) {
  return (platform === 'win32' ? path.win32 : path.posix).join(storeRoot, 'v1')
}