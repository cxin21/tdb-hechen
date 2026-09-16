# 剩余工作 · 第一性原理分析文档 v2

> 文档标识：REG-REMAINING-002（取代 REG-REMAINING-001）
> 日期：2026-09-16
> 方法论：每项从第一性原理出发，结合真实代码与设计文档分析→判定"做/不做/等"→附实现设计
> 审计原则：自生长、自维护——凡是"等人操作"的环节都是设计缺口

---

## 已完成项索引（不再赘述）

A1-A7（召回质量+隔离+capture 租户+coreRefs 三层验证）、B1-B4（fail-loud/插桩清理/探针断言/proxy 注释 best-effort）、C1-C4（身份修订制/红线采纳/常驻注入/子 agent 三重识别）、D6（密度裁决——唯一按原则全达标项）、P4a Phase 1（bump+蒸馏排除）、SOUL Phase 1（三段组装器+身份自发现+valence+标注）、coreRefs 四路径、自维护观测（self-obs）。

---

## 第一部分 · 真正要做的（按优先级）

### 1. ✅ 层级边（L1→L2 跨层关联——P4a 精确失效传播的前置条件）——2026-09-16 完成

**背景**：记忆分层 L0(对话)→L1(记忆)→L2(场景画像)。L2 是 L1 的蒸馏缓存（scene_blocks/persona.md），但两者之间**没有显式关联边**——L2 的 scene md 不知道自己由哪些 L1 记忆蒸馏而来。

**原因（第一性原理）**：派生缓存的失效传播需要知道"源变更影响哪些缓存条目"。当前 P4a 的实现（bump updated_time + L2 过滤）是**钝刀**：失效记忆 bump 后触发 L2 重跑，L2 过滤失效后重蒸馏——但**无法精确定位"哪个 scene_block 由哪些失效记忆贡献"**，只能全量重跑受影响 session 的全部 scene。层级边（L1 记录 → L2 scene_block 的 derived_from 关联）是精确失效传播的前置条件——有了边，失效一条 L1 → 沿边找到受影响的 scene_block → 只重蒸馏那些块。此外：层级边使"这段 persona 特质由哪些记忆塑造"可追溯（身世透明），也是结构化召回（structure-aware-recall 设计）的数据基础。

**相关代码**：
- `l1_links` 表：`source_id, target_id, type, strength, created_at`——现有类型 similar(244)/evolve(13)/conflict(1)，**无跨层类型**
- 写入点：`sqlite.ts:1676 addLink(sourceId, targetId, type, strength)`——通用边写入，可直接用
- L2 提取输入：`pipeline-factory.ts:743 queryMemoryRecords(...)` 返回 `MemoryRecord[]`（含 record_id ✓）——**提取时知道输入是哪些 L1 记录**
- scene_blocks 存储：`src/core/scene/`（governor 管理 md 生命周期），存储为 `dataDir/scene_blocks/{scene_name}.md`

**设计思路**：
1. 新边类型 `derived_from`：L2 提取完成时，为每个 scene md 写入 `addLink(scene_block_id, l1_record_id, "derived_from", 1.0)`——L2 提取流程已知输入记录集（queryMemoryRecords 返回 ✓），在 scene md 写入后逐条建边
2. scene_block_id：scene md 无 record_id——用 `{scene_name}:{sessionKey}` 作为边的 source 端（或给 scene md 分配稳定 id 并存 metadata）
3. 失效传播精确化（P4a Phase 2）：`invalidateL1(id)` → `queryL1Links(id, "derived_from")` → 受影响 scene_block 集合 → 逐块触发重蒸馏 → 重蒸馏后更新边（新 L1 集合的 derived_from 重写）
4. 查询接口：`getLinksByTarget(targetId, type)` 沿边反查——store 现有 getNeighbors 按边查询可复用

**前置条件**：无（l1_links 表和 addLink 已存在）
**量级**：~60 行（边写入 + 反查 + 失效传播重写）

> **✅ 实施记录（2026-09-16）**
> - source 端用 `profile.id`（`profile:v1:sha256(scope|type|filename)`）而非设计思路 2 的
>   `{scene_name}:{sessionKey}`——现有稳定 id 已租户唯一，免自造 id 与跨租户同名碰撞。
> - **边只增不重写**（修正设计思路 3 的"重蒸馏后重写边"）：增量蒸馏语义下 scene block
>   是累积蒸馏，边语义 = "曾贡献"，重写会丢史。
> - **P4a-2 混合窗口缺口修正**：审查发现失效排除只挡"全失效早退"，混合窗口下失效记录
>   仍混入提取 prompt——现按组过滤蒸馏输入（cursor 仍取全窗口，无重查询循环）。
> - **逐块自动重蒸馏暂缓**：生产 generation-logs 实测 0 份，存量块输入史不可回填，
>   自动重建会静默丢掉建边前贡献——精确失效传播本步交付"沿边定位 + `[P4a-P2]` 宣告"，
>   重蒸馏等边覆盖成熟（P4a Phase 2）。
> - 验证：tsc 244 持平；新增 5 测试全绿；既有失败集与 stash 基线逐位一致（零回归）。

---

### 2. ✅ 身份采纳门第二轮（当前身份内容仍含软性状态残留的持续治理）——2026-09-16 完成

**背景**：身份槽三轮出现状态污染（P1-P3 落地 / 当前进行中：A6 / 当前进行中：D2）。第一轮修复 = prompt 状态禁令（软约束）→ 失效；第二轮 = prompt 硬化 + 人工清洗 → 短期有效但 LLM 修订可能复发。当前 identity v4 内容干净（人工清洗版）。

**原因（第一性原理）**：身份槽的语料源充满状态记忆（本项目会话的记忆 80% 是进度陈述），LLM 从状态密集语料合成身份时自然夹带状态——**prompt 判据是在跟语料的统计惯性对抗，软约束注定间歇失效**。原则性修复 = 采纳门的**代码级执行**（已部署：状态模式剥离），但当前模式列表（进行中/截至/已全部落地/进入观察期）是**枚举式的**——LLM 会发明新的状态表述绕过枚举。

**相关代码**：
- `identity-discovery.ts`：身份采纳门（已部署：状态模式剥离 + 空内容拒收）
- 修订入口：`core-memory/write` API（source=identity-discovery）
- 采纳后内容：core_memory 表 identity slot v4

**设计思路（第二轮）**：
1. 从**枚举模式**升级为**结构校验**：身份内容中**禁止出现日期引用**（如"2026-09-15""P1-P3"——数字+连字符/字母组合是状态的标志），正则 `/\d{4}[-年]\d{0,2}|P\d/` 命中 → 剥离该句
2. 保留白名单语义：身份只允许**角色/职责/关系/纪律**四类——可在 prompt 中给出这四类的正例（当前已有）
3. 人工清洗保持为最后兜底（Panel 或 API）
4. **不追求完美**：状态污染的偶尔复发由人工清洗兜底即可——身份槽是单行内容，清洗成本 30 秒

**前置条件**：无
**量级**：~10 行（正则扩展）

> **✅ 实施记录（2026-09-16）**
> - 结构判据按设计落地：`\d{4}[-年]\d{0,2}`（日期引用）+ `P\d`（阶段编号）命中 →
>   剥离所在句；枚举剥离保留为句内第一道。
> - 剥离链收敛为单一源导出函数 `stripIdentityStateResidue`（可测试）；整条提案全为
>   状态陈述 → 拒收 + 留痕日志。
> - **切分先于枚举**（实施实测发现）：枚举 `[。；]?` 吞句界导致相邻干净句被并入
>   状态句过度剥离——修正为切分 → 逐句枚举 → 结构判据。
> - 测试 7 例全绿；tsc 244 持平。

---

### 3. D2 产线替换（判官标注 ≥300 后）

**背景**：D2 校准拟合器已建（`scripts/calibrate-fit.mjs`，pilot 模式 87% 精度），判官标注池 142 条自动积累中（tdai-judge.timer 每日 04:00）。

**原因（第一性原理）**：九通道排序信号全部关断（golden A/B 实测降精度），原因是**小语料期先验信噪比不足**。校准拟合 = 用标注数据**从数据中学习**通道权重而非人工拍定——这是"信噪比不足"的第一性原理解（不是等信噪比变好，而是用数据学出权重）。统计有效门槛 = 标注池 ≥300 + 正例 ≥50。

**相关代码**：
- `scripts/calibrate-fit.mjs`：拟合器（逻辑回归 + 7 特征 + 试跑模式）——**产线替换需扩展**：
  - 特征扩展：coreRefHit（价值锚命中）、channel one-hot、type one-hot——当前 7 特征是子集
  - 输出映射：拟合系数 → `recall.rerankWeights` yaml 格式（RV2-2 复合精排的权重结构）——映射关系需设计（逻辑回归系数 ≠ 精排权重，需要归一化/缩放）
  - 验证：拟合后权重 → Lane 2 重跑 → 精度对比（before/after A/B）
- 判官标注池：`docs/superpowers/evals/judge/labels-*.jsonl`（自动积累）
- 精排消费：`auto-recall.ts` applyCompositeRerank（RV2-2，关断态）

**设计思路**：
1. 标注 ≥300 后：重跑拟合器（扩展特征）→ 精度复核 → 人工确认合理性
2. 产出 yaml 权重 → **预注册 A/B**（拟合权重 vs 全 0 基线，同标注池）→ 通过后部署
3. 九通道按权重逐步解禁（先高系数通道）——不是一次性全开
4. 验收：Lane 2 重跑精度 ≥ 基线（全 0）+ 人工抽查注入排序合理

**触发条件**：标注池 ≥300（tdai-judge.timer 自动积累，预计 1-2 周）
**量级**：~100 行（特征扩展 + yaml 映射 + A/B 脚本）

---

### 4. D1-P4b evolution-worker（conflict 门槛到达后）

**背景**：conflict 边（记忆演化冲突）当前仅 1 条。P4b = 当 conflict 积累到阈值后，启动 evolution-worker 对冲突记忆做受控合并重写。

**原因（第一性原理）**：记忆演化冲突 = 同一主题的新旧记忆矛盾。不处理则新旧并存（召回时矛盾信息）。处理方式 = 受控合并（LLM 重写 + 旧记忆失效 + 审计边）。门槛 = conflict 边 ≥5（self-obs 旗标自动宣告）——太少的 conflict 不值得 LLM 成本。

**相关代码**：
- conflict 边：`l1_links WHERE type='conflict'`（当前 1 条，dedup conflict 路径写入）
- self-obs 旗标：`anchor-growth.ts` self-obs 块（conflict ≥5 → `[P4-GATE]` 日志宣告）
- evolution spec：`2026-09-15-memory-evolution-design.md` P4 节（五条件门 + 审计边设计已有）

**设计思路**：spec 已有完整设计（五条件门 + evolved_from 审计边），实现按 spec 执行即可。新增：self-obs 旗标到达时在日志中**主动提醒**（当前已实现）。

**触发条件**：conflict 边 ≥5（self-obs 自动宣告）
**量级**：~150 行（按 spec P4 节）

---

### 5. ✅ D5 R10 A/B 预注册文档（可提前写好等数据）——2026-09-16 完成

**背景**：R10 情感显著度检索加权——compareLex 双链已部署（weight=0 恒等门），significance 门槛收紧后 coreRefs 精度 75%→待复验。A/B 载体 = D3 判官标注池。

**原因（第一性原理）**：情感记忆检索 = 差异化能力（情感记忆 vs 中性记忆的检索优先级应不同）——当前空白区（2026 文献综述确认）。预注册 = 实验前锁定判据/样本量/终止条件（防 p-hacking / 事后合理化）。

**相关代码**：
- R10 门控：`auto-recall.ts:1587-1611`（compareLex R10 项，emotionWeight > 0 才激活）
- 权重门：`recall-signals.ts:66 emotionSalienceWeight: 0`（恒等位）
- A/B 载体：判官标注池（142+，自动积累）

**设计思路（预注册文档内容）**：
1. 假设：emotionSalienceWeight > 0 时，情感记忆的检索精度（判官 rel≥2 的 P@5）提升
2. A/B：同查询集，weight=0 vs weight=0.3（MEMORY_R10_ABILITY_WEIGHT 环境变量切换），同标注池评判
3. 样本量：情感触动的查询 ≥20 组（从判官标注池筛选情感相关 intent）
4. 终止条件：精度提升 ≥5% 或连续 3 组无差异 → 结束
5. 通过 → emotionSalienceWeight 默认值从 0 改为实验值 + Lane 2 全量回归

**触发条件**：判官标注池 ≥100 条含情感 intent 的标注
**量级**：文档 1 份 + A/B 脚本 ~50 行

> **✅ 实施记录（2026-09-16）**：预注册文档 `docs/superpowers/specs/2026-09-16-r10-ab-design.md`
> （REG-R10-AB-001）已入库——假设/P@5 判据/选集规则/终止条件/防 p-hacking 纪律冻结。
> 两处登记修订：① "MEMORY_R10_ABILITY_WEIGHT 环境变量" 实测代码不存在，A/B 切换以
> config-override.json 每臂独立 boot（Lane 2 hermetic 同构）为准；② 工具侧 secondaryOf
> 第 5 元比较原为不可达死代码（位于无条件 return 之后）——已修复（weight=0 行为逐位
> 不变），A/B 才能覆盖双链。

---

## 第二部分 · 明确不做的（附理由）

| 项 | 来源 | 不做理由 |
|---|---|---|
| 动机方向深化 | backlog #3 | 感受段已用静态 valence 正确工作；上下文调制是精 refinements 非缺口——等产线反馈真实需求 |
| 策略统一（遗忘 legacy/scorer 双兜底） | backlog #6 | DB 实证 soul 字段 153/153 零 NULL——legacy 路径无消费者，双兜底为死代码可留（无害） |
| TCVDB 后端实证 | backlog #4 | 当前部署 = standalone/sqlite；TCVDB 仅 service-mode 使用——**触发条件 = service-mode 部署决策**，此前验证无对象 |
| router 存废 | backlog #5 | hybrid 已为产线唯一策略，keyword/embedding 仅降级路径——router 简化 = 拆除降级路径，风险大于收益 |
| Lane 1 重建 | 原 D4 | ✅ 并入 D3（判官标注即相关性标注） |
| 密度公式 | 原 D6 | ✅ 完成（绝对证据+饱和） |
| B4 proxy 注释完整重灌 | 升级后定案 | 343 行不可逆信息丢失，需原始源文件（本地已失）——零功能影响 |

---

## 第三部分 · 配置项审计结论

当前全部配置项已完成且开启（历轮审计 6/6 + 零残留多轮确认）：
- `anchorDiscovery`(5字段/maxPerPass=3) ✓ · `durativeEnabled: true` ✓ · `excludeInvalidated: true` ✓ · `arousalRetention: 0.3` ✓ · `emotionSalienceWeight: 0`（实验轨红线）✓ · `enableDedup: true` ✓ · `creditReport: false` ✓ · 无 seedValues/P4P5 残留 ✓
- **SOUL 无新增配置段**（复用 anchorDiscovery）✓ · **判官无配置段**（scripts + systemd timer）✓

---

## 执行时间线

| 优先级 | 项 | 触发 | 预计 |
|---|---|---|---|
| **1** | ✅ 层级边 | 现在（P4a 精确传播的前置）——2026-09-16 完成 | ~60 行 |
| **2** | ✅ 身份门第二轮 | 现在（持续治理）——2026-09-16 完成 | ~10 行 |
| **3** | ✅ D5 预注册文档 | 现在（防 p-hacking 纪律）——2026-09-16 完成 | 文档 |
| 等待 | D2 产线替换 | 标注 ≥300 | timer 自动积累中 |
| 等待 | D1-P4b | conflict ≥5（self-obs 旗标） | 等数据 |
| 等待 | D5 A/B 执行 | 标注池情感标注 ≥20 组 | 等 D3 |
| 等待 | D7 | 大语料 | 性能可感时 |
