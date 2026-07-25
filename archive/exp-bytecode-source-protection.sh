#!/usr/bin/env bash
# ARCHIVED — PoC/实验 provenance，勿运行。见 tools/unbun/
# exp-bytecode-source-protection.sh — bun `--bytecode` 能不能「只装字节码」从而保护源码?
# 结论(bun 1.3.14 实测):不能。源码始终内嵌,且 load-bearing(嵌套函数运行时从源码惰性解析)。
#
# 三个实验:
#   ① --bytecode 构建是否内嵌源码?            -> 是(grep 命中源码)
#   ② 源码是 redundant 还是被真正执行?        -> 改源码 1000->9999,输出跟着变 => 用的是源码
#   ③ 源码 load-bearing 吗(损坏能否仍跑)?    -> 改成非法源码,二进制直接启动失败 => 不可剥离
#   旁证:--minify 只改标识符名、逻辑仍是可读 JS,是 bun 唯一的(弱)混淆手段。
#
# 关键洞见:JSC 字节码缓存只覆盖顶层/急切编译代码;嵌套函数体首次调用时仍从源码解析。
# 故 bun 必须保留源码,`--bytecode` 是**启动缓存**(把解析从运行期挪到构建期),**不是源码保护**。
# 这也正解释了为何 claude 二进制必须内含那份 16.6MB 源码(我们能提取出来在裸 bun 上跑)。
set -euo pipefail
command -v bun >/dev/null || { echo "need bun in PATH" >&2; exit 1; }
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT; cd "$W"

cat > test.js <<'EOF'
function compute(a, b) { const z = a * 1000 + b; return "RESULT[" + z + "]"; }
console.log(compute(40, 2));
EOF
bun build --compile --bytecode test.js --outfile tb >/dev/null 2>&1

echo "① 源码是否内嵌于 --bytecode 二进制?"
grep -aoF 'a * 1000 + b' tb >/dev/null && echo "   是 — 源码明文在二进制里(grep 命中)" || echo "   否"

echo "② 运行时用源码还是字节码?(改源码 1000->9999,字节码不动)"
cp tb t2; node -e '
const fs=require("fs"),b=fs.readFileSync("t2");
const a=Buffer.from("a * 1000 + b"),r=Buffer.from("a * 9999 + b");
let i=0;while((i=b.indexOf(a,i))!==-1){r.copy(b,i);i+=a.length}fs.writeFileSync("t2",b)'
chmod +x t2
out=$(./t2)
echo "   改源码后输出: $out  ($([ "$out" = "RESULT[399962]" ] && echo "= 用源码(399962)" || echo "= 用字节码(40002)"))"

echo "③ 源码 load-bearing?(改成非法 JS,同长,字节码完好)"
cp tb t3; node -e '
const fs=require("fs"),b=fs.readFileSync("t3");
const a=Buffer.from("const z = a * 1000 + b;");
let bad="const z = @@@BROKEN@@@;;".slice(0,a.length).padEnd(a.length,";");
const r=Buffer.from(bad);let i=0;while((i=b.indexOf(a,i))!==-1){r.copy(b,i);i+=a.length}fs.writeFileSync("t3",b)'
chmod +x t3
echo -n "   损坏源码后运行: "; { ./t3 2>&1 || true; } | head -1
echo "   (报错=源码不可剥离;RESULT[40002]=纯字节码可跑)"

echo "旁证:--minify 混淆强度"
cat > t4.js <<'EOF'
function computeSecretTax(income, rate){ return income*rate/100 + 7; }
console.log(computeSecretTax(1000, 5));
EOF
bun build --compile --minify --bytecode t4.js --outfile t4 >/dev/null 2>&1
grep -aoF 'computeSecretTax' t4 >/dev/null && echo "   标识符保留" || echo "   标识符被改名(--minify 生效),但逻辑/常量仍是可读 JS"

echo
echo "结论:--bytecode = 启动缓存,非源码保护;源码始终内嵌且 load-bearing,无法只装字节码。"
