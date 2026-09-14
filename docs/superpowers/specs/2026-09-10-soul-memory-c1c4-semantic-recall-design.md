# 灵魂记忆 · 第三档首批设计：coreRef × 动机方向 × router 退役 × 策略统一

> 文档标识：DS-SOUL-MEMORY-C1C4-001
> 版本：v1.0-draft（待拍板两处 → 收敛后落 writing-plans）
> 日期：2026-09-10
> 输入：`2026-09-10-soul-memory-next-round-backlog.md`（第三档六件，用户拍板：coreRef 做/层级边不建物理边/动机轻量版/TCVDB 不实现/router 默认关/策略统一）+ **用户新约束："要考虑记忆查询和召回逻辑的修改"——本设计将召回逻辑影响作为一等交付物（§1 影响矩阵）**

---

## 0. 摘要

四个改动，一条主线：**让"价值"成为记忆系统里可流动的信号**——写入时标注（coreRef）、召回时被看见（排序加成+展示标注）、遗忘时受保护（salience 优先读）、每轮被感受（动机方向）。同时把一个已被实验证伪的机制（router）退出生产路径。

---

## 1. 召回逻辑影响矩阵（一等交付物，回应用户约束）

> 四层模型：**检索**（向量/FTS 打分+绝对门槛）→ **排序**（融合分+轻度 tiebreak）→ **展示**（片段组装+标注）→ **遗忘**（反向的"召回"，打分决定归档）。
> 设计纪律：**检索层的打分与门槛语义保持不变**（绝对门槛是"宁缺毋滥"的根基，动它=动红线）；价值信号只在**排序/展示/遗忘**三层生效。

| 改动 | 检索层 | 排序层 | 展示层 | 遗忘层 |
|---|---|---|---|---|
| **C1 coreRef 写入** | 无 | 无 | 无 | 无（纯写入） |
| **C1 coreRef 召回消费** | **不动**（门槛语义不变） | ✅ executeMemorySearch 排序加成：query 的 appraisal 命中价值 V ∧ 记忆 metadata.coreRefs 含 V → `+0.05`（与 priority*1e-6 同族的轻度 tiebreak，可配） | ✅ formatSearchResponse 片段行加 `·触[价值]` 尾注（复用 `·soul[…]` 模式） | ✅ salienceBoost 优先读 coreRefs，子串匹配降为兜底（K-B5 缓解） |
| **C2 动机方向** | 无 | 无 | ✅ current_feeling 块增"方向"行（三态短语） | 无 |
| **C3 router 默认关** | ✅ 移除一个 boost 源（**检索竞争面缩小**——这正是目的：router 的 boost 会抬高池 max 压低他库，W4 耦合） | RRF 融合少一项 | 注入块少 router 相关扰动 | 无 |
| **C4 策略统一** | 无 | 无 | 无 | ✅ summarizer significance 双兜底（与 scorer 一致） |

**影响矩阵结论**：检索层唯一的变化是 C3 **移除**一个 boost 源（回归到更干净的竞争面）；其余全部变化发生在排序/展示/遗忘三层——**绝对门槛语义零改动**。

---

## 2. C1 · coreRef（记忆→价值锚引用）

### 2.1 写入
- **载体**：`metadata.coreRefs: string[]`（不加列——数组不适合 SQLite 列；T17.5 修复后 metadata_json 全链真实可达）
- **判定点**：dedup LLM 调用顺带输出（与 T17 subject 同款顺风车，零额外调用）：prompt 注入**当前租户价值锚候选清单**（`store.listValues(tenant)`，identity 从 traceContext 可得），LLM 对每条记忆输出 `coreRefs: ["正确","可靠"]`（只能从候选清单选，**仅明显触动时标注，无命中给空**——宁缺毋滥防假阳性）
- **解析**：`DedupDecision` 增 `coreRefs?: string[]` → extractor attach 到 `memoryWithId.metadata.coreRefs`（**防御**：过滤掉不在候选清单里的 value_id——防 LLM 幻觉 id，P-D）
- **存储**：writeMemory metadata 透传（既有行为）；无 coreRefs 的记忆不写该键

### 2.2 召回消费（§1 矩阵 C1 行的落地）
- **排序加成**：`memory-search.ts` executeMemorySearch 排序处（现有 `score + priority*1e-6` 旁）：
  ```
  coreRefBoost = appraisal 命中价值 V ∧ r.metadata?.coreRefs?.includes(V) ? 0.05 : 0
  rankKey = score + priority*1e-6 + coreRefBoost
  ```
  - appraisal 复用 MemoryCore 侧既有 `appraisal.ts`（forgetting 已在用），values 从 `store.listValues(isolation)` 取
  - 可配：`memory.recall.coreRefBoost`（默认 0.05，0=关闭）
  - **适用范围**：executeMemorySearch 咽喉（tdai_memory_search 工具 + atomic/search HTTP 两路生效）；auto-recall 注入排序**不动**（RRF 语义独立，动它风险大——登记为后续可选项）
- **展示标注**：formatSearchResponse 片段行追加 `·触[正确,可靠]`（有 coreRefs 且与 appraisal 命中交集非空时才显示——**不是所有 coreRefs 都显示**，只显示"本轮相关"的，宁缺毋滥）
- **遗忘消费**：`forgetting-worker`/scorer 的 salienceBoost 判定改为：`metadata.coreRefs ∩ 当前 fired values` 命中 → boost；子串匹配降为 coreRefs 缺失时的兜底（B5 缓解）

### 2.3 边界
- 无 coreRefs 的记忆（存量+LLM 未标注）→ 全部旧路径，零影响
- LLM 幻觉 value_id → 入库前过滤，不留脏数据
- 不改检索打分——coreRef 不参与向量/FTS 语义

---

## 3. C2 · 动机方向（LLM 总结初值 + 用户微调，v2 修订——用户拍板 2026-09-10）

### 3.1 数据来源修订（v1 的"团队手配 valence"被用户否决：不想手配，要 LLM 自己总结，且支持微调）
`core_values` 表加 `valence REAL`（**可空**，NULL=未判定；幂等 ALTER，T12 模式）：+1=趋近推进、-1=审慎回避、0=中性。
**三方语义（优先级从高到低）**：
1. **用户微调**：S1 的 values/upsert API 增可选 `valence` 参数（clamp 三值）——显式微调永远优先，LLM 永不覆盖非 NULL 值
2. **LLM 总结初值**：对 `valence IS NULL` 的价值锚，一次 LLM 批量判定（三值枚举 + 不确定给 0——宁缺毋滥），写回。判定的是**该价值的语义倾向**（"正确"→趋近类），不是情绪——渲染措辞保持陈述性
3. **重判入口**：`/v3/core-memory/values/derive`（POST，无 body）——微调错了想重置：置 NULL → LLM 重判

### 3.2 判定钩子（触发可达性）
- server.ts 种子灌入后 fire-and-forget 判一次（生产 6 值首次获得方向）
- values/upsert **新建** value 后 fire-and-forget 判一次（只判新建行）
- LLM 不可用 → 安静跳过 + warn（R3：值保持 NULL，渲染侧不输出方向——降级可见且无害）
- 拒绝的方案（v1）：团队手配——用户明确否决；每轮 LLM 判——贵且不可同形验证

### 3.3 渲染（不变）
`current-feeling.ts` renderCurrentFeeling 增一行（仅 fired 且 valence 非 NULL 非 0）：
- valence>0 → `本轮方向：围绕【正确、可靠】推进`
- valence<0 → `本轮方向：对【风险】保持审慎`
- 混合（同时命中正负）→ 两行并列（不合成，不假装权衡过）
- 全 0 / NULL / 未命中 → 不输出（宁缺毋滥，现状保留）

### 3.4 边界
- 不做"影响工具选择/回答结构"的重机制（无法同形验证，且越过功能性诚实边界）——登记为非目标
- LLM 判定的主观性收敛为：三值枚举 + NULL 兜底 + 用户微调覆盖——主观性被限制为"可修正的初值"
- D1 兜底：valence NULL → 不输出方向行（升级即兼容）

---

## 4. C3 · router 默认关

### 4.1 依据（T19+20 隔离实验）
router 对 posRecall 贡献=0（部署工作点），negInjected 恒 +2；其 boost 经"归一化池"耦合会压低他库 normScore（W4）。

### 4.2 修法
- `MemoryProxy` `injection/index.ts` 默认值 `domainRouter.enabled: false`（能力保留，配置可重开）
- `config.yaml` domainRouter 段显式 `enabled: false` + 注释（"2026-09-10 隔离实验：recall 贡献 0、噪音 +2，默认退役；重开前须归档实验"）
- **前置动作**：翻默认**之前**，先用 replay 归档一份 `router-off @ 部署参数（tw09/rel0.6）` 锚点（预期 ≈0.66，与 router-on 对比入 README）——归因纪律：数字先留档再翻开关

### 4.3 登记项
- W4（boost→归一→门耦合）随 router 退役自然消失；重开 router 前须先解耦（独立任务）
- 负例词表扩充（I-3）登记待办，不塞本批

---

## 5. C4 · 策略统一

`summarizer.ts` significance 计算增 metadata 兜底（与 scorer.ts:35-47 双兜底一致）：顶层 `significance` → `metadata.significance` → 半数规则 0.5。spec §6.4 对应条目更新为"已统一"。

---

## 6. 顺序 / 回归 / 风险

| 序 | 任务 | 规模 | 回归焦点 |
|---|---|---|---|
| C4 | 策略统一（一行+断言） | 最小 | verify-p3-t17/t18 |
| C1 | coreRef 全链 | ≈T17 体量 | **召回回归**：formatSearchResponse 标注/排序断言、p0 全量、T2 门互作（coreRefBoost 在门后，不破坏绝对门槛） |
| C2 | valence 列+渲染 | 中 | core_values 迁移幂等、injector 测试、T12 租户键 |
| C3 | router 默认关+锚点 | 小 | replay 四配置重跑归档、结构页排尾不回归 |

- 全部落地后**收口重启**（网关+Proxy）并做生产冒烟（values API/appraisal 排序/注入块三态）
- 风险：C1 的 LLM coreRefs 服从率（上线观察，解析侧最坏降级安全——与 T17 同款）；C3 翻默认后 negInjected 应降 2（归档验证）

## 7. 拍板记录（2026-09-10 用户拍板"全按推荐"+ C2 修订）
1. **C1 排序加成范围**：仅 executeMemorySearch 咽喉；auto-recall 注入排序不动（登记后续可选项）✅
2. **C2 数据源（修订）**：valence 列保留，但初值由 **LLM 批量总结**（非团队手配），用户经 upsert API 微调、经 /values/derive 重判 ✅（见 §3 v2）

---

---

*收敛后按 writing-plans 落 bite-size 计划；执行沿用 Subagent-Driven + 推理验证先行纪律。*
