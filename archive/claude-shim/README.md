> **ARCHIVED** — PoC/实验 provenance，勿运行。能力已迁入 `tools/unbun/`（`lib/` + `cli.mjs`）。见 [`../../docs/spec.md`](../../docs/spec.md)。

# claude-shim — 极简入口 + 从抽取的外置资源运行 claude

在学习研究时，我们已经从 `claude` binary \(229MB\) 提取了 app.js + .node ELF 的外置资源。本实验尝试构造一个极简 shim 入口，它找到方式从外置资源加载运行，就像原先的 `claude` 一样。

详见上级 [FINDINGS.md](../FINDINGS.md)(提取 / 注入 / thin-loader / 标准 bun 复刻 / 体积构成 / 字节码不保护源码)。

## 方法一 thin-loader

仍然从 bun compile 得到自包含二进制，但主动从外部加载资源。

产物布局：

```
bin/
  claude-shim              # 编译好的入口 ≈94.6MB = bun 引擎 + entry.js
  claude-resources/
    loader.js              # 实际加载脚本，资源重定向的逻辑都在这里。独立出来是为了使改资源无需重编 shim
    app.js                 # ≈17MB ← extract-bundle.mjs
    audio-capture.node     # ≈0.5MB ← dump-embedded-resources.cjs
    image-processor.node   # ≈1.5MB
```

额外地，支持动态解析 loader.js 位置：

1. `process.env.CC_EXT` —— 覆盖，指向任意 loader（相对 cwd 解析）
2. `<shim 目录>/claude-resources/loader.js` —— 默认发行布局
3. `<shim 目录>/loader.js` —— 扁平布局回退

注意，这里总计 ≈109MB，vs 原 229MB 的差额来自：原二进制带有 ~127MB JSC 字节码，纯启动缓存、非更多功能——见 FINDINGS。

## 方法二 shabang script

用 shabang script 直接运行 entry.js / loader.js。

产物布局：

```
bin/
  claude-shim              # entry.js or loader.js
  claude-resources/
    app.js                 # ≈17MB ← extract-bundle.mjs
    audio-capture.node     # ≈0.5MB ← dump-embedded-resources.cjs
    image-processor.node   # ≈1.5MB
```

## 实测

- CLI：`--version` / `--help` / `mcp list` ✓（跨 cwd、整体移动后仍 ✓）
- 交互 TUI \(PTY\)：onboarding 完整渲染 ✓
- loader.js 路径解析 + 优先级 ✓
- 缺资源：友好报错列出尝试过的路径

注意，因为 shim 不含字节码、`app.js` 每次启动现解析，用时一定更久。（`--version` ~1.05s vs 原二进制 ~0.12s）。
