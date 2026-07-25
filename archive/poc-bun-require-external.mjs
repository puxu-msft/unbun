#!/usr/bin/env node
// ARCHIVED — PoC/实验 provenance，勿运行。见 tools/unbun/
// poc-bun-require-external.mjs — 基石 PoC。
//
// 问:Bun 单文件编译产物(`bun build --compile`),能否在运行时从磁盘 require 一份
//     它自身没有嵌入的外部 js?
// 答:能。本脚本编译一个最小 standalone,入口仅 `require(process.env.EXT_BUNDLE)`,
//     然后分三种情形验证:不设环境变量(对照)/ 设了(加载外部)/ 把二进制移走再跑
//     (证明是真·运行时从绝对路径 resolve,不是 cwd 相对的嵌入)。
//
// 前置:`bun` 在 PATH。产物落在临时目录,跑完即弃。

import { mkdtempSync, writeFileSync, copyFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'bun-ext-poc-'))
const log = (...a) => console.log(...a)

try {
  // 外部 bundle —— 活在磁盘上,绝不会被编进二进制。
  const external = join(dir, 'external.cjs')
  writeFileSync(
    external,
    [
      'module.exports = "LOADED-FROM-DISK-AT-RUNTIME";',
      'console.error("[external] hi, pid=" + process.pid);',
      '',
    ].join('\n'),
  )

  // 入口 —— 编译进二进制,运行时去 require 一个外部路径。
  const entry = join(dir, 'entry.js')
  writeFileSync(
    entry,
    [
      'const p = process.env.EXT_BUNDLE;',
      'if (p) { const v = require(p); console.log("entry got:", v); }',
      'else { console.log("entry: no EXT_BUNDLE set"); }',
      '',
    ].join('\n'),
  )

  const bin = join(dir, 'testbin')
  log('=== compile standalone ===')
  execFileSync('bun', ['build', '--compile', entry, '--outfile', bin], { stdio: 'inherit' })

  log('\n=== run WITHOUT external (control) ===')
  log(execFileSync(bin, [], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim())

  log('\n=== run WITH external on disk ===')
  log(
    execFileSync(bin, [], {
      encoding: 'utf8',
      env: { ...process.env, EXT_BUNDLE: external },
      stdio: ['ignore', 'pipe', 'inherit'],
    }).trim(),
  )

  log('\n=== move binary away from external, run again ===')
  const moved = join(dir, 'testbin-moved')
  copyFileSync(bin, moved)
  log(
    execFileSync(moved, [], {
      encoding: 'utf8',
      env: { ...process.env, EXT_BUNDLE: external },
      stdio: ['ignore', 'pipe', 'inherit'],
    }).trim(),
  )

  log('\n✓ Bun standalone resolves & runs external JS from an absolute path at runtime.')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
