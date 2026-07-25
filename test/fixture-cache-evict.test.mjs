// test/fixture-cache-evict.test.mjs — 证明 fixture 缓存的淘汰策略（A9）：清陈旧键、保新鲜/在用键、
// 淘汰失败不致命。缓存本身内容寻址、只增不删会让 `$TMPDIR/unbun-test-fixtures/` 无界增长（每变体
// ~94MB SFX，改 build-fixture.mjs / 升 Bun / 换变体参数即换键、旧键滞留）。evictStale「用完顺手清」：
// 每次命中/构建后扫缓存根，删掉 mtime 超龄（默认 7 天未访问）的键目录。
//
// 并发安全红线（本套件核心判据）：多 peer/进程可能同时命中/构建同一或不同键——淘汰**绝不能删掉别的
// 进程正在用的键**。三重保障，逐条测：① keepKey（本次命中/构建的键）显式排除，纵使超龄也不删；
// ② 只淘汰 mtime 超阈值的「明显陈旧」键，活跃使用的键每次命中被 touch（mtime 刷新）→ 永远新鲜、不被逐出，
// 别的进程刚建/刚 touch 的键其 mtime 也新、同样豁免；③ 淘汰尽力而为：单键删除失败（被占用/权限/竞态中
// 被 rename 走）吞错继续，绝不因淘汰失败让测试红。
//
// 判据非空性：每条断言都对得起「revert 实现即红」——若去掉超龄判断，新键/keepKey 会被误删（RED）；
// 若不吞删除错，undeletable 键会让 evictStale 抛（RED）。用独立临时 root（非共享真缓存）避免污染 peers。
import { test, expect, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evictStale, cachedMiniFixture } from './fixtures/build-fixture.mjs'

const DAY_MS = 24 * 60 * 60 * 1000

// 造一个假的键目录（含一个内嵌文件，模拟真 SFX 目录），mtime 设成 `ageDays` 天前（0=现在）。
function makeKeyDir(root, name, ageDays) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'mini'), 'fake sfx payload')
  const t = new Date(Date.now() - ageDays * DAY_MS)
  utimesSync(dir, t, t)
  return dir
}

const cleanups = []
afterEach(() => {
  while (cleanups.length) {
    const fn = cleanups.pop()
    try { fn() } catch {}
  }
})

function isolatedRoot() {
  const root = mkdtempSync(join(tmpdir(), 'unbun-evict-test-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  return root
}

test('evictStale 删掉超龄（30 天前）键、保留新鲜（今天）键', () => {
  const root = isolatedRoot()
  const stale = makeKeyDir(root, 'mini-deadbeefdeadbeef', 30)
  const fresh = makeKeyDir(root, 'mini-cafecafecafecafe', 0)

  evictStale('mini-newlybuiltnewlybu', { root, maxAgeMs: 7 * DAY_MS })

  expect(existsSync(stale)).toBe(false) // 超龄陈旧键被回收
  expect(existsSync(fresh)).toBe(true)  // 新鲜键（mtime 今天）保留
})

test('evictStale 绝不删 keepKey（本次在用键），即便它超龄', () => {
  const root = isolatedRoot()
  // keepKey 目录 mtime 故意设成很久以前（模拟时钟异常 / 刚 rename 但 mtime 被继承成旧）——仍不该被删。
  const inUse = makeKeyDir(root, 'rt-src-0011223344556677', 90)

  evictStale('rt-src-0011223344556677', { root, maxAgeMs: 7 * DAY_MS })

  expect(existsSync(inUse)).toBe(true) // keepKey 显式豁免、绝不淘汰
})

test('evictStale 不碰临时构建目录（.build-XXXX），即便超龄', () => {
  const root = isolatedRoot()
  const buildTmp = makeKeyDir(root, '.build-inprogress', 30) // 别的进程正在建的临时目录

  evictStale('mini-newlybuiltnewlybu', { root, maxAgeMs: 7 * DAY_MS })

  expect(existsSync(buildTmp)).toBe(true) // `.` 前缀项（在建临时目录）绝不碰
})

// 注：chmod 0o500 令目录不可写来模拟「删不掉」；root 会绕过目录写权限检查 → rmSync 照样成功、断言翻转
// （false-RED）。故 root 下（如 Docker CI）跳过——本例只为证「删失败吞错」，非核心并发语义。
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
test.skipIf(isRoot)('evictStale 淘汰失败（不可删的超龄键）吞错继续、不抛，且照删其余陈旧键', () => {
  const root = isolatedRoot()
  const undeletable = makeKeyDir(root, 'mini-ffffffffffffffff', 30)
  const alsoStale = makeKeyDir(root, 'mini-eeeeeeeeeeeeeeee', 30)
  // 令 undeletable 无法删除：去掉目录写权限 → rmSync 无法 unlink 其内文件 → EACCES 抛（force 只吞 ENOENT）。
  chmodSync(undeletable, 0o500)
  cleanups.push(() => { try { chmodSync(undeletable, 0o700) } catch {} }) // afterEach 前恢复以便 root 清理

  // 不抛（淘汰非关键、尽力而为）。
  expect(() => evictStale('mini-newlybuiltnewlybu', { root, maxAgeMs: 7 * DAY_MS })).not.toThrow()
  // 吞掉不可删键的错后，仍继续淘汰其余陈旧键。
  expect(existsSync(alsoStale)).toBe(false)
  // 不可删键内容仍在（删除被权限挡下、被吞错）——证明确实「删失败」而非「跳过」。
  expect(existsSync(join(undeletable, 'mini'))).toBe(true)
})

test('evictStale 缓存根不存在时安全返回、不抛', () => {
  const root = join(tmpdir(), 'unbun-evict-nonexistent-' + Math.random().toString(36).slice(2))
  expect(() => evictStale('any-key', { root, maxAgeMs: 7 * DAY_MS })).not.toThrow()
})

// 最重要的回归护栏：真缓存流程（命中/构建后内部触发 evictStale）绝不误删本次在用的 fixture 键。
// 默认 7 天阈值下，本 test-run 刚建/刚命中的键 mtime 是「现在」→ 不超龄、且被 keepKey 豁免 → 必然存活。
test('真缓存流程：命中/构建后内部淘汰不误删当前在用键', () => {
  const p1 = cachedMiniFixture().miniPath // 触发构建（或命中）+ 内部 evictStale
  expect(existsSync(p1)).toBe(true)
  const p2 = cachedMiniFixture().miniPath // 再次命中 + 内部 evictStale（含 touch 刷新 mtime）
  expect(p2).toBe(p1)
  expect(existsSync(p2)).toBe(true) // 当前键始终存活、未被自身淘汰误删
})
