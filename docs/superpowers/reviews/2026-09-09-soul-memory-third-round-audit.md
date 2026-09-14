# 灵魂记忆系统·第三轮对抗性审查与修复报告

> 日期：2026-09-09
> 对象：`td-agemem/docs/superpowers/specs/2026-09-08-agent-soul-memory-spec.md`（v1.0-draft）及 G–M 子设计，对照 git、生产库 `D:/tdai-data/vectors.db` 实证。
> 前言：承接第二轮审计（`2026-09-08-soul-memory-adversarial-audit.md`，修复当时未入库）。本轮把"纸面修复"逐项闭环为**入库代码 + 生产数据实证**。

---

## 0. 第二轮修复的入库确认（此前最大程序性问题）

第二轮审计报告声称的修复（A1/A2/A3/B1/B3/B4/C）此前**全部停留工作区、一个 commit 都没有**——一旦 reset/stash 即丢失，且 spec §6.1 的 ✅ 全部悬空。本次已提交：

- **commit `7565fa0`**：17 文件二次审计修复 + `audit-fix-verify.ts`/`audit-fix-verify-b3.ts` 入库。
- 复核：`node --import tsx scripts/audit-fix-verify.ts` 全过；`audit-fix-verify-b3.ts`（证据链回溯）全过。

**第一性原理结论**：审查的产出必须进 git 才叫"修完"，否则只是"改过"。此纪律已确立。

---

## 1. 生产实证（第三轮新增，第二轮未覆盖）

对生产库 `D:/tdai-data/vectors.db` 逐项反查（`scripts/audit-prod-probe.mjs`，node:sqlite 只读探针，已留档）：

| 指标 | 修复前实测 | 修复后实测 | 含义 |
|---|---|---|---|
| soul 字段覆盖 | **71% 无 occurred_at**（124/175 空） | **100%（182/182）** | P0 兜底只覆盖新写入，**存量 124 条被遗忘引擎永久忽略**（occurred_at 空串 → age=0 → 永不归档）。"会忘是真记忆"红线对存量失效 |
| 孤儿边 | **9/9 全孤儿**（target 均不在任何表） | **0** | B3 修复前硬删 target 留下断链边；邻居召回会读到空气。**代码无孤儿检测** |
| work_fact 持续态 | 0 条 | 0 条（未触发） | H 巩固因真实数据未满足 minCount≥3+跨期≥1d 触发条件，生产零输出属"未达标"而非"没实现" |
| core_values 值表 | **0 行** | 待网关重启种子灌入 | B1 声称遗忘侧从 core_values 读单源，但**表里没数据=读了白读**，且与 MemoryProxy config.yaml 的 appraisal.values 是两套 |
| l1_archive 归档桶 | 0 行 | 0 行（数据均<30天） | 归档未触发符合设计（宁漏勿多），但印证 H/I 生命周期在生产至今无实质输出 |

---

## 2. 本轮修复 F2–F7（每项带事实链）

### F2 · K 写入口信任边界（红线，最高优先）
- **问题**：`/v3/core-memory/write` 无鉴权/无字长/slot 不校验——任何人（含被注入的 agent 内容触发工具）可改写 identity/strict_rule 槽，身份层可被投毒。K 设计 §4/§5 红线未实现。
- **修复**：`src/core/core-memory/guard.ts` 纯函数校验器；config-first `memory.coreMemory{writeEnabled,allowedSlots,maxContentLength}`；handler 拒绝路径 400 + `recordAudit` 审计留痕。
- **验证**：`scripts/audit-fix-verify-f2.ts` 17 断言全过（含 slot 白名单拒绝、超长、空白 content、disabled、规范化）。

### F3 · 存量 soul 回填
- **修复**：`scripts/backfill-soul-fields.ts`，确定性 content-soul + `created_time` 兜底（P0 语义）；dry-run 默认，`--apply` 真写。
- **生产**：124 行回填 → soul 覆盖 **182/182 = 100%**。

### F4 · 巩固幂等 + 租户继承
- **问题**（设计 §6"幂等"未实现）：同 subject 组若持续满足条件，每 10 分钟 tick 会**重复 LLM 生成+持久化新持续态**（id 带随机数）→ 无限增殖+LLM 成本；且 durative 无租户字段，落 `DEFAULT_ISOLATION_ID` → 隔离查询召不回。
- **修复**：`metadata.subject` 幂等键，已有持续态复用 record_id + version 递增；durative 继承源记忆 team/user/agent；`work_fact` 不作为源记忆（防摘要 self-reinforce）。
- **验证**：`scripts/audit-fix-verify-f4.ts` 13 断言全过（两次 run 同 id、version 递增、租户继承、work_fact 隔离）。

### F5 · 图边生命周期 + restoreL1（含重大存量 bug）
- **新增 `pruneOrphanLinks()`**：清两端均消失的边；`deleteL1`/`deleteL1Batch` 硬删级联删边（图设计 §5 落地）。
- **抓到存量 bug【高】**：`restoreL1` 的 `INSERT OR REPLACE INTO l1_records` **26 列 ↔ 27 个 `?` 占位符失配** → 每次 restore 必抛 `27 values for 26 columns` return false，**恢复功能从未工作过**。二轮审计只读了代码没跑，未发现。已修列数对齐 + 补 FTS 重建（archive 删 FTS，restore 需重建，否则恢复记忆 FTS 搜不到）。
- **验证**：`scripts/audit-fix-verify-f5.ts` 11 断言全过；生产 9 条孤儿边清零。

### F6 · 价值锚单一源（B1 收口）
- **裁定**：`core_values` 表为单一源（K §2 agent 可维护本意），弃 MemoryProxy config.yaml 独立值。
- **修复**：MemoryCore 启动种子 `memory.coreMemory.seedValues`（表空才灌，幂等，yaml 已配 6 值对齐 proxy）；MemoryProxy `TdaiClient.listCoreValues()`（/v3/core-memory/read，30s TTL）→ L 注入优先取表、空 fallback config.yaml。
- **顺手修** MemoryProxy `RawYamlConfig` 缺 `appraisal` 类型声明（预存在的类型债）。
- **验证**：MemoryProxy vitest **79/79 全过**（MemoryCore 侧 vitest 本环境不可用）。

### F7 · tcvdb 后端边界如实登记
- G/H/I/K 新表与方法（l1_links/l1_archive/core_values + 相关方法）**仅 SQLite 后端实现**；tcvdb 这些是可选方法未实现。service/tcvdb 模式下建边/归档/价值锚静默空转，且 archive 兜底会**回退硬删**（红线在后端层被绕过）。切后端前须补实现或显式接受降级。已登记进 spec §6.2。

---

## 3. 遗留（明确不做，待拍板）
- **B2 reconsolidation 正向机制**：设计宣称"回忆即重巩固"，实现只做了"防 inferred 被归档/巩固/入画像"的防守侧，正向"observed 被回忆时重缝合"未做。需产品语义拍板（预算/触发点/与 H 边界）。
- causal 边、no-dedup top-1 similar、query 时间锚窗过滤、scene(L2) 附着、恢复 API UI、两条召回线格式统一（auto-recall 仍用 `formatMemoryLine`，工具侧才用 `formatSearchResponse`）。

## 4. 验证留档
- `MemoryCore/scripts/`: `audit-fix-verify.ts`(A1/A2/B1)、`audit-fix-verify-b3.ts`(B3)、`audit-fix-verify-f2.ts`(17)、`audit-fix-verify-f4.ts`(13)、`audit-fix-verify-f5.ts`(11)、`backfill-soul-fields.ts`、`audit-prod-probe.mjs`。
- vitest：MemoryProxy 79/79 可跑；MemoryCore vitest 不可跑（无 `.bin/vitest`），改以 tsx 直跑纯逻辑 + 真实 VectorStore 全链路验证。
- 网关（pid 28468）待重启以加载 F2/F6 改动（校验器、价值种子、F5 store 方法）——重启后请复核 core_values 种子与 /v3/core-memory/write 校验行为。