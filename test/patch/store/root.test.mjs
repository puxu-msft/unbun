import { describe, expect, test } from 'bun:test'

import { resolveStoreRoot, storeV1Root } from '../../../lib/patch/store/root.mjs'

describe('store root', () => {
  test('honors an absolute POSIX override', () => {
    expect(resolveStoreRoot({ platform: 'linux', env: { UNBUN_CC_STORE: '/srv/unbun-store' } })).toBe('/srv/unbun-store')
    expect(storeV1Root('/srv/unbun-store', { platform: 'linux' })).toBe('/srv/unbun-store/v1')
  })

  test('honors drive-root and UNC Windows overrides', () => {
    expect(resolveStoreRoot({ platform: 'win32', env: { UNBUN_CC_STORE: 'D:\\unbun-store' } })).toBe('D:\\unbun-store')
    expect(resolveStoreRoot({ platform: 'win32', env: { UNBUN_CC_STORE: '\\\\server\\share\\unbun-store' } })).toBe('\\\\server\\share\\unbun-store')
  })

  test('rejects relative and unexpanded overrides', () => {
    for (const override of ['relative/store', '~/store', '$HOME/store', '/tmp/%USER%/store']) {
      expect(() => resolveStoreRoot({ platform: 'linux', env: { UNBUN_CC_STORE: override } })).toThrow(/UNBUN_CC_STORE/)
    }
    for (const override of ['relative\\store', '~\\store', '%LOCALAPPDATA%\\store', 'C:$TEMP\\store']) {
      expect(() => resolveStoreRoot({ platform: 'win32', env: { UNBUN_CC_STORE: override } })).toThrow(/UNBUN_CC_STORE/)
    }
  })

  test('uses platform defaults with the frozen precedence', () => {
    expect(resolveStoreRoot({ platform: 'linux', env: { XDG_DATA_HOME: '/xdg', HOME: '/home/alice' } })).toBe('/xdg/unbun/cc-patch')
    expect(resolveStoreRoot({ platform: 'linux', env: { HOME: '/home/alice' } })).toBe('/home/alice/.local/share/unbun/cc-patch')
    expect(resolveStoreRoot({ platform: 'darwin', env: { HOME: '/Users/alice' } })).toBe('/Users/alice/Library/Application Support/unbun/cc-patch')
    expect(resolveStoreRoot({ platform: 'darwin', env: { XDG_DATA_HOME: '/xdg', HOME: '/Users/alice' } })).toBe('/xdg/unbun/cc-patch')
    expect(resolveStoreRoot({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\Alice\\AppData\\Local' } })).toBe('C:\\Users\\Alice\\AppData\\Local\\unbun\\cc-patch')
  })

  test('fails when a required platform home is unavailable', () => {
    expect(() => resolveStoreRoot({ platform: 'linux', env: {} })).toThrow(/HOME/)
    expect(() => resolveStoreRoot({ platform: 'win32', env: {} })).toThrow(/LOCALAPPDATA/)
  })
})