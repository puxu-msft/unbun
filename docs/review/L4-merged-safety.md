# L4 — 合并态与安全边界评审 + 总汇总

> 层目标：单项评审之外的**集成缝与合并态**问题，以及安全边界（static/runtime/mutate 三分、原子写、lock、codesign、无 shell 拼接）是否真的守住。最后产出全仓库 review 总结论。
> 上级索引：[README.md](README.md)。前置：L1–L3 全部完成。

## 评审提问（待执行时逐条落实）

1. **static/runtime/mutate 三分是否真守住**：纯静态命令（extract/assets/split/layout/diff）是否**绝不执行**目标二进制？cc run/introspect/patch-loader-hook 是否只对副本打桩？只有显式 patch/revert/snapshot restore 才写目标？裸非 TTY 是否只读？（去代码里验证，而非信文档）
2. **无 shell 拼接**：strings/bun build/spawn 副本是否全走 execFileSync/spawnSync 数组参数，不经 shell 求值。
3. **破坏性写守卫**：拒绝静默批量改多个 live、拒写 versions/ live 区（除非 --force）、锚点零命中即报错、baseline-before-binary 事务顺序。
4. **集成缝**：commit message 是否匹配内容（首提交理顺后）；doc↔code 在 L1 之后是否仍有残留漂移；两实现互操作在真实端到端路径下是否成立。
5. **codesign**：macOS 等价性未证明的声明，代码里的 codesign 处理是否与「gate 禁用」一致，不会在 Linux 误触。

## 发现清单

| ID | 级别 | 位置 | 问题 | 建议 | 状态 |
|---|---|---|---|---|---|
| _(待执行)_ | | | | | |

## 全仓库 Review 总结论

_(L1–L4 完成后写入：整体质量判断、Blocker/Major 清单、发布 gate 就绪度、修复优先级排序、给用户的行动建议)_
