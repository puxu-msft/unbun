// ARCHIVED — PoC/实验 provenance，勿运行。见 tools/unbun/
// cc-ext.example.cjs — 示例外部 bundle。patch-loader-hook 注入后,
// 二进制在 main 之前 require 它(由环境变量 CC_EXT 指向)。
// 这里随便放点东西证明「二进制执行了它自身不包含的代码」;真实用途里可在此
// patch 全局、hook require、注入 instrumentation、加载你自己的整套 js 等。
if (!globalThis.__cc_ext_ran) {
  globalThis.__cc_ext_ran = true
  console.error('>>> EXTERNAL BUNDLE EXECUTED FROM INSIDE THE CLAUDE BINARY <<<')
  console.error('>>> file=' + __filename + ' pid=' + process.pid)
}
module.exports = {}
