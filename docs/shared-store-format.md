# unbun cc 共享 store 格式 v1

> 状态：与 [`dual-implementation-spec.md`](dual-implementation-spec.md) 配套的实施协议。
>
> 日期：2026-07-23。
>
> 本文定义 JavaScript/Bun 与 Python 两套完整补丁实现共同读写的 baseline、snapshot、lock 与 quarantine 格式。共享的是磁盘协议，不是实现代码。

## 1. 设计目标

- 任一实现建立的 clean baseline，另一实现可以验证并用于目标 feature 集合重放。
- 任一实现保存的 snapshot，另一实现可以列出、恢复和删除。
- 两套实现不会因同时写同一目标而互相覆盖。
- 不可逆 `channels` 写入前，clean baseline 必须已经完整、可发现且通过自校验。
- 崩溃留下的临时文件或未激活 blob 不会被普通读取路径误认为有效资产。
- 所有正式资产都由 manifest 激活；文件名、manifest 和内容三者互相校验。
- 不读取或迁移旧 `.ccbak`、`.agentbak` 与 `.channels.bak`。

## 2. Store root

优先级：

1. 若设置 `UNBUN_CC_STORE`，使用其绝对路径。
2. Linux：`${XDG_DATA_HOME:-$HOME/.local/share}/unbun/cc-patch`。
3. macOS：若设置 `XDG_DATA_HOME` 则沿用；否则 `$HOME/Library/Application Support/unbun/cc-patch`。
4. Windows：`%LOCALAPPDATA%\unbun\cc-patch`。

两套实现必须提供只读命令输出最终解析出的 store root，供诊断和互操作测试使用。`UNBUN_CC_STORE` 必须是平台原生绝对路径：POSIX 以 `/` 开头，Windows 使用 drive-root 或 UNC absolute path。含未展开 `~`、`$VAR` 或 `%VAR%` 的值属于用法错误；实现不做 shell expansion，也不能相对当前工作目录解释。

协议版本作为 root 下的一级目录：

```text
<store-root>/
  v1/
```

读取器遇到高于自身支持范围的协议版本时必须拒绝，不得尝试按最新已知格式猜读。

## 3. Target identity

### 3.1 Canonical path

目标 binary 必须存在后才能建立 identity。canonical path 算法：

1. 转为绝对路径。
2. 解析现存路径的 symlink。
3. Unicode 归一化为 NFC。
4. POSIX 保留大小写并使用 `/`。
5. Windows 去掉 `\\?\` 前缀，把 `\` 转为 `/`，只把 ASCII `A-Z` 转为 lowercase，非 ASCII code point 原样保留。

v1 只支持能被两种运行时无损表示为 Unicode string 的路径。无法无损解码的 POSIX byte path 必须显式拒绝。ASCII-only lowercase 是协议算法，不声称完整复现 NTFS case folding；跨语言确定性优先于猜测宿主文件系统的 Unicode 版本。

`path_key` 是 canonical path UTF-8 字节的完整 SHA-256 lowercase hex：

```text
path_key = sha256(utf8(canonical_path)).hexdigest()
```

不截短 hash。canonicalization 必须有跨语言固定向量，至少覆盖 POSIX symlink、空格、非 ASCII、Windows drive letter 与 separator。

### 3.2 Target directory

```text
v1/targets/<path_key>/
  target.json
  write.lock/
  baselines/
  snapshots/
  quarantine/
```

`target.json` 示例：

```json
{
  "schema": "unbun.cc.target",
  "schema_version": 1,
  "path_key": "64-lowercase-hex",
  "canonical_path": "/absolute/real/path/to/claude",
  "display_name": "claude",
  "created_at": "2026-07-23T12:34:56.000Z"
}
```

`target.json` 首次创建使用 no-clobber publish。若已存在，读取器必须验证 `schema_version`、`path_key` 与重新计算的 canonical path；不一致时报 `target_identity_mismatch`。

移动 binary 会产生新的 target identity，不自动继承旧 target 的 baseline 或 snapshot。需要迁移时必须由未来的显式命令完成，v1 不提供隐式查找。

## 4. 共同 JSON 规则

- 编码为 UTF-8，无 BOM。
- 顶层必须是 object。
- 时间使用 UTC RFC 3339，固定 `Z` 后缀。
- SHA-256 使用 64 位 lowercase hex。
- size 使用非负 JSON integer。
- 路径字段是相对当前 manifest 所在目录的 basename 或受约束相对路径，禁止绝对路径和 `..`。
- 同一 schema version 下，读取器忽略未知字段，以允许增加可选观测信息；缺少必需字段必须拒绝。
- 读取器拒绝未知 `schema`、更高 `schema_version`、错误字段类型和非法 slug/version。
- JSON 的空格、缩进与 object key 顺序不属于协议；互操作测试比较解析后的结构化值。

## 5. Feature contract identity

所有 baseline 与 snapshot manifest 都记录：

```json
{
  "feature_contract": "claude-v1"
}
```

`claude-v1` 固定表示：

- feature registry 顺序为 `source-exec`、`agent-model`、`channels`。
- `agent-model` 无依赖；`channels` 依赖 `source-exec`。
- feature 状态集合为 `clean`、`patched`、`mixed`、`unsupported`。
- 字节变换语义由双实现规格的 Feature 行为契约定义。

若未来改变字节语义或 feature identity，需要新的 contract 名称；不能在已发布的 `claude-v1` 下静默改变既有 feature 的意义。本次移除 `agent-model -> source-exec` 是 pre-implementation correction：Phase 0 contract 资产尚未提交、发布或被生产实现消费，因此保留 `claude-v1`，避免为未发布的错误草案虚增版本；修订依据、红绿证据与重冻结 hash 记录在进度 ledger。

## 6. Clean baseline

### 6.1 Layout

```text
v1/targets/<path_key>/baselines/<embedded_version>/
  baseline.json
  blobs/
    <sha256>.ccbak
```

`embedded_version` 只允许 ASCII 数字与点，正则为：

```text
[0-9]+(?:\.[0-9]+)*
```

每个 target、每个 embedded version 只能有一个 active `baseline.json`。`blobs/` 可以因崩溃或失败的竞争留下未被引用的 content-addressed blob；普通读取路径忽略它们。

### 6.2 Manifest

```json
{
  "schema": "unbun.cc.baseline",
  "schema_version": 1,
  "feature_contract": "claude-v1",
  "path_key": "64-lowercase-hex",
  "embedded_version": "2.1.217",
  "blob": "blobs/<sha256>.ccbak",
  "sha256": "64-lowercase-hex",
  "lineage_algorithm": "claude-v1-exact-replay",
  "lineage_sha256": "64-lowercase-hex",
  "size": 268573680,
  "states": {
    "source-exec": "clean",
    "agent-model": "clean",
    "channels": "clean"
  },
  "created_at": "2026-07-23T12:34:56.000Z",
  "created_by": "js"
}
```

`created_by` 是自由字符串，当前约定值为 `js` 与 `python`，仅用于诊断；读取器不得因未知值判定资产无效。

### 6.2.1 Build lineage 与 exact replay proof

embedded version 不能区分同一路径、同版本号的不同 build。每个 baseline manifest 因此必须保存 `lineage_algorithm` 与 `lineage_sha256`。

`claude-v1-exact-replay` 对 baseline 与当前 binary 使用以下证明：

1. 对 clean baseline 做平台签名归一化并计算 SHA-256，记录为 `lineage_sha256`。
2. 对当前 binary 独立执行 `observe_substates`，得到三个 feature 的完整 substate vectors。
3. 从 clean baseline 复制 bytes，按 contract 顺序调用 `replay_substates`，精确重建当前 vectors 对应的 expected bytes。
4. 分别对 expected 与当前 binary 做相同的平台签名归一化，要求 size 和全部归一化 bytes 逐字节一致。仅比较 hash 不足以作为测试 oracle；实现可以用 hash 快速拒绝，但成功前仍需完整比较。
5. expected 的平台归一化 SHA-256 必须等于当前归一化 SHA-256；baseline 自身的归一化 SHA-256 必须等于 manifest `lineage_sha256`。

这不是 mask-based identity：expected 仍包含 baseline 在 feature-owned 区域内的真实 clean bytes或确定性 patched bytes，因此不会主动忽略这些区域的 build 差异。若一个不可逆补丁已经把两个不同 clean build 的全部差异转换成完全相同的 patched bytes，且没有任何 clean baseline 或外部 provenance，信息在物理上已经丢失，任何算法都无法恢复；v1 的防线是 baseline-before-binary、共享 lock，以及拒绝 channels patched 且无 baseline 的状态，不声称解决该不可判定情形。

平台签名归一化：

- ELF 与 PE v1 不做签名归一化。
- Mach-O 的初步候选是解析 `LC_CODE_SIGNATURE`，把 `dataoff`、`datasize` 字段归零，并从比较 stream 中排除其指向的 code signature blob。
- Phase 1 PoC 必须额外检查 `LC_SEGMENT_64 __LINKEDIT` 的 `filesize`/`vmsize`、Mach-O header `sizeofcmds` 和文件总长是否因原始签名或 ad-hoc 重签名变化；若变化，算法必须扩展归一化范围后再冻结 vectors。
- 签名边界不可验证、多个 command 冲突或解析失败时，lineage 不可证明，写路径拒绝。

若当前 binary 为 `unsupported`，或任一 feature 的 substate vector 无法完整推导和重放，不能完成可信 replay proof。`mixed` 只有在全部子站点能精确重建时才允许继续，否则 fail-closed。

### 6.3 发布协议

建立新 baseline 时，持有 target write lock 的 writer 必须按以下顺序：

1. 从当前 clean binary 或经允许的 reversible rebuild 得到 candidate bytes。
2. 完整 detect candidate，要求三个 feature 全部为 `clean`。
3. 提取 embedded version，要求与目标目录版本一致。
4. 计算 size 与 SHA-256。
5. 按 §6.2.1 计算 lineage SHA-256。
6. 在 `blobs/` 同目录写唯一临时文件，flush、file fsync、回读并核对 hash 与 size。
7. 以 no-clobber 原语发布为 `blobs/<sha256>.ccbak`。若同名已存在，完整验证后可视为幂等成功。
8. 写 `baseline.json` 临时文件，flush、file fsync、回读解析并验证。
9. 以 no-clobber 原语发布 `baseline.json`。POSIX 与 macOS 随后必须 directory fsync；Windows 没有共同可移植的 directory fsync 等价物，v1 在完成 file flush 与 atomic rename 后记录这一 durability 残余边界，不伪造成功的 directory flush。
10. 从正式 manifest 重新读取 blob，再次执行 manifest、hash、lineage、size、version 与全 clean 校验。
11. 只有第 10 步成功后，才能修改目标 binary。

`baseline.json` 是激活点。只有 blob 而没有 manifest 时，该 blob 不构成 active baseline。

no-clobber 的语义是“目标不存在时原子发布，目标存在时不修改它并报告冲突”。实现可以使用同文件系统 hard-link publish 或提供等价语义的平台原语；不得使用 `exists` 后无条件 replace 模拟 no-clobber。

若 `baseline.json` 已存在：

- manifest 与 candidate 指向同一 hash，且完整验证通过，视为幂等成功。
- manifest 指向不同 hash，报 `baseline_conflict`，不得覆盖。

### 6.4 消费校验

每次消费 baseline 都重新验证：

- target `path_key` 一致。
- manifest version、目录 version 与 blob embedded version 一致。
- blob path 受约束且存在。
- size 与 SHA-256 一致。
- baseline blob 重新计算的签名归一化 SHA-256 与 manifest `lineage_sha256` 一致。
- `feature_contract` 受支持。
- 三个 feature 实际 detect 都是 `clean`；不能只信 manifest 的 `states`。
- 当前 binary embedded version 与 baseline version 一致。
- 当前 binary 必须通过 §6.2.1 的 exact replay proof；失败时报 `baseline_stale_build`。这条校验适用于 clean、patched 与可精确重建 substates 的 mixed 状态，不能只比较 embedded version 或 mask 后的摘要。

任一失败均不得 replay。错误资产在持锁后可以移入 quarantine，但不能静默删除或覆盖。

### 6.5 无 baseline 时的建立规则

按顺序处理：

1. 当前三个 feature 全 clean：以当前 bytes 建立新 baseline。
2. 当前只有 reversible feature 为 patched：按反向拓扑序 reverse，要求结果全 clean，再按正向顺序 replay 原 patched 集合，要求逐字节等于当前 bytes；通过后才可建立 baseline。
3. `channels=patched`：报 `channels_patched_no_baseline`。
4. 任一 feature 为 `mixed` 或 `unsupported`：报 `unsupported_or_mixed_no_baseline`。
5. version 无法提取：报 `version_probe_failed`。

禁止搜索、读取或迁移旧工具 backups。

## 7. Named snapshot

### 7.1 Layout

```text
v1/targets/<path_key>/snapshots/<embedded_version>/<slug>/
  snapshot.json
  blobs/
    <sha256>.ccsnap
```

slug 正则：

```text
[a-z0-9]+(?:-[a-z0-9]+)*
```

同 target、同 version、同 slug 只有一个 active manifest。跨版本同名 snapshot 可以共存。

### 7.2 Manifest

```json
{
  "schema": "unbun.cc.snapshot",
  "schema_version": 1,
  "feature_contract": "claude-v1",
  "path_key": "64-lowercase-hex",
  "embedded_version": "2.1.217",
  "slug": "before-change",
  "blob": "blobs/<sha256>.ccsnap",
  "sha256": "64-lowercase-hex",
  "size": 268573680,
  "observed_states": {
    "source-exec": "patched",
    "agent-model": "patched",
    "channels": "clean"
  },
  "created_at": "2026-07-23T12:34:56.000Z",
  "created_by": "python"
}
```

`observed_states` 是创建时观测值；消费时必须重新 detect，不能把它当恢复后真相。

### 7.3 Save 与 force

普通 save：

1. 持 target write lock。
2. 读取当前 binary 一致快照并提取 version。
3. 写入并验证 content-addressed blob。
4. no-clobber 发布 `snapshot.json`。
5. 已存在则报 `snapshot_exists`。

`--force`：

1. 写入并验证新的 content-addressed blob。
2. 用同目录临时 manifest 原子 replace `snapshot.json`。
3. POSIX 与 macOS 执行 directory fsync；Windows 采用 §6.3 相同的 file flush + atomic rename 边界。
4. 回读正式 manifest 与 blob并验证。

manifest 是激活点，因此 force 中断时要么旧 manifest 仍有效，要么新 manifest 已完整生效。未引用 blob 可以由显式 GC 清理。

### 7.4 List、restore 与 rm

- list 只列出有有效 `snapshot.json` 的 slot；损坏 slot 标记 invalid，不静默跳过。
- restore 以 blob 内容 embedded version 为准。与当前 binary version 不同时必须告警并要求显式确认；`--yes` 可以确认，但不能隐藏告警。
- 同 slug 跨版本多份时，默认选择当前 version 的一份；当前 version 无匹配且有多份时要求 `--snapshot-version`。
- restore 走与 feature write 相同的 target lock、提交前重读、原子替换、回读后验与失败回滚。
- rm 在持锁时原子移除 manifest。blob 可留待显式 GC，避免删除与读取竞争。
- snapshot 不自动 GC。

## 8. Cooperative write lock

### 8.1 目的

JavaScript 与 Python 都是完整 writer，必须防止两者同时修改同一 binary 或同一 target store。v1 使用双方都能实现的原子目录锁，不依赖语言特定 advisory lock library。

### 8.2 Layout

```text
v1/targets/<path_key>/write.lock/
  owner.json
```

获取锁使用原子 `mkdir(write.lock)`：

- mkdir 成功即获得锁。
- 已存在则报 `target_locked`，不得继续任何写动作。
- 创建目录后写入 `owner.json`，它只用于诊断，不决定锁是否存在。

`owner.json`：

```json
{
  "schema": "unbun.cc.lock-owner",
  "schema_version": 1,
  "token": "uuid-v4",
  "implementation": "js",
  "pid": 12345,
  "hostname": "host-name",
  "started_at": "2026-07-23T12:34:56.000Z",
  "command": "patch"
}
```

`implementation` 是自由诊断字符串，当前约定值为 `js` 与 `python`；未知值不影响锁的有效性。

释放锁前，owner token 必须与进程持有 token 一致；随后删除 owner 并 `rmdir(write.lock)`。不得递归删除未知 lock 内容。

### 8.3 崩溃后的 stale lock

v1 不自动抢占 stale lock。自动依据 PID 删除会受到 PID 重用、容器和跨平台进程查询差异影响。

两套实现都应提供显式诊断和清理动作，名称可以不同，但必须：

1. 显示 owner metadata。
2. 检查本机是否存在对应 PID并向用户报告。
3. 只有显式 `--force` 才删除 stale lock。
4. 删除前后都不触碰 binary、baseline 或 snapshot。

若 `write.lock/` 存在但 `owner.json` 缺失、损坏或无法解析，诊断命令报告 `lock exists but owner unknown`；它仍是有效锁，仍只有显式 `--force` 才能删除。

只读 status、profile 与 snapshot list 不需要 write lock。baseline 建立、feature write、snapshot save/rm/restore 和 quarantine 操作必须持锁。

## 9. Binary write transaction

持有 target lock 后，每次 feature write 遵循：

1. 在 transaction 入口重新读取 binary，不能信任 CLI 或 TUI 先前 probe 的 bytes。
2. 若调用方带 entry digest，要求入口 bytes 与之相同，否则报 `concurrent_binary_change`。
3. detect 当前状态并检查被移除依赖。
4. 提取 version并获取、建立或验证 matching clean baseline。
5. 从 baseline 重新开始，按确定性依赖顺序重放最终目标 feature 集合。
6. 在内存执行 feature、version、等长与目标状态后验。
7. 若 baseline 是新建候选，先按第 6 节完成正式发布与重新验证。
8. 若 result bytes 与 transaction entry bytes 完全相同，在再次确认 binary 未变化后返回 edits=0；不写 temp、不 replace、不 codesign。
9. 在 binary 同目录写 result temp，flush、file fsync、复制执行 mode，回读核对 result bytes。
10. 紧贴原子 replace 前重新读取 binary，要求仍等于 transaction entry bytes，且 exact replay proof 仍成立。
11. 原子 replace binary，随后回读；Linux 与 Windows 要求逐字节等于 result。
12. macOS 执行 ad-hoc codesign 后，重新检查 version、feature states、lineage 与可执行文件基本状态；签名后的 full bytes 不要求等于签名前 result。
13. 任一写后验证或 codesign 失败，原子恢复 transaction entry bytes并回读验证。
14. rollback 失败时报 `rollback_failed`，保留 valid clean baseline 与诊断 temp，不得报告成功。

若 Windows 或其他平台因 binary 正在运行而无法 replace，报 `binary_in_use`，并把已验证的 ready temp 移入 target quarantine 后报告其路径；不得把 `.patched` 文件长期留在 launcher 扫描目录。

本协议不承诺抵御不合作 updater 在最后一次读取与 replace 之间的极小窗口；这是已知残余风险。当前本机单用户威胁模型采用 cooperative lock、replace 前重读和回滚，不引入 durable journal 或平台专用 atomic exchange。

## 10. Temp 与 quarantine

### 10.1 Temp 命名

所有 temp 都在最终文件同一目录，名称以点开头并含 UUID：

```text
.<final-name>.tmp.<uuid>
```

普通发现逻辑忽略所有点开头 temp。temp 永远不能放在 Claude launcher 扫描的 `versions/` 目录；只有用于最终替换 binary 的 result temp 因原子 replace 要求而短暂位于 binary 同目录，其名称必须不能通过版本筛选，并在失败诊断后显式处理。

### 10.2 Quarantine

```text
v1/targets/<path_key>/quarantine/
  <timestamp>-<reason>-<uuid>/
    artifact
    quarantine.json
```

`quarantine.json` 至少记录原相对路径、reason code、observed hash、发现时间和发现实现。quarantine 资产永远不被普通 baseline/snapshot lookup 消费。

适合 quarantine 的原因：

- manifest 与 blob hash 不符。
- manifest version 与内容 version 不符。
- baseline 实际不是全 clean。
- target identity 不匹配。
- 并发变化后新建 baseline 不再能安全关联当前 binary。

无法安全移动时保留原文件并 fail-closed，不能通过删除错误资产来假装恢复正常。

## 11. Permissions 与敏感元数据

- store directory 在 POSIX 上建议 mode `0700`，manifest 与 blob 建议 `0600`。
- Windows 上使用当前用户默认 ACL，不为协议引入额外 ACL 管理。
- baseline 与 snapshot 不需要 executable bit；恢复 binary 时继承 transaction entry binary 的 mode，而不是 blob mode。
- manifest 不存储 secrets。
- hostname、PID 与 canonical path 属于本机诊断信息，不应出现在公开测试 golden；conformance tests 使用归一化临时路径。

## 12. 稳定错误 code

Store 与 transaction 至少使用以下 code：

| Code | Exit | 含义 |
|---|---:|---|
| `store_version_unsupported` | 1 | 不支持该 store 协议版本 |
| `target_identity_mismatch` | 2 | target metadata 与 canonical path 不一致 |
| `target_locked` | 1 | 另一 writer 持有 target lock |
| `baseline_not_found` | 1 | 没有 matching baseline 且不能建立 |
| `channels_patched_no_baseline` | 1 | 不可逆 channels 已 patched 且无 clean baseline |
| `unsupported_or_mixed_no_baseline` | 1 | 无法从入站态建立可信 baseline |
| `version_probe_failed` | 1 | 无法提取 embedded version |
| `baseline_conflict` | 2 | 同 target/version 已激活不同 baseline |
| `baseline_invalid` | 2 | baseline manifest 或内容自校验失败 |
| `baseline_stale_build` | 2 | 当前 binary 与 matching version baseline 不属于同一 build lineage |
| `snapshot_exists` | 1 | 同 target/version/slug snapshot 已存在 |
| `snapshot_not_found` | 1 | snapshot 不存在 |
| `snapshot_ambiguous` | 1 | 同名跨版本且无法默认选择 |
| `snapshot_invalid` | 2 | snapshot manifest 或内容校验失败 |
| `concurrent_binary_change` | 1 | transaction 期间 binary 发生变化 |
| `content_mismatch` | 2 | 写后字节或 feature 后验不一致 |
| `rollback_failed` | 2 | 失败后无法恢复 entry bytes |
| `binary_in_use` | 3 | 目标 binary 被占用，无法原子替换 |
| `codesign_failed` | 3 | macOS 重签名失败 |

自然语言 message 可以不同，code、exit 与结构化 details 语义必须一致。

## 13. Conformance vectors

`contract/vectors/store-v1/` 至少包含：

- canonical path 与 path key 跨语言向量。
- target、baseline、snapshot 与 lock owner 的有效 manifest。
- 每种 manifest 的缺字段、错类型、未知高版本和路径穿越坏样本。
- baseline hash、size、version、feature state 不一致坏样本。
- snapshot 同名跨版本选择矩阵。
- no-clobber 冲突与 `--force` snapshot 激活场景。
- lock contention 与显式 stale cleanup 场景。
- temp-only、blob-only、manifest-only 与 orphan blob 崩溃残留场景。
- 同路径同版本不同 build 的 lineage 拒绝场景。
- clean、三个 feature 组合与 mixed substate vectors 的 exact replay proof 场景。
- 每个 feature、每种状态的 substate vector 与 replay 结果跨实现一致性向量。
- Mach-O 原始签名与 ad-hoc 重签名后的跨实现 lineage、baseline 消费与 feature 重放场景。
- 含 `Ü`、`ß` 与非 ASCII 用户目录的 Windows canonical path 向量，验证只做 ASCII lowercase。

每个向量都由 JavaScript 与 Python 独立读取并产生相同结构化结果或相同错误 code。向量预期不得在测试运行时由任一实现生成。

## 14. 当前 store 引导规则

旧 backups 已删除，新 v1 store 从空目录开始。当前 live `2.1.217` 的三 feature 均为 `patched`，其中 `channels` 不可逆，是触发 no-baseline 拒绝的主因；因此它不能作为 clean baseline 来源。两套实现面对该状态都必须返回 `channels_patched_no_baseline`。

可以从当前 clean `2.1.214` 建立属于其自身 path/version identity 的 baseline，但它不能用于 `2.1.217`。live 写入验收必须等待或安装目标版本的 clean binary，再从该 clean bytes 激活 v1 baseline。

## 15. 协议演进

以下变化需要 `v2/`，不能原地修改 v1：

- target identity 或 path key 算法变化。
- baseline/snapshot 激活模型变化。
- lock 互斥语义变化。
- manifest 必需字段含义变化。
- 引入 durable journal 或 atomic exchange 并改变崩溃恢复承诺。

以下变化可在 v1 增加可选字段：

- 新诊断时间或 writer 版本。
- 不影响消费决策的性能数据。
- 新 quarantine metadata。

任何协议升级都必须先提供双向迁移方案和 JS/Python 交叉测试；不能只更新一套实现后让另一套静默忽略新语义。
