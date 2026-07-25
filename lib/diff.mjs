// lib/diff.mjs — 两个 split index.json 之间的**结构 diff**，归一 minifier 改名噪音。
//
// 背景：`unbun split` 为一个二进制产出 modules/index.json（{version,helpers,count,modules:[{seq,handle,
// kind,bytes,start,end,file}]}）。跨版本对比时，同一模块的 minified handle 名会变（如 esm 的 205=`b` vs
// 201=`E`）——若只按 handle 判定，会因改名把「其实没变的模块」误报成「全变了」。diff 的核心价值就是
// **归一这种改名噪音**：改名（handle 变、内容同）归 renamed，不算 changed。
//
// 身份/配对策略（两趟，借鉴 git rename detection：先精确路径匹配、再对残余做相似度匹配）：
//   Pass 1 — 按 handle 精确配对（handle 未改名时是稳定身份）：
//     · 两边 handle 同 → 再比**内容指纹**：全同 → unchanged；有别 → changed（handle 未变、内容变）。
//   Pass 2 — 对 Pass 1 的残余（只在一边出现的 handle）按内容指纹配对，捕获改名：
//     · 残余 A 与残余 B 指纹同 → renamed（记 oldHandle→newHandle）；仍无配 → removed / added。
//
// 内容指纹（E5 = A6）：**优先用 split 写进 index 的每模块内容哈希 `hash`（sha256 前 16 hex）做精确身份**。
// 两侧 index 的所有模块都带 hash 时用 hash：exact content identity，彻底消除「两个不同模块恰好同
// (kind,bytes) → 被误配成 renamed」的假阳性（这正是旧 (kind,bytes) 近似身份的固有缺陷）。
// **向后兼容**：E5 之前产的老 index.json 无 hash 字段——只要有**任一侧**缺 hash 就整体回落到旧的
// (kind,bytes) 近似指纹（保留原逻辑，绝不对老产物崩）。回落是全局二选一（不逐模块混用 hash / kind:bytes，
// 否则两种键永不相等、误判全变）。
// **固有局限（诚实标注）**：hash 买到的是「精确 rename 检测 + 消除误配」，**不是**「解决 rename+改内容」。
// 一个模块同时改名又改内容时，hash 变了、handle 也变了 → 两个身份信号都变、无从关联，仍退化成
// removed+added。这是 metadata-only diff 的固有边界，hash 也解不了；但 hash 消除了「不同模块被误配成
// renamed」的假阳性，是 (kind,bytes) 之上的真进步。
// handle 在真 bundle 里可重复（多模块同名 `b`），故 Pass 1 用 multiset 桶配对，桶内优先配同指纹
// （unchanged）再配残余（changed），把误报的 changed 压到最小。
//
// 纯数据、纯函数，不碰二进制、不写盘（写盘在 cli.runDiff）。

// 判定一侧模块数组是否全带内容哈希（E5+ 产物）。空数组视作「无 hash」（无从判定、回落 (kind,bytes)）。
function allHaveHash(mods) {
  return mods.length > 0 && mods.every((m) => typeof m.hash === 'string' && m.hash.length > 0)
}

// 造内容指纹函数：两侧都带 hash → 用 hash（精确身份）；否则回落 (kind,bytes)（近似身份，向后兼容）。
// 全局二选一，两侧用同一个 fp，保证键可比。
function makeFingerprint(modsA, modsB) {
  const useHash = allHaveHash(modsA) && allHaveHash(modsB)
  return useHash ? (m) => `h:${m.hash}` : (m) => `${m.kind}:${m.bytes}`
}

// 把模块数组按 key(m) 分桶成 Map<key, Array<mod>>（保序，供 multiset 配对）。
function bucketize(mods, key) {
  const map = new Map()
  for (const m of mods) {
    const k = key(m)
    let arr = map.get(k)
    if (!arr) map.set(k, (arr = []))
    arr.push(m)
  }
  return map
}

// diffModuleSets(indexA, indexB) → { added, removed, changed, renamed, unchanged }
//   added    : 只在 B 的模块对象数组
//   removed  : 只在 A 的模块对象数组
//   changed  : [{ handle, a, b }]（handle 未变，内容指纹变；a/b 为两版模块对象）
//   renamed  : [{ oldHandle, newHandle, a, b }]（改名归一，内容指纹同、handle 变）
//   unchanged: number（handle + 内容指纹全同的模块数）
export function diffModuleSets(indexA, indexB) {
  const modsA = indexA?.modules ?? []
  const modsB = indexB?.modules ?? []

  // 内容指纹：两侧都有 hash 用 hash（精确）；否则回落 (kind,bytes)（近似，向后兼容老 index）。
  const fp = makeFingerprint(modsA, modsB)

  const changed = []
  let unchanged = 0
  const leftoverA = []
  const leftoverB = []

  // ── Pass 1：按 handle 精确配对（multiset 桶）───────────────────────────────────
  const bucketA = bucketize(modsA, (m) => m.handle)
  const bucketB = bucketize(modsB, (m) => m.handle)
  const handles = new Set([...bucketA.keys(), ...bucketB.keys()])
  for (const h of handles) {
    const as = [...(bucketA.get(h) ?? [])]
    const bs = [...(bucketB.get(h) ?? [])]

    // 桶内先配同内容指纹（hash 或回落 (kind,bytes)）→ unchanged（把误报的 changed 压到最小）。
    const bByFp = bucketize(bs, fp)
    const restA = []
    for (const a of as) {
      const q = bByFp.get(fp(a))
      if (q && q.length) {
        q.shift() // 从 B 桶取走一个同指纹项 → unchanged
        unchanged++
      } else {
        restA.push(a)
      }
    }
    // B 桶里没被 unchanged 取走的残余（仍带 handle h）。
    const restB = []
    for (const arr of bByFp.values()) for (const b of arr) restB.push(b)

    // 桶内 handle 相同、指纹不同的残余 → 逐对 changed（handle 未变、内容变）。
    const paired = Math.min(restA.length, restB.length)
    for (let i = 0; i < paired; i++) {
      changed.push({ handle: h, a: restA[i], b: restB[i] })
    }
    // 桶内多出来的（handle 只够一边）→ 丢进跨 handle 残余池，交 Pass 2 做改名检测。
    for (let i = paired; i < restA.length; i++) leftoverA.push(restA[i])
    for (let i = paired; i < restB.length; i++) leftoverB.push(restB[i])
  }

  // ── Pass 2：对残余按内容指纹（hash 或回落 (kind,bytes)）配对 → renamed；仍无配 → removed / added ──────
  const renamed = []
  const removed = []
  const added = []
  const leftBByFp = bucketize(leftoverB, fp)
  for (const a of leftoverA) {
    const q = leftBByFp.get(fp(a))
    if (q && q.length) {
      const b = q.shift()
      renamed.push({ oldHandle: a.handle, newHandle: b.handle, a, b })
    } else {
      removed.push(a)
    }
  }
  // B 残余里没被改名配走的 → added。
  for (const arr of leftBByFp.values()) for (const b of arr) added.push(b)

  return { added, removed, changed, renamed, unchanged }
}
