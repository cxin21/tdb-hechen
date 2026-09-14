# R7 分层召回 · 对抗审查修补报告（task-r7fix）

> 任务：单 fix 子代理集中处理 R7 审查全部 findings（Critical 1 + Important 4 + Minor 4 登记）
> 权威 spec：docs/superpowers/specs/2026-09-11-recall-layered-r7-design.md（§1 预算模型 / §2 幂等结论层 / §3 退化安全不变式）
> 分支：main（未 push）；提交：单 commit，`fix(memory): R7 审查修补 — …`
> 验证基线：MemoryCore vitest 335/335 绿（32 文件）；tsc --noEmit 改前 243 错 = 改后 243 错（0 新错，stash 基线法实测）；MemoryProxy vitest 152/152 绿 + tsc exit 0。

---

## Critical · V2-3 分析型放宽静默突破 R7 §1 预算模型 ✅ 已修

**修法（取舍：组装前裁剪，弃"放宽独立登记上限"）**

- `MemoryCore/src/core/hooks/auto-recall.ts:383-387`：V2-3 放宽块之后、截断/幂等指纹之前，
  `r7Conclusions = r7Conclusions.slice(0, r7HalfLimit)` 硬封顶结论侧 = floor(maxResults/2)。
- **取舍理由**：相比"给 V2-3 放宽通道独立登记上限"，组装前裁剪是**一处 slice** 的最小侵入：
  ① 选择器（selectL2Conclusions）与放宽通道语义零变化；② 指纹/幂等缓存、经验层防重
  excludeIds、scene 反查源、metric scores 全部与**最终注入行同源自洽**（放宽通道独立上限
  需要在多处重复登记同一约束）；③ 无 V2-3 溢出时 `length ≤ halfLimit` → slice 恒等，逐位现状。
- 裁剪保头部：命中结论（work_fact/scene 命中）优先于放宽结论——与选择器排序语义一致。
- 伴随修补（同一 budget 对齐半径内）：`auto-recall.ts:504-510` metric scores 的经验侧切片
  从 `experienceLimit` 改为 slice 后定格的**实际经验行数** `r7ExperienceLineCount`——修掉
  "经验命中不足 experienceLimit 时 scores 多切导致 metric 串位"的潜在错位（原代码在
  经验行不足时会把后面的分数错配给前面的行）。

**TDD 证据（RED→GREEN）**

- RED：`src/core/hooks/__tests__/auto-recall-assembly.test.ts:104-124`（分析型 query + 2 条
  命中结论 + 5 条高 significance 放宽 + 1 条经验锚，maxResults=5）→ 修复前实测
  `expected 8 to be less than or equal to 5`（结论 7 + 经验 1 = 8 行，复现审查所述突破）。
- GREEN：同测试修复后通过（总行数 ≤ 5，结论层在场、经验锚在场、metric 一一对应）。
- 真链路断言在场：总行数断言 + `recalledL1Memories.length` 对齐断言（审查要求的
  "最终 memoryLines 总行数 ≤ maxResults"单测）。
- 行为变更登记：`auto-recall-explore-relax.test.ts:180-196` 原断言"放宽 3 条全浮出"编码的
  是修复前的越界行为，已按预算封顶语义更新（甲 0.9 > 乙 0.7 保留，丙被裁剪）。

## Important① · R7 结论层无独立关断开关 ✅ 已修

**修法（复用退化路径，零旁路）**

- `MemoryCore/src/config.ts:199`（类型）+ `:971-981`（解析）：`conclusionLayer.enabled`，
  缺省 `true` = 现行为；`bool(cl,"enabled") ?? true`。
- `MemoryCore/src/core/hooks/auto-recall.ts:330-332`：`r7ConclusionLayerEnabled !== false`；
  `false` 时**候选零收集**（work_fact FTS 查询与 scene block push 均不执行）、选择零执行、
  V2-3 放宽零触发 → `r7Conclusions` 恒空 → 下游走与"无 L2 命中退化"**完全同一条既有路径**
  （layered=undefined / splitBudget 经验层全额 slice 恒等 / assemble 恒等 / metric scores
  原样），不另写任何旁路分支。
- `MemoryCore/tdai-gateway.yaml:94-98`：yaml 注释登记三键（enabled / maxCharsPerMemory /
  cacheTtlMs），全部缺省 = 现生产行为（配置化不硬编码纪律）。

**断言证据**：`auto-recall-assembly.test.ts:127-152`——关断态零结论行、work_fact 回归普通
经验候选（不连坐）、缺省态结论层在场（对照组）；config 解析断言在
`recall-layered.test.ts:239-251`。

## Important② · MemoryProxy 注释失实 + 跨链路双重注入风险 ✅ 已修

**修法（最小方案 = 注释更正 + 注入器侧标记跳过 + 配置缺省单链路）**

- 注释更正：`MemoryProxy/src/injection/index.ts:396-410`——如实描述 TdaiL1RecallInjector
  走内核 `/v3/atomic/search`（自有+借入合并 top-K），**不是** R7 九通道分层链路；3667ddc
  "R7 分层形态化解 KV cache 前提"的表述对本注入器不成立；两链路无跨链路防重。
- 标记跳过：`MemoryProxy/src/injection/injectors/tdai-l1-recall-injector.ts:55-66`——当轮
  用户消息已含 MemoryCore 注入块固定标记头 `<relevant-memories>` → 本注入器直接退出
  （零注入 + 不触发内核召回）。检测范围仅限当轮用户消息（MemoryCore openclaw-plugin
  落盘前剥离该标记，历史消息不受污染）；MemoryCore 链路未部署时标记恒不出现 → 行为零变化。
- 配置缺省单链路（已核实在位，无需改动）：`MemoryProxy/src/config.ts:116` `recallL1: false`
  ——默认形态只有 MemoryCore before_prompt_build 一条 L1 注入链路。

**TDD 证据（RED→GREEN）**：`MemoryProxy/src/injection/injectors/__tests__/
tdai-l1-recall-injector.test.ts`——标记在场 → `[]` 且 `searchL1ForCtx` 零调用（修复前
RED：注入照常发生）；标记不在场 → 正常注入（防误伤）。

## Important③ · 幂等结论层 cache 友好未兑现 ✅ 已修（全量：refresh-on-hit + TTL 解耦）

**修法（收益/侵入比划算，未走只做 refresh-on-hit 的降级选项）**

- refresh-on-hit：`MemoryCore/src/core/hooks/recall-layered.ts:196-199`——命中复用时
  delete + re-set 刷新 Map 插入序（热 session 不再被 FIFO 逐出）；`at` 不刷新——TTL 仍
  锚定首次写入，防"持续命中 → 永久驻留"的漂移窗口失效。
- TTL 解耦：`MemoryCore/src/core/hooks/auto-recall.ts:403`——
  `conclusionLayer.cacheTtlMs ?? (sessionReuseTtlMs ?? 300_000)`；缺省（未配置，config
  解析为 undefined）回落 `sessionReuseTtlMs` 保持现行为；显式 `0` = 关；负值解析层 clamp 0
  （`config.ts:975-979`）。

**TDD 证据（RED→GREEN）**：`recall-layered.test.ts:216-236`——200 键灌满 → 命中 lru-0 →
再插 1 键 → 被逐出的是未刷新的 lru-1 而非热键 lru-0（修复前 RED：lru-0 被 FIFO 逐出，
`expected true to be false`）；config 断言 `:239-251`（undefined 回落 / 0=关 / 负值 clamp）。

## Important④ · performAutoRecall 组装层零单测 ✅ 已补

新增 `MemoryCore/src/core/hooks/__tests__/auto-recall-assembly.test.ts`（真链路
performAutoRecall + 临时 SQLite 库，5 测试）：

| 组 | 测试 | 位置 |
|---|---|---|
| slice 对齐 | 结论 1 + 经验 4 → 总 5 行（experienceLimit = maxResults − 结论数；结论走 scene index 通道避开 FTS 候选窗排序不确定性） | :156-176 |
| assemble 顺序 | 结论行位于全部经验行之前 | :178-198 |
| metric scores 前插对齐 | nativeHybrid scores 通道：结论前插 0 分 + 经验分不串位（0.9→第 1 条经验行）；附带覆盖经验分切片对齐修补 | :200-283 |
| V2-3 溢出 | 与 Critical RED 测试合并（brief 允许） | :104-124 |

## 登记项（Minor 4 条，只登记不修）

1. **eval spec §1.3 mismatchCount=0 措辞**：docs/superpowers/evals 的 spec 中 mismatchCount=0
   的表述与脚本实际判定口径存在措辞落差（不计入失败的结构性差异），建议后续 eval spec
   修订时统一口径。
2. **eval-layered-recall 原地改写归档 JSON**：`MemoryCore/scripts/eval-layered-recall.ts`
   重放后原地改写归档 run JSON（而非生成新文件），归档不可变性受损；本次未触碰已归档
   run 文件（铁律），建议后续改为 append-only。
3. **MemoryProxy globalTopK 硬编码 5**：`tdai-l1-recall-injector.ts:37` `globalTopK = 5`
   构造参数默认值硬编码（`injection/index.ts:427` 未透传配置）；与 MemoryCore maxResults
   无联动，属跨链路预算口径问题，待两链路归属明确后统一。
4. **行解析正则边缘误剥**：`auto-recall.ts:492/:777` metric 解析正则
   `(?:\s*\(活动时间:.*\))?$` 对**内容本身**自带 `(活动时间:…)` 文本的记忆行会把该段
   文本误剥为时间标注（内容截断）。影响仅 metric 上报内容字段，不损注入行；修复需带
   转义/结构化携带，超出本任务半径。
   > **A1 追记（2026-09-12 实测裁定，eval 双改任务）**：构造"结论文本自带
   > `(活动时间:…)`"用例实测定位——误剥点实锤为 `auto-recall.ts:515/:800` 的
   > `(.+?)(?:\s*\(活动时间:.*\))?$`（非贪婪 + 行尾可选组）：内容恰以 `(活动时间:…)`
   > 结尾时该段被剥（如 `记录一条… (活动时间: 每年3月)` → `记录一条…`，结论行同理），
   > 本登记机制描述准确。**eval 侧候选排除**：`eval-layered-recall.ts` 无行拆回解析；
   > `layered-metrics.ts` 分类（classifyInjectionLine）与 CTR/ALD 字符口径对自带
   > `(活动时间:…)` 的行无误剥（回归钉 verify-layered-metrics.ts B15/B16/C5，56/56 过）。
   > 修复在 auto-recall 链路职权（本任务文件职权不含），**维持登记待修**，不予撤销。

## Concerns（风险残留，如实登记）

1. **跨链路防重是"最小方案"而非完备方案**：标记跳过依赖 MemoryCore 注入块出现在同一
   请求的用户消息里。若部署形态是"两链路注入时序上 MemoryProxy 先执行"或"MemoryCore
   经跨进程管道直改 prompt（不经消息列表）"，标记检测不可见 → 双重注入仍可能。该形态
   下必须依赖配置纪律（recallL1 缺省 false，只开一条链路）。已在 injector 代码注释与
   `injection/index.ts:396-410` 双处登记。
2. **V2-3 放宽在预算内的实际额度**：封顶后分析型 query 结论层最多 halfLimit 条（生产
   maxResults=5 → 2 条），放宽通道在命中结论占满额度时可能整轮零浮出——这是预算模型的
   预期语义（宁缺毋滥），但与 E3.2 "significance top-5 浮出"的原始表述有出入，建议
   V2-3 spec 侧补一句预算约束登记。
3. **关断态缓存写入**：`conclusionLayer.enabled=false` 时 `resolveIdempotentConclusionLines`
   仍被调用（空结论集），会写一条空指纹缓存条目（纯进程内、无输出影响）。为保持"与
   无 L2 命中退化同路径复用"未加旁路跳过；若在意可后续在 enabled=false 时短路。
4. **golden 锚点**：本修补改变分析型 query 的注入形态（预算封顶），golden 中分析型
   query 的锚（若有）需重新对锚；本次 golden 目录零触碰（铁律），对锚动作留给下一任务。
5. **MemoryCore typecheck 基线**：仓库 `tsc -p tsconfig.typecheck.json` 存量 243 错
   （adapters/api-trace/lifecycle 等，与本次改动文件零交集）；本次以 stash 基线法确认
   改前=改后=243，0 新错。存量清偿不在本任务范围。

## 验证汇总（完成时点实测）

| 项 | 命令 | 结果 |
|---|---|---|
| MemoryCore 全量 | `node node_modules\vitest\vitest.mjs run` | 32 文件 / 335 测试全绿（脚本 exit 1 系 PowerShell 管道尾命令产物，非测试失败） |
| MemoryCore typecheck | `tsc -p tsconfig.typecheck.json --noEmit` | 改前 243 = 改后 243（stash 基线法），0 新错 |
| MemoryProxy 全量 | 同上（MemoryProxy 目录） | 23 文件 / 152 测试全绿 |
| MemoryProxy typecheck | `tsc --noEmit` | exit 0 |
| 新增/更新测试 | auto-recall-assembly（5）/ recall-layered（+4）/ auto-recall-explore-relax（断言更新） | 50/50 绿 |

## 变更文件清单

- `MemoryCore/src/core/hooks/auto-recall.ts`（Critical 封顶 + I① 关断 + I③ TTL + scores 对齐）
- `MemoryCore/src/core/hooks/recall-layered.ts`（I③ refresh-on-hit）
- `MemoryCore/src/config.ts`（I① enabled + I③ cacheTtlMs：类型 + 解析）
- `MemoryCore/tdai-gateway.yaml`（yaml 注释登记）
- `MemoryCore/src/core/hooks/__tests__/auto-recall-assembly.test.ts`（新增，Important④ + Critical）
- `MemoryCore/src/core/hooks/__tests__/recall-layered.test.ts`（I③ 测试）
- `MemoryCore/src/core/hooks/__tests__/auto-recall-explore-relax.test.ts`（预算语义更新）
- `MemoryProxy/src/injection/index.ts`（I② 注释更正）
- `MemoryProxy/src/injection/injectors/tdai-l1-recall-injector.ts`（I② 标记跳过）
- `MemoryProxy/src/injection/injectors/__tests__/tdai-l1-recall-injector.test.ts`（新增）
- `MemoryCore/scripts/task-r7fix-report.md`（本报告）
