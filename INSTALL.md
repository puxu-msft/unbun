# 安装 unbun

`unbun` 是独立工具仓库，包含 JavaScript/Bun 与 Python 两套 Claude Code 补丁管理器。仓库内无需全局安装即可运行：

```bash
cd ~/src/unbun
bun install
bun cli.mjs --help
bun cli.mjs cc --help
uv sync --directory python/cc-patch
uv run --directory python/cc-patch ccpatch --help
```

## 安装 JavaScript/Bun 入口

在仓库根目录执行：

```bash
bun link
```

确认：

```bash
command -v unbun
unbun --help
unbun cc --help
```

卸载全局链接：

```bash
bun unlink unbun
```

## 安装 Python 入口

使用 uv 安装仓库内 Python 包：

```bash
uv tool install --editable ~/src/unbun/python/cc-patch
```

确认：

```bash
command -v ccpatch
ccpatch --help
```

卸载：

```bash
uv tool uninstall cc-patch
```

## Shared store

两套实现默认解析同一个平台数据目录，也可以显式指定绝对路径：

```bash
export UNBUN_CC_STORE="$HOME/.local/share/unbun/cc-patch"
```

`UNBUN_CC_STORE` 不展开 `~` 或嵌套环境变量；必须传入已经展开的绝对路径。

## 平台状态

- Linux：shared transaction、公开 CLI互操作、真实 Claude临时副本runtime oracle与双 TUI已验证。
- Windows：PE结构与exact replay已验证，真实Windows runtime尚未验证，production写gate禁用。
- macOS：Mach-O parser与合成签名归一化已验证，真实ad-hoc codesign equivalence尚未证明，production写gate禁用。

当前 live Claude binary若已包含不可逆channels补丁但没有matching clean baseline，工具会拒绝猜造baseline；应从clean安装重新建立shared baseline。
