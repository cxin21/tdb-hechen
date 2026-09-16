# 剩余工作 · 第一性原理分析文档 v3

> 文档标识：REG-REMAINING-003（取代 REG-REMAINING-002 的待办部分；v2 的已完成项索引与不做项判定继续有效）
> **（2026-09-16 晚起待办部分已被 REG-REMAINING-004 取代**：docs/superpowers/plans/2026-09-16-remaining-work-v4.md——含验证轮后新增项与已关闭项；本档保留作已完成项与判定依据索引）
> 日期：2026-09-16
> 方法论：每项从第一性原理出发，结合真实代码（file:line 实证）与设计文档分析 → 判定"做/等/不做" → 附实现设计
> 审计原则：自生长、自维护——凡是"等人操作"的环节都是设计缺口
> 数据基线（2026-09-16 13:30）：判官池 142 · conflict 1 · derived_from 84 · L1 218（FTS/向量 218/218 同步）· 锚 15（valence 9/15）· coreRefs 123 · 失效记忆 5

---

## 第一部分 · 真正要做的

### 1. 锚 valence 漂移排查与修复（优先级 1 · 现在做）

> **状态（2026-09-16）：✅ 已完成**——根因/修复/回归实测详见 CHANGELOG「锚 valence 漂移修复」。要点修正：boot derive
> 本在跑但只判 default 桶（快照"零 derive 日志"为口径误记，日志恒 {0,0}）；真因 = 15 锚全在非 default 租户 + 采纳路径
> 绕过 upsert 钩子的双重静默。修复 = listNullValenceTenantTriplets + boot 逐租户 derive + 采纳钩子 + skip 带原因日志；
> 回归 15/15 + 全量 vitest 零回归。

**背景**：快照口径"15 活跃锚全部有 valence"；验证轮实测仅 9/15 有值（kfyn 的"配置项""根因"两锚为 NULL，l5ug 侧 4 个 NULL）。

**原因（第一性原理）**：valence 是 soul-feeling 段的输入（"驱动我/提醒我"），NULL 锚等于该价值的情感方向缺失——不是显示问题，是感受组装的功能性缺口。漂移机制：valence **不在锚采纳时决定**（`anchor-growth.ts:18` 注释明示"valence 落 NULL（C2 钩子自动判）"；`:248` 采纳时 `upsertValue(..., a.valence ?? undefined, "auto")` 即 NULL 落库），而是依赖 **C2 boot 时 derive**（`server.ts:2201`：`if (valenceStore?.deriveValueValences && valenceRunner)` → `deriveValueValences(undefined, valenceRunner)`，成功打 `derived=X skipped=Y`，异常才 warn）。**实证缺口：2026-09-16 12:07 重启后 journalctl 无任何 valence derive 日志**——条件不满足时完全静默，NULL 锚永远等不到补值。这是"等人操作/等人发现"型设计缺口：静默失败没有任何宣告。

**相关代码**：
- `src/gateway/server.ts:2201-2207`：boot derive 的守卫条件与静默路径
- `src/core/lifecycle/anchor-growth.ts:18,248`：采纳时 valence 落 NULL 的设计约定
- `src/gateway/core-values-discover.ts`：C2 runner 惰性构造（`getValueValenceLlmRunner`，server.ts:1109）
- `src/core/store/sqlite.ts`：`deriveValueValences` 实现与 skip 条件

**设计思路**：
1. 先实证：给 boot derive 的每个 skip 分支加**带原因的日志**（runner 缺失 / store 不支持 / 无 NULL 锚），重启一次读取真实原因——第一性原理：先让静默可见，再谈修复
2. 按实证结果修复：若 runner 缺失 → 修复构造链；若 skip 条件过严 → 放宽为"存在 NULL 锚即 derive"
3. 补手动重 derive 入口（`/values/derive` 路由已存在）兜底
4. 回归：重启后 15/15 有 valence + soul-feeling 组装覆盖全部锚

**触发条件**：现在。**量级**：~40 行。

---

### 2. 14 例预存量测试失败 · 口径还债（优先级 2 · 现在做）

> **状态（2026-09-16）：✅ 已完成**——全量 vitest 462/462 全绿，tsc 244 持平。过程中的重大发现：
> assembly/explore-relax 5 例不是断言滞后而是**真实产品回归（A2-R1）**——foldNearDuplicates 对整行
> （tag+时间+灵魂后缀）算相似度，同日异主题记忆被误折（Jaccard 0.50）；已修为内容口径。详见
> CHANGELOG「A2-R1 近重折叠剥离回归修复」与「14 例预存量测试口径还债收口」。
**背景**：全量 vitest 47 文件 453 测试中 14 例失败，分布：core-values-discover(5)、auto-recall-assembly(4)、anchor-growth(1)、auto-recall-explore-relax(1)、values-per-agent(1)、values-state(1)、recall-signals(1)。stash 对照实证为预存量（非近期改动引入），但它们使"全量回归"失去底线意义——回归基线必须是全绿才有判别力。

**原因（第一性原理）**：错误样本逐例分类后，全部是**测试断言滞后于已裁定的行为变更**，不是产品代码缺陷：
- `'0' to be '8192'`（anchor-growth）——maxTokens 覆写断言：判官/发现/身份纯文本调用解除 maxTokens 限制的行为变更有登记（2026-09-16 参数实证），测试未跟进
- `{...6} to deeply equal {...5}`（recall-signals DEFAULT_RANK_SIGNALS）——R6/R10 新信号字段加入后 spec §2 快照未更新
- `lastDiscoveryAt {...3} vs {...1}`（values-state / values-per-agent）——anchor_growth_state 形状随 per-tenant 状态扩展
- `[结论|召回专项] length 5 got 2` / `length 2 got 5` / `3 to be 2`（auto-recall-assembly / explore-relax / core-values-discover 提案数）——结论层/预算模型/分级门参数变更后断言未跟上

第一性原理：测试是裁定的机器可执行形式。裁定已登记而断言未跟进 = 裁定与证据脱节，与"文档与代码不可脱节"同构。

**相关代码**：上列 7 个测试文件；对照裁定记录（CHANGELOG 2026-09-15/16 各条）。

**设计思路**：
1. 逐例建立"断言现值 vs 裁定值"对照表——每例必须找到对应的变更登记才能改断言；找不到登记的按回归 bug 处理（改产品代码）
2. 一条 commit 收口，恢复全量 vitest 全绿作为回归底线
3. 以后排序/配置类裁定在 CHANGELOG 登记时**同步列名受影响测试**

**触发条件**：现在。**量级**：~2-4 小时（14 例，多为断言数值/形状更新）。

---

### 3. assistant 消息提取漏损实证（优先级 3 · 现在做，先观测后决定）

> **状态（2026-09-16）：✅ 观测完成，判定为随机漏损**——assistant 3 条 2/3 命中（判据不排斥 assistant），
> run2 精确复现生产 7/10 丢失集；按决策树走"批次大小/重试策略评估"而非修 prompt。基线与探针用法见
> CHANGELOG「assistant 提取漏损实证」；探针：`MemoryCore/scripts/extraction-loss-probe.mjs`。
**背景**：flowtest session-d 注入 12 条（3 条 assistant"我帮用户…"+ 9 条 user），L1 仅提取 7 条；未提取的 5 条中 3 条是 assistant 消息（咖啡参数表/马拉松复盘/观鸟清单）+ 2 条 user（颈椎操/茶馆随笔）。

**原因（第一性原理）**：提取判据（`src/core/prompts/l1-extraction.ts:34`）"提取主体必须以'用户（姓名）'或'AI'为核心"——assistant 消息主体恰是 AI，**不满足排除条件**，理论上应可提取。所以漏损不是判据排斥，而是：LLM 批次抽取的随机性 / 10 消息大批次下的归纳合并丢失 / "宁缺毋滥"倾向。漏损率若无量化，L1 完整性就是黑盒——记忆系统的"记全"是第一性承诺。

**相关代码**：
- `src/core/prompts/l1-extraction.ts:15-114`（chat 模式判据与输出契约）
- `src/core/lifecycle/` l1-extractor 批次切分逻辑（实测 12 条 → 10+2 两批）
- `src/core/prompts/l1-dedup.ts`（合并/去重路径）

**设计思路**：
1. 观测先行：对 flowtest 全量语料跑一次提取对照实验（同语料重复 N 次，统计每条消息的提取命中率），区分"随机漏损"与"系统性排除"
2. 判定：若 assistant 帮办类系统性丢失 → 修 prompt（在判据中明确"AI 为用户完成的工作成果是 AI 记忆"）+ 补 golden 用例；若随机 → 评估批次大小与重试策略
3. 产出漏损率基线登记 CHANGELOG，作为后续 prompt 改动的对照锚

**触发条件**：现在（观测），修复视观测结果。**量级**：观测脚本 ~80 行；prompt 修补视结果。

---

### 4. D2 产线替换（等标注 ≥300 + 正例 ≥50）

**背景**：九通道排序信号全部关断（golden A/B 实测降精度），根因是小语料期先验信噪比不足。校准拟合 = 用判官标注从数据学出通道权重。拟合器已建（pilot 87%）。

**原因（第一性原理）**：信噪比不足的解不是等语料变大碰运气，而是用标注数据学权重——统计有效门槛 = 标注 ≥300 + 正例 ≥50，未达门槛做拟合是过拟合 fixture 分布（过拟合 fixture 分布；且校准依赖情感/冲突信号的真实分布，P2-P4 产出，见 evolution-design §141）。

**相关代码**：
- `MemoryCore/scripts/calibrate-fit.mjs`：拟合器（逻辑回归 + 7 特征），**产线替换需扩展**：coreRefHit / channel one-hot / type one-hot
- `MemoryCore/scripts/judge-run.mjs` + `docs/superpowers/evals/judge/labels-*.jsonl`（142 条，timer 每日 04:00 积累）
- `src/core/hooks/auto-recall.ts` applyCompositeRerank（RV2-2 复合精排，关断态）
- 输出映射：逻辑回归系数 → `recall.rerankWeights` yaml（系数 ≠ 精排权重，需归一化/缩放设计）

**设计思路**：标注达标 → 扩展特征重跑 → 精度人工复核 → **预注册 A/B**（拟合权重 vs 全 0 基线，同标注池，标注固定法）→ 通过后 yaml 部署、九通道按系数逐步解禁（先高系数通道，非一次全开）→ Lane 2 回归精度 ≥ 基线。

**触发条件**：标注 ≥300（当前 142，预计 1-2 周）。**量级**：~100 行（特征扩展 + yaml 映射 + A/B 脚本）。

---

### 5. D1-P4b evolution-worker（等 conflict ≥5）

**背景**：conflict 边 = 同主题新旧记忆矛盾。不处理则新旧并存、召回自相矛盾。spec 已有完整设计（evolution-design P4 节：五条件门 + 审计边）。

**原因（第一性原理）**：错误不对称——门严 = 不触发（良性），门松 = 错误改写正文（污染难恢复）。因此 P4 严门维持，门槛 conflict ≥5 前不启动（当前 1 条，P4-GATE 旗标未宣告）。受控合并 = LLM 重写正文，是全系统唯一允许改写已固化正文的路径，必须最严门控。

**相关代码**：
- `docs/superpowers/specs/2026-09-15-memory-evolution-design.md` P4 节（五条件门 + evolved_from 审计边，设计已定稿）
- `src/core/record/l1-extractor.ts:850`：conflict 自动失效路径（`decision.target_ids` → invalidateL1）
- `src/core/lifecycle/anchor-growth.ts` self-obs 块：conflict ≥5 → `[P4-GATE]` 宣告
- `src/core/store/sqlite.ts` invalidateL1 / l1_links（evolved_from 审计边直接复用 addLink）

**设计思路**：按 spec P4 节执行，不重新设计。新增点：worker 触发挂 self-obs tick（conflict 门槛到达即宣告），失效传播复用本轮 derived_from 定位（`[P4a-P2]` 已闭环）。

**触发条件**：conflict ≥5（当前 1）。**量级**：~150 行。

---

### 6. D5 R10 A/B 执行（等情感 cohort ≥20 组）

**背景/原因**：预注册已完成（REG-R10-AB-001，判据/样本/终止条件已冻结，判官同源偏差声明 + 标注固定法 + 双口径敏感性分析已预登记）——执行期唯一禁止的是偏离预注册。

**相关代码**：
- `docs/superpowers/specs/2026-09-16-r10-ab-design.md`（预注册，判据冻结）
- `src/core/hooks/auto-recall.ts` compareLex R10 项（钩子侧）+ `src/core/tools/memory-search.ts` secondaryOf[4]（工具侧，死代码已修复可达）
- `emotionSalienceOf`（recall-signals.ts:171，|valence|×arousal 纯函数）；`emotionSalienceWeight: 0`（yaml:106，恒等位）
- 待建：`MemoryCore/scripts/r10-ab.mjs`（Lane 2 hermetic 同构 + config-override 每臂 boot）

**设计思路**：按预注册执行序——选集脚本出 cohort（queryId 升序前 20，不得挑优）→ 冻结标注快照 → A 臂基线复算 → B 臂（weight=0.3）→ 逐批判定（+5pp 通过 / 连续 3 批无差异终止 / 100 组判负）→ 报告 + CHANGELOG。

**触发条件**：情感 cohort ≥20 组。**量级**：A/B 脚本 ~50 行。

---

### 7. P4a Phase 2 逐块重蒸馏（等边覆盖成熟；前置 = 修溯源日志落盘缺口）

> **前提修正（2026-09-16 实证）**：溯源日志**一直在正常落盘**——
> `/data/tdai-memory/instances/default/memory-generation-logs/` 实测 layer=l1 622 / l2 582 / l3 10 个文件
> （自当日 06 时起每小时持续新增，schema 完整含 input_refs）。v3 原"0 文件、best-effort 静默吞错"的
> 观察不成立（疑为观察时点/路径错误）。前置缺口 ① 不存在；best-effort 失败可见性 warn 降级为可选加固
> （无失败实证，暂不实施）；缺口 ②（建边前存量块输入史不可回填）维持——重蒸馏仍等边覆盖成熟。
**背景**：层级边（derived_from）+ 沿边定位已闭环（`[P4a-P2]` 产线可见，84 条）。精确传播的最后一环"失效 → 受影响块 → 逐块重蒸馏（剔除失效内容）"按设计暂缓。

**原因（第一性原理）**：重蒸馏 = 用块的 derived_from 输入集（排除失效者）重建该块。两个前置缺口：① **溯源日志落盘为 0**——`MemoryGenerationLogStore` ROOT=`memory-generation-logs/v1`（store.ts:14），生产实际目录 `/data/tdai-memory/instances/default/memory-generation-logs/` **存在但 0 文件**（`writeGenerationProvenanceBestEffort` 静默失败，失败原因不可见）；② **存量块输入史不可回填**——建边（2026-09-16）前蒸馏的块没有边，自动重建会静默丢掉历史贡献。无 ① 则新块的边覆盖也不可信（无法审计"边是否完整"），无 ② 则重建必错——两者都满足前启用重建是错误的。

**相关代码**：
- `src/core/memory-generation-log/store.ts:14`（ROOT 常量）+ `src/core/memory-generation-log/best-effort.ts`（静默吞错点）
- `src/utils/pipeline-factory.ts:954`（L2 溯源写入调用点）、`:1118`（L3）
- `src/core/scene/scene-extractor.ts`（changedSceneFiles 权威变更集，本轮回赠能力）
- `src/core/store/sqlite.ts` getLinksByTarget（反查已就绪）

**设计思路**：
1. 先修落盘可见性：best-effort 失败从静默改为带原因 warn（一次性定位为什么 0 文件——路径拼接 / storage 权限 / 序列化异常）
2. 修好后观察新块的溯源完整性（边数 vs 溯源 input_refs 应一致——两条独立证据互证）
3. 边覆盖成熟（新块全部有边 + 溯源互证）后，实现 `redistillBlock(blockId)`：取块的有效输入集 → 复用 extractor 蒸馏 → 重写块 + 刷新边
4. 全程 config 门控（缺省关），启用需显式配置 + Lane 2 回归

**触发条件**：缺口 1 修复后观测 1-2 周。**量级**：落盘修复 ~30 行；重蒸馏 ~150 行（分期）。

---

### 8. flowtest 探针退役决策（小 · 择机）

**背景**：flowtest 租户现有 21 条 L1（a/b/c/d 四批）+ 2 个 scene block + identity v1，其中 3 条已失效。它已连续两轮充当全流程回归基线。

**原因（第一性原理）**：探针租户的价值 = 隔离的可复现测试场；成本 = 存储 + L2/身份自发现的持续 LLM 消耗。当前两者都微小。过早清理会失去回归基线；长期保留则身份自发现会继续为它消耗 LLM 调用（冷却 24h + 语料无新增才跳过——已自限）。

**相关代码**：`/data/tdai-memory/profiles/team%3Ateam-flowtest*/`（全部状态）；`l1_records WHERE agent_id='agt-flowtest'`。

**设计思路**：保留至 D2/D5 A/B 执行完毕（其 hermetic 测试可能复用该租户模式）；届时统一归档（导出 JSON + 删除租户目录）。

**触发条件**：D5 A/B 结束后。**量级**：脚本 ~30 行。

---

## 第二部分 · 明确不做的（继承 v2 判定，无新增）

| 项 | 不做理由 |
|---|---|
| 动机方向深化 | 感受段静态 valence 正确工作；上下文调制是精 refinements 非缺口 |
| 策略统一（遗忘 legacy/scorer 双兜底） | DB 实证 soul 字段零 NULL 消费者，双兜底为无害死代码 |
| TCVDB 后端实证 | 触发条件 = service-mode 部署决策，此前无验证对象 |
| router 存废 | hybrid 为产线唯一策略，拆降级路径风险大于收益 |
| Lane 1 重建 / 密度公式 / B4 proxy 注释重灌 | 已完成 / 已完成 / 不可逆信息丢失且零功能影响 |

## 第三部分 · 配置项审计结论（2026-09-16 13:30 更新，12/12 全部落地且开启）

anchorDiscovery(5 字段/enabled/minEvidence 3/maxPerPass 3/maxTotal 15/intervalHours 24) ✓【2026-09-16 验证轮修正：yaml 段此前因 server→scheduler 接线断线从未生效（产线恒跑缺省 24h/5/2），已修复并运行时实证贯通——详见 CHANGELOG「anchorDiscovery 配置接线修复」】 · durativeEnabled: true ✓ · excludeInvalidated: true ✓ · arousalRetention: 0.3 ✓ · emotionSalienceWeight: 0（实验轨红线，A/B 未过不得置正）✓ · enableDedup: true ✓ · creditReport（provider 策略承载，无双重计费路径）✓ · MEMORY_LOG_LEVEL=info（/opt/tdai/etc/env 独立行，/proc/environ 已确认）✓ · lifecycle（consolidation/forgetting/archiveBytes 40960）✓ · FTS（l1_fts/l1_records 218/218 同步 + jieba 分词检索实测）✓ · 向量（vectorCoverage=1.0，vecRows=metaRows=218，embedding ok，bm25 降级路径在位）✓ · 无 seedValues/P4P5 残留 ✓

## 执行时间线

| 优先级 | 项 | 触发 | 量级 |
|---|---|---|---|
| **1** | 锚 valence 漂移排查修复 | ✅ 已完成（2026-09-16） | ~110 行（含测试） |
| **2** | 14 例测试口径还债 | ✅ 已完成（2026-09-16，462/462 全绿） | 实际 ~3h + A2-R1 产品修复 |
| **3** | assistant 提取漏损实证 | ✅ 观测完成（判定：随机漏损，不修 prompt） | ~110 行探针 |
| 等 | D2 产线替换 | 标注 ≥300 | ~100 行 |
| 等 | P4b evolution-worker | conflict ≥5 | ~150 行 |
| 等 | D5 A/B 执行 | cohort ≥20 | ~50 行 |
| 等 | 溯源日志落盘修复 → P4a Phase 2 | ✅ 前提修正：落盘一直正常（622/582/10 文件）| 重蒸馏仍等边覆盖成熟 |
| 择机 | flowtest 探针退役 | D5 A/B 后 | ~30 行 |

> **验证轮补记（2026-09-16 下午，SOP 完整执行）**：三项改动（valence 修复 / A2-R1 / 提取漏损探针）经第一性原理复审 + 12 组新数据完整流程测试 + 配置审计对抗复核。复审修订 1 处（boot 逐租户 derive 由并发改顺序链式）；**新发现并修复 anchorDiscovery 配置接线断线**（yaml 段全程死配置）；12 组测试全项 PASS。详见 CHANGELOG「anchorDiscovery 配置接线修复 + SOP 验证轮实证」。
