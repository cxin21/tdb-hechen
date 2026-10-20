# 召回精度最终方案（定案 v1.0）——目标函数：精度与延迟优先

> 2026-10-20 · 用户授权「以精度和延迟优先，你自己定一个最终的最优方案」（会话 session-3a14e99d）· AI 定案落盘。
> 性质：**方案定案文档**。代码实施/生产配置翻转不在本授权面，按 Phase5 流程（立票→合同→TDD RED→实现→对抗审查→全量门绿）待用户一声「开工」启动。
> 上游：2026-10-20-recall-precision-survey.md（§8 对抗性复审 v2）+ recall-internal-forensics.md（T4 定量）+ 三份外部调研。

## 0. 目标函数与北极星（用户定）

- **精度**：有效信息率 = 高价值行 / 注入行总数（golden 三值标注口径，T4 rubric）。
- **延迟**：真实查询召回链 p50 perfMs 不升；脚手架查询趋零成本。
- 工作量/风险不进目标函数，但受红线约束（零删除、config-first、测试临时 SQLite、全量门基线守恒）。

## 1. 定案决策表（D1-D7 全落定）

| # | 决策 | 定案 | 依据（一手锚） |
| --- | --- | --- | --- |
| D1 | 路线 | Step 0 → Batch A → Batch B → Batch C → Batch D；**F3 扩池移出路线**（Step 0 基线复测后若结论层 recall 不足再议） | rerank kept319/dropped1548（池内 83% 应丢）；空召回主体=脚手架查询（59.5%）；扩池延迟近线性（p50 1.08s 或翻倍） |
| D2 | 存量处置 | **不批量重写存量**；读取侧降权（四门+预算重组）压低整包曝光；F5 落地后反思管线发现矛盾才置 valid_end，绝不删除 | 零删除红线；最小污染面纪律；record/l1-writer.ts:154 DedupAction 已含软失效容器 |
| D3 | 衰减参数 | 软衰减因子 0.5^(Δt/30d) 乘性挂信号层（never-a-filter，只降序不过滤）；**缺省关**，Batch C 试点开；30d 半衰期定案 | MemOS ALGORITHMS.md §1-2；mem0 软偏置 0.3-1.5x 范式；本仓 timeProx=0.15 权重量级匹配（memory-search.ts:601） |
| D4 | 剥噪策略 | **两级**：①剥 pattern（六类词表）②剥后剩余语义 <10 字符或纯脚手架 → 跳过召回+journal 记 skipReason；否则清洗后检索 | P6 活体证据：压缩区段查询剥壳后仍召回有用行（2/4），不可一刀切跳过 |
| D5 | 验收门 | ①每批全量门绿（vitest 基线守恒 + pnpm run typecheck 243 基线）②有效信息率 ≥40%（Batch B 后复测，基线 26.5%）③脚手架噪音查询占比 77.7%→<10%（Batch A 后）④真实查询 p50 perfMs 不升 ⑤每门独立 journal 命中率/perfMs 对照无精度回退 | T4 基线 26.5%（34 行活体标注）；journal perfMs 分段（#61） |
| D6 | 四门调参评估（2026-10-20 勘误，survey §8.5：生产 tdai-gateway.yaml:86-177 已显式全开——minUniqRatio=0.35/textHitMaxTokenRatio=0.5/idfWeighted=true/minBm25Rel=6.5；代码缺省关≠生产关） | 已开启状态下调优评估：① idfWeighted 配比评估 ② textHitMaxTokenRatio=0.5 回调空间（结论层召回损失 >10% 回调 0.7）③ minUniqRatio=0.35 有效性评估 ④ minBm25Rel=6.5 地板值评估（防叠加过滤）；每门独立 A/B，一次只动一个，journal 命中率+perfMs 对照 | 代码缺省 config.ts:1713-1732 全关（一手）；textHit 病机=≥2 字符子串即整条拉入（recall-layered.ts:78-81） |
| D7 | 授权口径 | 本授权面=方案定案；**立票与代码实施**待用户「开工」；生产配置翻转（四门/剥噪）在测试全绿后单独执行并报备 | 用户拍板纪律；config-first（无新配置不翻转默认行为） |

## 2. 批次详情（改动位点与回滚方式）

### Step 0 评测基线（先行，近零成本）
- 内容：T4 34 行活体标注 + handoff 附录 A 5 条 → golden 回归集（三值标签：高价值/低价值/应弃答）；跑出基线有效信息率定格 26.5%。
- 落点：docs/superpowers/evals/memory-recall-golden/ 新增回归集文件（纯测试资产）。
- 回滚：无需（只读资产）。

### Batch A 真·快赢（S，写入面零风险，延迟红利最大）
1. **F8 剥噪接入**：sanitize.ts 工具扩展六类 pattern（<acp> 标签 / m\d{5} ref / Time sampled·Elapsed 时间戳脚手架 / ⚠️ Context limit·系统提醒 / 【Compressed conversation section】区段头 / [current_feeling]·[soul- 等 POV 标签头）；接入点=handleRecall（v2-router.ts:1841）入口单一源 + injector（tdai-profile-memory-injector.ts JIT 调用点）复用同函数；journal 增 skipReason 字段（recall-journal.ts:90-112）。
2. **F7 time_point 传参**：injector 调 handleRecall 补 time_point=当前时间（v2-router.ts:1841 body 已支持）。
3. **四门调参评估**（D6 勘误后口径：生产 yaml 已显式全开，评估调优而非翻转启用；每门独立 A/B + journal 对照）。
- 延迟收益：77.7% 脚手架查询短路，省 FTS+embedding+rerank(1~3.6s)+expand(1.5s)。

### Batch B 注入面重组（S-M，golden 回归保护）
1. **F2 密度优先截断**：recall-layered.ts:229 + auto-recall.ts:812 的 maxCharsPerMemory 头部硬截断 → 完整事实单元/句子边界优先（超限事实单元降级不截半句）。
2. **A4 字符预算再分配**：结论层/经验层行数对半 → 字符口径分配（结论层上限 = 预算 50% 字符数），33% 有效率的经验层短行不再被 2000 字符行挤压。

### Batch C 时效根治（M-L，生产写面·软失效可逆）
1. **F6a occurred_at 填实**：lifecycle 反思管线写侧补时间列（content-soul.ts:3 自述常空为根因之一）。
2. **F6b 检索期软衰减**：recall-signals.ts 增 ageDecay 乘性因子（config-first 缺省关；Batch C 试点开）。
3. **F5 supersession**：反思时矛盾检测→invalidate API 置 valid_end（两路读面测试已就绪 bitemporal-two-path.test.ts）；防 graphiti #1728 全局误伤陷阱（对账仅限同主题候选）。

### Batch D 粒度主药（M-L，反思管线）
1. **F1 producer 甄别先行**（近零成本取证）：确认整包结论产自 consolidation 管线还是抽取链违反 → 产出侧确定性校验门（>300 字或 2 事件必拆/拒收）+ few-shot 拆条升级（mem0 FACT_RETRIEVAL_PROMPT 范式）。
2. **F4 small-to-big**：原子召回+父块回链（后置，视 Batch A-D 后基线）。

### 独立 A/B（移出路线，保留观察）
- F3 扩池：仅当 Step 0 基线复测显示结论层 recall 不足（应召回结论未入池）时再评估，带延迟测量门。

## 3. 红线兼容声明

- 零删除：D2 存量不批量重写，F5 软失效可逆；绝不触碰 D:/TDB/data/vectors.db 生产记忆库（测试一律临时 SQLite）。
- config-first：四门/衰减/剥噪全部 config 门控，缺省保留逐位现状，翻转走独立报备步骤。
- 门禁亲跑：每批次 pnpm run typecheck（243 基线守恒）+ 全量 vitest 基线不破；宣完成前亲跑不采信转述。
- R-A 红线：mood 数据不入召回（本方案未触及，声明留档）。
- 零 git：AI 不自行 commit/push；立票经 gh 按既定 issue-tracker 流程（用户既定授权范围）。

## 4. 修订记录

- v1.0（2026-10-20）：用户授权精度+延迟优先后 AI 定案；D1-D7 全落定；F3 移出路线；四门阈值定死（0.5/0.3/true/缓评）；剥噪改两级策略（P6 证据修正）；验收门定数值（≥40% / <10% / p50 不升）。
