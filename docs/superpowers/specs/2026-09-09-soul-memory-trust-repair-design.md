# 灵魂记忆系统 · 可信性修复设计（第五轮审查收敛）

> 文档标识：DS-SOUL-MEMORY-TRUST-REPAIR-001
> 版本：v1.0-draft（待评审 → 收敛后落 writing-plans）
> 作者 / 日期：hechenk 团队 · 2026-09-09
> 输入：`reviews/2026-09-09-soul-memory-fifth-round-audit.md`（第五轮六路对抗审查，问题编号 W1/E1/E2/H-B*/G*/K*/W* 沿用该报告）
> 定位：本设计**不做新功能**。从第一性原理回答一个问题：为什么五轮"修复+审查"循环后，系统仍在"静默失效"里打转——并给出让"可信"成为结构属性而非审查运气的设计。

---

## 0. 第一性原理：从一个问题开始

五轮审查，每轮都发现"上一轮声称已修的东西其实没生效"（A2→恒0.5、B1→恒1、FTS透传→恒undefined、E2E过→生产0边）。如果每轮都能抓到，为什么修不完？

**因为修复一直针对症状（某个字段没拷、某个门没接），而病根是一个结构性缺陷的五次变体。** 把 16+ 个 high+ 问题按因果聚类，只会收敛到 **6 个根因模式**。修症状是 O(n) 的无穷级数，修根因是 O(6) 的封闭集——这就是本设计的出发点。

---

## 1. 六个根因模式（全部 high+ 问题的因果聚类）

| 模式 | 一句话病根 | 变体（问题号） | 共同机制 |
|---|---|---|---|
| **R1 · 副本各自解释** | 事实（soul 8 字段）只在 l1_records 定义一处，但 FTS 虚表、atomic/update、召回 item、scheduler 派生各自持有一份**不完整的手抄副本**，抄漏的字段恒 undefined | W1、E1、H-B5、（历史：二轮 A2） | 每新增一个消费端就人工重抄一遍字段清单，漏抄=静默 undefined |
| **R2 · 守卫定义了没接线** | 防线函数存在且正确（isObservable/escapeXmlTags/isolation filter/apiKey 校验），但**调用点的接线处没调它**——防线在仓库里，不在门口 | H-B3、K2、G2、H-B2、K1 | 守卫是可选参数（`?.`/`??`）或纯函数，"没传=没防"，类型系统不报错 |
| **R3 · 降级不可见** | 每个依赖故障都走 best-effort 静默降级（return []/skip/兜底默认值），**没有任何信号告诉运维"你正在看残废系统"** | G1、W1b③、W5、H-B7、K3 | 降级是 debug 级日志；健康检查只测"对象存在"不测"功能活着" |
| **R4 · 常量伪造真值** | 拿不到真值时塞一个"看起来合理"的常量（0.8/0.5 强度、significance 恒 0.8、结构页 score 1.0），**数据失去了与现实的联系但格式完全合法** | G5、K6/H-B8、W5、H-B8 | 常量让下游计算"能跑"，把失真从写入传播到 UI/画像/遗忘 |
| **R5 · 验证形状失配** | verify 断言用手工 fixture（自带生产不带的结构），测试绿≠生产对——**测试验证了实现的形状，没验证实现的意图** | H-B1、W1、二轮 A2、E2E-vs-生产 | fixture 与生产数据流没有共享定义，漂移无告警 |
| **R6 · 归因无复现锚** | 评测记录只有汇总数字，不归档逐 query 原始输出/语料快照；脚本与被测行为分叉（router 键名） | W1b①②、W6、W7 | "当时对"不可复核，语料漂移后数字失效且无人知道 |

**校验这个聚类**：拿任意一个 high+ 问题问"它属于哪个模式、修掉模式后它还会复发吗"——W1 修 R1（FTS 列从单一源生成）后，未来加 certainty 列不会再漏；G1 修 R3 后，向量覆盖率掉到阈值下会告警而不是静默。**聚类通过反事实检验。**

---

## 2. 设计原则（从根因推导，非从偏好推导）

每条原则都标注它杀死哪个根因模式：

| # | 原则 | 杀死 | 具体含义 |
|---|---|---|---|
| **P-A 单一事实源** | R1 | soul 8 字段**只在 `l1_records` 定义一次**。FTS 虚表列由 DDL 迁移脚本从同一常量数组生成；所有读取端（FTS/handler/召回映射）的字段清单 `import` 同一个 `SOUL_COLUMNS` 常量——**新增字段只改一处，编译期强制所有消费端跟进** |
| **P-B 守卫在咽喉** | R2 | 守卫不放调用方自觉调用，放**数据流唯一咽喉**处强制执行：H 的 observed 门放 `sourceMemories`（进组的唯一入口）、C 的 observed 门放 `executeMemorySearch` 触发点、core 的消毒放 handler 写入路径（唯一写口）。咽喉处守卫**不可选**（非 `?.`），守卫失败=拒绝执行而非跳过 |
| **P-C 降级必须喊疼** | R3 | 每个 best-effort 降级点配三件套：**计数器**（degradedCount 暴露 /health）、**warn 级日志**（一次降级一条，非每 tick 刷屏）、**注入块降级标注**（`[degraded: fts-only]` 让 LLM 和人都能看见）。健康检查从"对象存在"升级为"功能探活"（/health 主动 embed 一个探针词、写一条探针向量） |
| **P-D 拒绝伪造真值** | R4 | 拿不到真值时**宁缺毋滥**：边强度拿不到真 cosine → **不建边**（而不是建 0.8 假边）；durative significance 拿不到组内真 max → 用真实计算值（组内顶层 significance max，无值则显式中性 0.5 并注明）；结构页无向量 → **不参与排序竞争**（单列尾部+标注）。常量兜底只允许出现在"确知语义等价"处（如 conflict 边 strength=1 表"关系存在"） |
| **P-E 验证同形** | R5 | 每条 verify 断言的数据必须**从生产同一条数据流走出来**：测 reconsolidation 就真的调 executeMemorySearch（而不是手工拼 record 喂 scoreFor）；测 FTS soul 就真的走 searchL1Fts 返回形状。fixture 共享生产类型定义（`MemorySearchResultItem` 直接 import），类型加字段而 fixture 没跟=编译报错 |
| **P-F 归因留锚** | R6 | 每次评测跑归档三件套：逐 query 原始命中 JSON、语料版本标识（git sha 或内容 sha256 汇总）、脚本版本。数字不可复现时，锚点能定位"是语料变了还是代码变了"。harness 与生产的键名/路由共享常量 |

**兼容性自查**：六原则与既有纪律（宁缺毋滥、最小侵入、config-first、如实登记、无据不改）零冲突——P-D 就是宁缺毋滥在数据层的应用，P-A/P-E 是"实证校验"的工程化，P-F 是"可追溯执念"的评测版。

---

## 3. 修复工作流（六阶段，每阶段一个 commit 收口）

> 阶段顺序 = 数据流顺序（写入→读取→边界→可观测→验证）。每阶段给出：目标 / 改动面 / 验收（P-E 同形验证）/ 回滚。依赖关系：P0 与 P1 无相互依赖可并行；P2 依赖 P0（守卫改造基于已正确的数据）；P3 依赖 P1（可观测需要 FTS 列先补齐才有完整信号）；P4 依赖前三（锚点记录的是修复后的行为）。

### 阶段一 · P0 数据正确性（4 个一行级修复，R1+R2 局部止血）

**目标**：堵住"正在发生的"数据损坏。改动面最小（合计 <20 行），可一天内完成并真机验证。

| 任务 | 修法 | 验收（同形验证） |
|---|---|---|
| T1.1 堵 H 洗白（H-B3） | `consolidation-worker.ts` `sourceMemories` 加 `.filter(isObservable)`（函数已存在，接上即可） | **同形**：写 1 条 inferred+2 条同前缀 observed → 跑 runConsolidation → 断言不产持续态；inferred 不出现在任何 LLM prompt 输入 |
| T1.2 堵 C 侧 FTS 绕过（E2） | `memory-search.ts:421` `if ((r as {certainty?}).certainty !== "observed") continue;` | **同形**：经 searchL1Fts 召回 inferred 记忆 → 断言 recall_count 不更新（先构造 FTS 可命中的 inferred 行） |
| T1.3 堵编辑失忆（E1） | `handleAtomicUpdate` updated 构造补拷 soul 8 字段（从 existing 行读，null 透传 null 不造默认） | **同形**：经 /v3/atomic/update 改 content → 断言 8 列原值保留；age 继续可算（scorer 读回非空） |
| T1.4 堵 recall_count 恒 1（H-B1） | 方案 a（首选）：改 SQL 自增 `metadata_json = json_set(metadata_json, '$.recall_count', COALESCE(json_extract(...)+?...))`——原子且不依赖读回；方案 b：item 带 metadata_json。选 a | **同形**：连续调 executeMemorySearch 3 次 → 断言 recall_count=3、boost 达 min(3,5)*0.02=0.06（在 scoreFor 真链路上验证，非手工 fixture） |

**commit**：`fix(memory): P0 数据正确性四连修 — H洗白门/C侧FTS绕过/编辑soul保留/recall_count自增`（附 T1.1-T1.4 同形验证脚本）

### 阶段二 · P1 FTS/图数据链（R1 主修 + R4 局部）

**目标**：让 soul 字段全通道可用、边强度回归真实。FTS 列补齐按 P-A 单一源方式做。

| 任务 | 修法 | 验收 |
|---|---|---|
| T2.1 FTS soul 列（W1） | ① `SOUL_COLUMNS` 常量数组（8 字段名+类型+默认）；② `l1_fts` 迁移：建新虚表（列=现 17 列+SOUL_COLUMNS 展开）+ `INSERT INTO new SELECT ..., 旧列回填` + rename（FTS5 虚表不可 ALTER，只能重建）；③ `stmtL1FtsInsert`/`stmtL1FtsSearch`/`FtsSearchResult` 字段清单全部 import 常量展开；④ 写入端 upsert 补传 8 值 | **同形**：写中文记忆（含 soul 值）→ searchL1Fts 命中 → 断言 8 字段与写入值逐项相等；J 时间窗对 FTS 命中真实过滤（"上周"query 只回窗内）；旧数据回填后存量可标注 |
| T2.2 restoreL1 分词修复（H-B9） | `sqlite.ts:1680` 传 `tokenizeForFts(d.content)` 与写入侧同一函数 | 同形：归档→restore→FTS 搜关键词命中恢复行 |
| T2.3 边强度真实化（G5） | `CandidateMatch` 增 `topScore?` 字段；findCandidatesByVector 映射时带上真 cosine；attachTopCandidates：有真分→clamp 透传；无真分（FTS）→ **不附 top_candidate**（P-D：宁缺毋滥，FTS 分不可比就不建）；merge→similar 边强度同改 | **同形**：向量路径建边断言 strength≈预期 cosine（±1e-6）；FTS-only 路径断言**不产生**假强度边；生产现有 0.8 假边出清理脚本（一次性，记录数量） |
| T2.4 同批互建过滤（G4） | storeAllDirectly 维护同批 recordId 集合，top-1 搜索后排除 | 同形：同批 3 条相似新记忆 → 断言互不建边、top-1 落在批外旧记忆 |

**commit**：`fix(memory): P1 FTS soul 单一源 + 边强度真实化（SOUL_COLUMNS 常量 + FTS 虚表重建 + 假边清理）`
**风险**：FTS 重建是重操作——迁移脚本必须先 `dryRun` 打印行数/耗时，生产执行放窗口期；建表失败自动回滚 rename。

### 阶段三 · P2 信任边界（R2 主修）

**目标**：防线从"仓库里"搬进"门口"。全部是接线改动+一次 DDL 加列。

| 任务 | 修法 | 验收 |
|---|---|---|
| T3.1 core 消毒接线（K2） | `escapeXmlTags` 边界标签常量加入 `core_memory/identity/strict_rule/core_value`；**并在 handler 写入路径调用**（守卫在咽喉：写入口消毒一次，读取端天然安全） | 同形：写入含 `</core_memory>` 的 slot 内容 → 读回被转义；注入器渲染后块边界未被提前闭合 |
| T3.2 core 租户化（K1） | core_memory/core_values 加 `team_id/user_id/agent_id` 列（幂等 ALTER + 迁移默认值=现单租户值）；handler 从 requestIsolation 取四元组过滤；读接口按租户过滤 | 同形：双租户各写 identity → 读各自只见自家；跨租户 404 |
| T3.3 鉴权必填（K1 后半） | `server.apiKey` 缺失时启动**警告+一次性生成并打印**（standalone 友好），配置文件写入提示；v3StrictIsolation 默认翻 true | 同形：无 key 请求 401；新部署首启日志出现生成提示 |
| T3.4 缓存租户键（K-B4，随 T3.2 强制） | `_coreValuesCache/_coreSlotsCache` 键改 `team|user|agent` 复合 | 同形：双租户交替请求 → 各自命中自家缓存（值不同断言） |
| T3.5 neighbors 租户过滤（G2） | `getNeighbors` 增 filter 参数（SQL 层 join l1_records 过滤两端租户）；handler 消费 requestIsolation；maxN clamp ≤50 | 同形：租户 A 的 id 查询 → 只返回 A 租户边；maxN=10^6 实测截断 |
| T3.6 lifecycle.filter 可配（H-B2） | `MemoryLifecycleConfig` 增 `filter?` 字段 + parseConfig 解析 + server 按实例传入；**同时** `groupBySubject` 组内租户一致性校验（混合租户组丢弃+warn——双保险，因为 filter 是部署级、组校验是数据级） | 同形：双租户同前缀数据 → 断言组内无混合租户；配 filter 后 consolidation queryL1 带过滤 |

**commit**：`fix(memory): P2 信任边界 — core 租户化+消毒接线+鉴权必填+neighbors/lifecycle 隔离`
**注意**：T3.2/T3.3 是行为变更（接口默认从"裸奔"变"要 key"）——CHANGELOG 显著位标注，部署文档同步。

### 阶段四 · P3 可观测与算法到得了（R3 主修 + R4 收尾）

**目标**：降级可见、健康可探活、H 巩固的触发从"结构上不可能"变"结构上可达"。

| 任务 | 修法 | 验收 |
|---|---|---|
| T4.1 向量健康三件套（G1/W1b③） | ① `countL1VectorRows()`（数 l1_vec_rowids）替代 countL1 作为降级判据：覆盖率 <90% → dedup 走 FTS Tier + warn；② /health 增 `vectorCoverage` 字段 + 探活（每 5min embed 探针词→断言向量行 +1）；③ **注入块降级标注**：FTS-only 时 `<relevant-memories degraded="fts-only">` | 同形：停掉嵌入配置（测试环境）→ /health 显示 coverage 下降+dedup 日志走 FTS Tier+注入块带 degraded 标注；恢复后自动回正常 |
| T4.2 current_feeling 解冻（K3） | 拆分：core_memory 稳定块保留 session_init 缓存；current_feeling 移入**每轮执行**的 hook（cacheStrategy=none 或独立 injector），q=当轮真实用户消息 | 同形：连续两轮不同价值向的提问 → 断言感受块内容随轮变化且 session_init 块保持稳定（cache 命中不破） |
| T4.3 subjectOf 语义化（H1） | 渐进叠加（不推翻词法兜底）：一级=dedup 阶段 LLM 已抽的 subject（若 dedup prompt 增输 subject 字段，成本零——同一 LLM 调用）；二级=嵌入聚类（同簇≥0.85 视为同 subject）；三级=现词法前缀兜底。配置门 `memory.consolidation.subjectStrategy: llm|embedding|lexical`，默认 llm | **同形**：三条同义不同前缀记忆（"用户喜欢X"/"用户偏好X"/"用户爱用X"）→ llm 模式断言归入同组触发巩固；lexical 模式不归组（对照）；embedding 模式归组 |
| T4.4 durative 真值（H-B8+K6 前半） | summarizer significance 改读组内顶层 significance 真实 max（无值计数>半数才用 0.5 中性，否则取真 max）；certainty：组内全 observed 才 observed，含 inferred → **该组不巩固**（P-D+与 T1.1 双保险） | 同形：组内 sig=[0.3,0.9,0.6] → durative significance=0.9；混入 inferred → 不产持续态 |
| T4.5 结构页降权（W5） | typeWeights 增 `other/log/index/schema` 显式低权重（0.3）；无 absScore 的结构页不进 top-K 竞争（排尾+标注） | 同形：log.md 命中 → 注入块不再出现在 rank 1-3（本轮实况的回归用例） |

**commit**：`feat(memory): P3 可观测+巩固可达 — 向量健康三件套/感受解冻/subject 语义化/durative 真值/结构页降权`

### 阶段五 · P4 诚实性（R5+R6）

**目标**：验证与评测从此有锚、同形、可复现。

| 任务 | 修法 | 验收 |
|---|---|---|
| T5.1 golden harness 修复（W1b②+W6） | router 键名与生产共享常量（`WikiNames`）；GOLDEN 对齐 queries.jsonl 全集（含 p6 与完整 should_recall 集）；读取 should_not_recall 作 precision 断言 | 重跑：产出与 README 时代**可对比的口径**（即使数字不同，分母/集合一致） |
| T5.2 归档锚点（W1b①） | replay 输出加 `--archive`：逐 query 命中 JSON + 语料指纹（各 wiki 文件 mtime+size 汇总 sha256）+ git sha → `evals/recall-golden/runs/<date>.json` | 同形：连续两次归档 diff 能明确定位变化来源 |
| T5.3 absGate 测试补齐（W7） | 用例：有 absScore 过门槛/不过门槛、**absScore undefined 的 fail-open 行为显式断言**（修 T4.1 后应断言为"降级标注+仍放行"） | 测试即文档：fail-open 是有意设计被测试钉住，而非没人知道 |
| T5.4 spec 偏离补登记（G6 等） | spec §6 补登记：getPath 未实现 / coreRef 未实现 / 层级边未实现 / 动机方向未做 / TCVDB native-hybrid 跳过 reconsolidation / updated_time 与 TTL cleanup 耦合 / merge→similar 语义稀释 | 文档审查：每项给"设计原句→现状→是否打算做"三段 |

**commit**：`docs+test(memory): P4 诚实性 — golden 锚点归档/harness 对齐/absGate 钉死/spec 偏离补登记`

---

## 4. 与既有机制的兼容性（渐进叠加，不推翻）

- **不推翻 l1_fts 结构**：T2.1 用虚表重建迁移（FTS5 唯一可行方式），列集合向后兼容（旧 17 列不动只追加）。
- **不推翻 dedup 双 Tier**：T4.1 只改"Tier 判据"（数向量行）与"降级可见"，召回逻辑本体不动。
- **不推翻 session_init 缓存**：T4.2 只拆出 current_feeling，core 稳定块的 cache 友好性保留（这正是 A 项设计的本意）。
- **不改 LLM prompt 主结构**：T4.3 的 subject 抽取搭 dedup 现有 LLM 调用顺风车（同一次调用多要一个字段），不新增 LLM 成本。
- **所有行为变更项**（T3.3 鉴权必填、T2.3 假边清理、T4.5 结构页降权）逐一在 CHANGELOG + 部署文档登记——延续"如实登记"纪律。

## 5. 验证纪律（从 R5 提炼，建议写入团队规范）

1. **同形原则**：每条 verify 断言的数据必须从生产同一条数据流走出来（测试 reconsolidation 就调 executeMemorySearch，不手拼 record）。
2. **fixture 共享类型**：fixture 类型直接 import 生产类型；生产类型加字段→fixture 编译报错。
3. **E2E 证明力边界**：mock 依赖的 E2E 只证明"代码通"，生产有效性必须配一条**真实依赖**的探活（/health 探活、真机冒烟、生产数据探针三选一）。
4. **降级即信号**：新增任何 best-effort 降级必须同时交付计数/日志/标注三件套之一（至少一项），否则不许合入。
5. **评测留锚**：评测数字必须能通过归档锚点复现或解释差异，否则不得写进 README/spec。

## 6. 里程碑与工作量

| 里程碑 | 内容 | 规模 | 判停标准 |
|---|---|---|---|
| M1 | 阶段一 P0 四修 | <20 行 + 4 验证脚本，1 天 | 同形断言全过 + 真机抽查（atomic/update 保留 soul、recall_count 递增） |
| M2 | 阶段二 P1 数据链 | FTS 迁移+图边真值，2-3 天 | 存量回填后 FTS 命中带 soul；假边清零+新边真值抽查 |
| M3 | 阶段三 P2 边界 | 租户化+鉴权+消毒，2-3 天 | 双租户隔离用例全过；无 key 401 |
| M4 | 阶段四 P3 可观测 | 三件套+subject 语义化，3-4 天 | 断嵌入→告警链路触发；同义记忆归组触发首次真实巩固 |
| M5 | 阶段五 P4 诚实性 | harness+锚点+登记，1-2 天 | 归档可复现；spec 偏离清单闭环 |

依赖：M1 独立立即可做；M2/M3 可并行；M4 依赖 M2（健康信号需要 FTS 列完整）；M5 依赖前三。合计约 2 周内可全量落地。

## 7. 待评审拍板

1. **T2.1 FTS 迁移策略**：虚表重建（本设计推荐，彻底）vs handler 回查主表（侵入小但每条 FTS 命中多一次主键查询）——倾向前者，生产执行需窗口期。
2. **T2.3 假边处置**：现有 0.8 假边是清理还是标记保留（当前生产仅 2 条，建议直接清理）。
3. **T3.3 鉴权默认**：从"不配=免鉴权"翻转为"不配=启动生成"是行为变更——是否需要兼容期（老配置继续跑但每次启动 WARN）。
4. **T4.3 subject 策略默认值**：llm（推荐，零额外成本）vs embedding（离线批处理友好）——若 dedup prompt 改动有顾虑，先 embedding 后 llm。
5. **核心记忆租户化的迁移默认**：现存 6+1 行归属当前唯一租户——直接按现网 team/user/agent 回填，无需人工。

---

*本设计只回答"为什么修不完"与"按什么原则修"；逐任务 bite-size 步骤（文件级 checklist）待设计评审收敛后按 writing-plans 落 `plans/2026-09-09-soul-memory-trust-repair.md`。*
