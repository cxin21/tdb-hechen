# 召回精度调研 · 开源记忆系统机制拆解 + 评测基准适配（repos-bench / member-3）

- 日期：2026-10-20
- 作者：调研团队 member-3（repos-bench）
- 服务对象：td-agemem（本仓，只读取证，零代码改动）
- 口径（2026-09-15 用户拍板）：**不整体换用任何开源系统，只搬运机制**。本文按「可搬运机制清单」组织结论。

## 0. 方法与核实等级

- 三类病灶（用户 2026-10-20 活体样本 5 条仅 1 条高价值）：
  - 病灶① 检索单元粒度错配（最重）：L1「结论」条目=整任务打包摘要整条召回，注入端截断只留头部流水账，单条信息密度极低；
  - 病灶② 时效无衰减：过程性状态条目过时 4 天仍照常高分召回，无衰减/失效联动；
  - 病灶③ 查询侧污染：harness 噪音（acp 标签、时间戳脚手架）直入 FTS/embedding（2026-10-16 reflection 实锤，未修）。
- 药方分类法（诊断 heuristic）：用户说「不沾边」≠ 主题相关性失败，主因常是「命中了也用不上」。每个机制标注药方类型：**R=相关性失败**（改召回/排序目标函数）、**G=粒度/密度失败**（改检索单元与注入单元形态）。
- 通道：raw.githubusercontent / cdn.jsdelivr / statically / sourcegraph 本机全部不通；**api.github.com contents API（base64 解码）可用**（匿名 60/hr，本轮抓取中耗尽，reset≈12:42 +08）；arxiv.org abs/html 可用。无特别标注者均为 main 分支源码直抓（2026-10-20），行号为当日快照。
- 核实等级：【源码】=逐行直读；【文档】=官方文档/README 直读；【论文】=arXiv abs/html 直读；【未直接核实】=搜索摘要或二手来源。

## 1. 六仓总览

| 仓库 | 语言/规模 | 检索编排 | 写入粒度 | 衰减/失效 | 官方评测 |
| --- | --- | --- | --- | --- | --- |
| mem0ai/mem0 | Python+TS | vector 检索 + 可选 rerank（默认关，失败降级） | LLM 原子事实抽取（FACT_RETRIEVAL_PROMPT）+ ADD/UPDATE/DELETE/NONE 对账 | decay=platform-only 软偏置 0.3x~1.5x；expiration_date 过滤（OSS 有） | evaluation/ 子模块 → mem0ai/memory-benchmarks |
| getzep/graphiti | Python | bm25+cosine 双路各 2x limit → rrf/mmr/cross_encoder 重排 | LLM 抽边（实体+事实边），写时对账失效（invalid_at/invalidated_by） | 双时序：事实级失效对账，非分数衰减 | tests/evals 内置 LongMemEval oracle 子集 |
| MemTensor/MemOS | Python+TS | 三 tier（skill/experience+trace/world）分道检索 → RRF(k=60) 融合 → MMR(lambda=0.7) → LLM 过滤 | trace/skill/world 分层；V·decay 优先级 | 指数衰减 halfLife=30d，**检索时重算**；blend 0.6·cos+0.4·priority | SKILLFLOW_HERMES_EVAL；PROMPT-INJECTION 治理文档 |
| topoteretes/cognee | Python | 管线化 cognify→search（top_k=15 缺省，HYBRID_COMPLETION） | 知识图谱 ECL 管线（抽取→cognify→图谱节点） | **无衰减机制**（树内 grep decay 无实现命中）；有 forget API | eval_framework：HotPotQA/Musique/TwoWikiMultiHop，LongMemEval 可注册 |
| memodb-io/memobase | Python | profile 读取（非检索式）+ 事件摘要流 | **profile 树**（结构化用户画像槽位）+ 事件抽取/合并 prompt 族 | 无分数衰减；更新策略是用户投诉点（#143） | docs/experiments/locomo-benchmark（现成 evals.py） |
| letta-ai/letta | TS（历史） | MemGPT 架构：core memory blocks + archival memory 检索 | 分层内存块（in-context blocks vs archival） | sleep-time compute 离线重整（论文 2504.13171 与 Letta 团队相关）【未直接核实现网实现】 | Letta Evals 产品化【未直接核实】 |

> letta 重大事实：**letta-ai/letta main 分支已无代码**——根目录树 total=15 仅剩 .github/AGENTS.md/AI_POLICY.md/CITATION.cff/LICENSE/README.md 等文档文件（tree API truncated=false，2026-10-20 抓取）；branches 列表 30 个均为 bump-*/caren/LET-* 工作分支，未见代码分支。stars=25195，pushed_at=2026-10-18。代码去向未定位（官网 docs 为 Astro 渲染抓不到正文）。因此 letta 机制只能以 MemGPT 论文（2310.08560）+ 二手资料为准，标注【未直接核实】。

## 2. 机制拆解（每机制：定义 → 病灶 → 本仓适配点 → 工作量 → 锚点）

### M1 原子事实抽取 prompt（一句话一件事）——病灶① 的头号参照【G】

- 定义：mem0 的 FACT_RETRIEVAL_PROMPT（mem0/configs/prompts.py:15-60）定义角色 "Personal Information Organizer"，要求只抽取 7 类信息（个人偏好 / 重要个人细节 / 计划意图 / 活动与服务偏好 / 健康饮食 / 职业细节 / 杂项），并强制「**一句话一件事**」拆条：few-shot 示范把 "Yesterday, I had a meeting with John at 3pm. We discussed the new project." 拆成 facts:["Had a meeting with John at 3pm","Discussed the new project"] 两条独立短句；输出 JSON {"facts":[...]}，无相关内容返回空数组；prompt 注入当天日期（datetime.now 的 %Y-%m-%d 形式）让模型产出带时效语境的表述；只从 user/assistant 消息抽取（不取 system）；检测语言并用原语言记录。【源码】
- 病灶：①（G）。拆条后的原子事实每条 embedding 主题单一、注入端无需截断，直接解决「数千字打包摘要 → 主题虚高 + 头部截断」。
- 本仓适配点：MemoryCore/src/core/prompts/l1-extraction.ts 已有雏形——:38 原子性上限「>300 字或含 2 个以上互不依赖事件必须拆分」，:41 单次 ≤20 条记忆 ≤5 情境。可搬运点：(a) 把「必须拆分」的软规则升级为 mem0 式 few-shot 拆条示范（短句、每条单一事实、禁复合句）；(b) 抽取 prompt 注入当天日期锚点；(c) 「7 类信息清单」式白名单帮助淘汰过程性噪音。落点：l1-extraction.ts + l1-writer.ts。
- 工作量：S（prompt 层改动，配合既有评测门 docs/superpowers/evals/memory-recall-golden 回归）。
- 锚点：mem0/configs/prompts.py:15-60【源码】。

### M2 写入期对账合并（ADD/UPDATE/DELETE/NONE + 保留信息量最大者）——病灶①② 交界【G】

- 定义：mem0 DEFAULT_UPDATE_MEMORY_PROMPT（mem0/configs/prompts.py:176+）让 LLM 以 memory manager 角色对新事实与既有记忆对账，输出四操作 ADD/UPDATE/DELETE/NONE；UPDATE 判据「信息完全不同才更新，同一含义不动」+「**保留信息量最大者**」；UPDATE 保持同 ID，只准引用输入 ID 不得新造（防幻觉）。写入管线（mem0/memory/main.py:881-1005，V3 PHASED BATCH PIPELINE）：Phase0 取 last 10 条消息做上下文 → Phase1 用整批消息 embedding 在向量库搜 top_k=10 条现有记忆 → uuid 映射防幻觉 → Phase2 **单次 LLM 调用**批量出事件 → Phase3 批量 embed → Phase4 执行；LLM 失败 raise LLMError 不静默（main.py:965-971 注释：原 silent return [] 无法区分 429/5xx 与零抽取）。【源码】
- 病灶：②（G+R）——过程性状态「AI 正在处理 X」若与 4 天后「X 已完成」合并/失效，就不会两条并存高分召回；同时降低重复条目对候选池的污染。
- 本仓适配点：MemoryCore/src/core/record/l1-writer.ts（L1 写入）+ MemoryCore/src/core/record/l1-extractor.ts。本仓已有 filter-invalidated.ts（见 M5）做召回侧排除，但**写入侧无对账**：同主题新结论不会 UPDATE/失效旧结论。可搬运：抽取阶段把「最近 N 条同主题 L1」一并送入对账 prompt（本仓 L2 场景块路径索引可当主题分组依据）。
- 工作量：M（写入管线加一次对账 LLM 调用，需防 RTT 叠加；可异步化）。
- 锚点：mem0/configs/prompts.py:176+、mem0/memory/main.py:881-1005【源码】。

### M3 检索时衰减重算（指数半衰期 + 软偏置）——病灶② 的头号参照【G】

- 定义（两条独立实现）：
  1. **MemOS 指数衰减**：优先级公式 priority(f) 正比于 max(V,0)·decay(Δt)，decay(Δt)=0.5^(Δt_days/halfLife)，halfLife=30 天默认；关键设计——**检索时重算（re-derive at retrieval time, Tier-2 blendScore）而非信任落库值**："a trace with fresh V but an old write timestamp sinks naturally as time passes, even without a reward rerun"；Tier-2 排序 score = 0.6·cos + 0.4·priorityForLive（apps/memos-local-plugin/core/retrieval/ALGORITHMS.md §1-2，core/reward/backprop.priorityFor 实现）。【源码】
  2. **mem0 平台软偏置**：搜索时对候选乘缩放因子 0.3x~1.5x（just accessed≈1.5x / touched today 1.2-1.4 / idle days 0.6-1.0 / weeks 0.4-0.6 / months+years≈0.3 floor），官方口径 "a soft ranking bias, **never a filter**"——不删除不过滤任何条目；管线：候选池 top_k×3（floor 50）→ 每条乘因子 → 按未 clamp 积排序 → 返回 score clamp [0,1] → 截断 top_k → fire-and-forget 记录本次被召回（访问史 cap 最近 20 次，作为下次因子输入）；无访问史老记忆用 event_date（缺则 updated_at）当单次 touch（docs/platform/features/memory-decay.mdx；OSS 开源版 decay=True 直接 raise ValueError，main.py:467-483——即此机制仅平台版有，但**算法本身可搬运**）。【文档+源码】
- 病灶：②（G）。4 天前的过程性状态在新机制下 = 0.5^(4/30)≈0.912（MemOS 半衰期 30 天对 4 天衰减温和——注意：**本仓病灶是 4 天旧状态高分，需要更陡的曲线或显式失效标记配合**，见 M5；mem0 因子表则直接给 idle-days 0.6-1.0 的乘法惩罚）。两实现共同点：衰减只动排序不动存在性（软失效），与本仓「软删归档、禁删记忆」红线天然一致。
- 本仓适配点：MemoryCore/src/core/lifecycle/forgetting/scorer.ts:33-43 已有 DEFAULT_FORGETTING_CONFIG={enabled:true,lambda:0.01,lowThreshold:0.12,minAgeDays:30,maxPerRun:100} 与 decay(age) 打分（significance×priority×decay），**但只用于离线归档，未联动召回打分**（config.ts:1502 lambda 缺省 0.01）。可搬运：(a) 把 scorer 的 decay 项以「乘性因子」挂进 sqlite.ts:251-263/297/352 混合召回或 rerank/local.ts:360-367 打分；(b) mem0 式「召回即强化」可对接本仓已有的 reinforcementWeight 开关（golden 十开关之一）；(c) 参数对齐 golden 评测门做重锚。
- 工作量：S~M（S=纯乘性因子进 rerank 打分；M=若要访问史 reinforcement 落库）。
- 锚点：MemOS ALGORITHMS.md §1-2【源码】；mem0/docs/platform/features/memory-decay.mdx + main.py:467-483【文档+源码】。

### M4 候选池放大 + 双路融合 RRF——病灶②③ 相关，兼修 R

- 定义：三家一致做法——**候选池放大后再重排**：graphiti edge_search 全文 limit=2*limit + cosine 2*limit 双路候选，重排后按 config.limit + reranker_min_score 截断（graphiti_core/search/search.py:293-296, :328 candidate_limit=2*limit）；mem0 decay 管线候选池 top_k×3（floor 50）；MemOS ranker 以「最强单通道分」为 base（cosine 或 FTS 1/(rank+1) 或结构性 0.9），再加跨通道 RRF bonus rrfWeight·Σ1/(k+rank_i+1)，"A row confirmed by 2+ channels gets a clear lift over single-channel false-positives"（apps/memos-local-plugin/core/retrieval/ranker.ts 头注释）。RRF 常数 k=60（MemOS ALGORITHMS.md §3，"Lin & Oakes commonly-used constant"；graphiti 的 k 值未直读【未直接核实】）。【源码】
- 病灶：②（R）——放大候选池让衰减/失效过滤有富余可筛；③（R）——双通道互证天然抑制单通道噪音（FTS 命中的 acp 噪音若无 dense 佐证会被 RRF bonus 淘汰）。也修 R：多通道确认提升真相关条目。
- 本仓适配点：MemoryCore/src/.../sqlite.ts:251-263（jieba FTS）+ :297/:352（dense）已双路，但融合处候选池未见 2x 放大语义；MemoryCore/src/core/recall/rerank/local.ts:360-367 candidates=12（config.ts:1763）。可搬运：候选池 12→24~36（2~3x）+ RRF 融合替代线性加权（若现状是线性），rerank 输入扩大后由本地 reranker 消化。
- 工作量：S（候选池参数 + 融合公式，golden 十开关可加开关灰度）。
- 锚点：graphiti_core/search/search.py:293-296/:328、search_config_recipes.py:33-222（12 种预置 recipe 全部双路+RRF/MMR/cross_encoder）、MemOS ranker.ts + ALGORITHMS.md §3【源码】。

### M5 失效对账与双时序（invalid_at / invalidated_by）——病灶② 的根治参照【G】

- 定义：graphiti 把「过时」当**事实级失效对账**而非分数衰减：边构造时解析 invalid_at（ISO Z→+00:00，解析失败 warning 不中断）+ normalize_future_temporal_bounds（graphiti_core/utils/maintenance/edge_operations.py:305-371）；resolve_extracted_edges(...) 返回 (resolved_edges, invalidated_edges, new_edges) 三元组——新事实与既有边对账，被矛盾/重复的旧边进 invalidated_edges（invalidated_by 映射：旧边 uuid→失效它的新边 uuid，:424-461）。【源码】
- 病灶：②（G）。过程性状态「正在处理 X」在新事实「X 完成」写入时被显式失效，检索期不再是「衰减后仍可能高分」而是「已失效即排除/降权」。
- 本仓适配点：MemoryCore/src/core/recall/filter-invalidated.ts:6-32 已有 isInvalidated（valid_end≤now）+ isOutsideValidityWindow（[valid_start,valid_end)，解析失败 fail-open 保留），**钩子路/工具路一致**——语义骨架与 mem0 expiration（docs/platform/features/memory-expiration.mdx：search()/get_all() 过滤、get(id) 仍返回、malformed fail-open、不删数据只隐藏）几乎同构。缺口：(a) 写入侧没有「新事实自动失效旧事实」的对账（依赖 M2）；(b) 已失效条目被硬排除而非降权保留。可搬运：graphiti 的 invalidated_by 链（保留「何时被何条失效」的因果记录，审计友好，符合本仓禁删红线）+ 把硬排除改为「降权 + 打失效标记」双轨。
- 工作量：M（失效对账复用 M2 的对账调用；降权双轨改 filter-invalidated + 打分）。
- 锚点：graphiti edge_operations.py:305-371/:424-461、mem0 memory-expiration.mdx【源码+文档】；已知缺陷警示：graphiti #1728 "Edge invalidation searches the whole graph, so unrelated facts retire each other"（失效对账范围过大会误伤，实现时须限定同主题/同端点——graphiti 用 _pair_search_filter 限定同端点候选边）；#2012 "Edges with a future invalid_at are created already expired"。

### M6 查询侧清洗与注入包络——病灶③ 的直接参照【R】

- 定义：MemOS 在 prompt 构建链路先剥外层包装再检索：adapters/openclaw/bridge.ts handleBeforePrompt → **stripOpenClawUserEnvelope(rawPrompt)** → core.onTurnStart（apps/memos-local-plugin/docs/PROMPT-INJECTION-AND-RETRIEVAL-FILTER.md 调用链）；注入侧用 memos_context 包裹 + 冷启动提示语（"No prior memories matched this query — the store may simply be cold…"）+ turn_start header（"You MUST treat these as established knowledge…"）。【源码/文档】
- 病灶：③（R）。「先剥壳、后检索」= 查询进入 FTS/embedding 前移除宿主脚手架；注入侧包络则防注入内容反向污染。
- 本仓适配点：MemoryCore/src/utils/sanitize.ts + utils/__tests__/sanitize-harness-noise.test.ts 已有清洗工具与测试（病灶③资产已在）——缺口是**接入点**：sanitize 需挂在 query-expand.ts:271-301 之前（ark LLM 扩查前剥壳，省一次被噪音污染的扩查）与 sqlite.ts FTS/embedding 入参处。MemOS 的「冷启动提示」话术可搬运到 JIT 注入端（MemoryProxy/src/.../tdai-profile-memory-injector.ts:267-272）：零召回时显式告知模型「库冷，非无记忆」，避免模型臆断。
- 工作量：S（sanitize 挂点为纯调用序调整；注入话术为模板改动）。
- 锚点：MemOS PROMPT-INJECTION-AND-RETRIEVAL-FILTER.md【源码/文档】；本仓 sanitize.ts【源码】。

### M7 LLM 召回过滤与预算门——带教训的机制【R】

- 定义：MemOS 检索链含 llmFilterCandidates(...)（retrieve.ts → rank → llm-filter → toPacket）对候选做 LLM 终审；已知缺陷即教训：issue #2499 "轻量模式强制打开检索用的 LLM 过滤，它自己的 2 秒上限让本地模型每轮都被中止，然后静默改用宿主模型"；#2501 "轻量模式下 turn_start 只取 Tier-2，导入的 skills/worldModels 永远不会被注入"。【issues】
- 病灶：③（R）——LLM 终审可过滤脚手架噪音与低密度条目；但 MemOS 的两个 issue 证明**硬超时 + 静默降级 + tier 覆盖不全**是工程雷区。
- 本仓适配点：若在 rerank 阶段（local.ts:360-367 之后）加 LLM 终审，须：(a) 显式降级路径（对齐 mem0 rerank 失败 logger.warning 降级用原结果，main.py:1513-1519）；(b) 预算门与本仓 query-expand RTT 2.2-2.4s 现状合计控制在延迟预算内；(c) tier 全覆盖。诚实评估：本机 CPU 节流环境下 LLM 终审延迟风险高，优先级低于 M1-M6。
- 工作量：M~L。
- 锚点：MemOS retrieve.ts/llm-filter.ts【源码】、issues #2499/#2501【issues】、mem0 main.py:1513-1519【源码】。

### M8 分层配额与 tier seeding（防饥饿）——病灶① 辅助【G】

- 定义：MemOS 三 tier（tier1-skill / tier2-experience+trace / tier3-world）分道检索，RRF 融合后 MMR 前先**每非空 tier 保底选 1 条**（tier seeding），"prevents tier starvation——if Tier 2 vector space dominates, Tier 1 and 3 would otherwise never get a slot"，代价 ≤3 条预算（ALGORITHMS.md §4）。【源码】
- 病灶：①（G）——本仓 L1（过程/结论）与 L2（场景块）、价值锚、soul 是不同粒度层；若 MMR 纯按相似度，L1 打包摘要会因主题虚高垄断名额，原子层与结构层被饿死。
- 本仓适配点：MemoryCore/src/core/hooks/soul-anchor-scorer.ts:185 selectAnchorRowsMmr（:208 val=lambda*c.score-(1-lambda)*maxSim，lambda=0.7 来自 config.ts:1393 mmrLambda）——可在 MMR 循环前加按记忆层（L0/L1/L2/锚）的 seeding 保底；参数化进 golden 十开关体系。
- 工作量：S。
- 锚点：MemOS ALGORITHMS.md §4【源码】；本仓 soul-anchor-scorer.ts:185-208【源码】。

### M9 rerank 编排与降级纪律——R 对齐项

- 定义：graphiti reranker 家族 rrf/mmr/cross_encoder/node_distance/episode_mentions，cross_encoder 实现三选（BGE/OpenAI/Gemini，graphiti_core/cross_encoder/）；预置 recipe（search_config_recipes.py:33-222）：EDGE_HYBRID_SEARCH_CROSS_ENCODER(limit=10)、NODE_HYBRID_SEARCH_RRF、COMMUNITY_HYBRID_SEARCH_CROSS_ENCODER(limit=3)——**不同对象类型用不同 rerank 策略与 limit**。mem0：rerank 默认关（search(rerank:bool=False)，main.py:1400/3081），开启且 provider 配置才生效，失败 warning 降级（:1513-1519）；选型五种 cohere/huggingface/llm/sentence_transformer/zero_entropy（mem0/reranker/），TS SDK 同五种，cohere 默认 rerank-v3.5。【源码+文档】
- 病灶：R（通用排序质量）。对本仓的价值主要是**编排纪律**而非新增模型：本仓已有 local/dashscope/siliconflow/http 四路 reranker（MemoryCore/src/core/recall/rerank/），对齐点＝失败降级显式 warning（勿静默）+ 按条目类型（persona/episodic/instruction）差异 limit。
- 工作量：S（纪律对齐）/ M（若按类型差异化）。
- 锚点：如上【源码】。

### M10 离线重整（sleep-time compute / reflection）——病灶① 的长线机制【G】

- 定义：Generative Agents（2304.03442）首创记忆流 + 定期 reflection 合成高阶记忆（recency×importance×relevance 三因子检索，公式为论文级通识【论文 abs 直读；正文公式未重抓】）；sleep-time compute（2504.13171，Letta 团队相关）证明离线预推理可省约 5x 测试时算力并提升准确率至多 13-18%；letta 产品化的 sleep-time agents【未直接核实现网实现】。MemOS 的 entry_summary/event_summary/summary 管线（memobase 同名思路）= 写入时即做层级摘要而非原始堆放。【论文+源码结构】
- 病灶：①（G）——把「整任务打包摘要」离线重写成原子事实/场景块，是 M1 的批量版；③（R）——离线清洗可比在线剥离更彻底。
- 本仓适配点：本仓 L2 场景块（路径索引）已是「离线重整产物」；缺的是 L1 离线批处理把历史打包摘要拆条（M1 prompt 批量跑存量）。注意红线：**只改写入/重整产物，绝不删除原记忆**（软失效可逆）。
- 工作量：L（存量数据重整 + 增量挂钩）。
- 锚点：2304.03442、2504.13171【论文】；memobase controllers/modal/{chat/{entry_summary,event_summary,summary},summary}【源码结构】。

### cognee 补充观察

- 无衰减机制：main 树 grep decay|expir 在实现目录无命中（tree 5051 文件）——「以图谱生命周期替代分数衰减」的路线，与本仓相关度低。
- 有独立 forget API（cognee/api/v1/forget/forget.py + routers/）——主动遗忘入口，可参考其 API 形状（本仓软删已有 scorer.ts，无需搬运）。
- 检索缺省 top_k=15（cognee/api/v1/search/search.py search() 签名），query_type 缺省 HYBRID_COMPLETION。【源码】
- 官方评测（cognee/eval_framework/README.md 直读）：四步管线 corpus building → question answering → evaluation → dashboard；CLI 一条命令 cognee eval --benchmark HotPotQA --engine direct_llm --limit 5；benchmark 集=HotPotQA/Musique/TwoWikiMultiHop/Dummy（LongMemEval "once registered" 可加入）；重依赖（DeepEval/dashboard）隔离在可选 eval extra，core 永不 import harness——**「评测依赖与核心解耦」的工程形态值得本仓借鉴**。【文档】

### memobase 补充观察（profile 派路线）

- 核心形态是**结构化用户画像槽位树**（profile）+ 事件摘要流，检索被「读 profile」替代——与 td-agemem 的 soul/价值锚注入同构度最高（本仓 soul 块≈profile 的身份分区）。repo 确认：memodb-io/memobase，2937 stars，Python，pushed_at=2026-01-11（近半年不活跃）。
- prompt 族齐全可参考：prompts/{extract_profile,merge_profile,merge_profile_yolo,organize_profile,summary_profile,event_tagging,pick_related_profiles}.py（main 树路径清单直读；**prompt 正文未抓，标注【未直接核实】**——GitHub core 限额耗尽）。merge_profile_yolo 的已知缺陷：#166 "parser silently drops every action when the model follows the prompt own output format"（静默丢数据）。
- #143 "Is there any memory update strategy exist…avoiding same content repeatedly"——更新策略缺失是用户投诉；#165 hybrid retrieval（BM25+vector RRF）是未实现的 feature request（佐证 memobase 无 hybrid 召回）。

## 3. 已知缺陷与未解 issue 清单（Lead 口径要求：注明编号/链接）

| 仓库 | issue | 与本仓病灶的映照 |
| --- | --- | --- |
| mem0ai/mem0 | #5352 [54c] "Solving time-blindness, semantic conflicts, and missing CRUD in Mem0 OSS + Qdrant"（社区自建 workaround） | 病灶②：OSS 版无时间感知是公认痛点 |
| mem0ai/mem0 | #4956 [23c] "ADD-only extraction in v3 may surface stale/contradictory facts" | 病灶②：只 ADD 不对账 → 陈旧事实残留（本仓 L1 现状同型） |
| mem0ai/mem0 | #5245 [22c] "Silent memory loss when batch embedding partially fails in V3 add pipeline" | 写入管线工程教训：批量失败须显式报告 |
| mem0ai/mem0 | #4884 [11c] "BM25 keyword search and entity extraction are hardcoded to English" | 多语言：本仓 jieba FTS 反而占优，无需搬运 |
| getzep/graphiti | #1728 [9c] "Edge invalidation searches the whole graph, so unrelated facts retire each other" | M5 实现警示：失效对账必须限定作用域 |
| getzep/graphiti | #2012 [8c] "Edges with a future invalid_at are created already expired" | M5 实现警示：未来时间界归一化（graphiti 有 normalize_future_temporal_bounds 仍出此 bug） |
| MemTensor/MemOS | #2499 轻量模式 LLM 过滤 2s 上限中止后静默换宿主模型 | M7 教训：硬超时+静默降级不可取 |
| MemTensor/MemOS | #2501 turn_start 只取 Tier-2，skills/worldModels 永不注入 | M8 教训：tier 覆盖必须显式断言 |
| MemTensor/MemOS | #2331 删除接口返回成功但未删除 | 运维教训：破坏性操作须回读验证（本仓红线「零删除」天然规避） |
| memodb-io/memobase | #143 无更新策略/重复内容堆积 | 病灶①②：重复低密度条目堆积 |
| memodb-io/memobase | #165 hybrid 召回（BM25+RRF）是未实现 feature request | 佐证 M4 价值：本仓已有双路，缺的是融合语义 |
| memodb-io/memobase | #166 merge_yolo parser 静默丢动作 | 解析失败须显式报错（mem0 LLMError 同教训） |
| import-myself/Membench | #1 数据集未上 HF（百度网盘/GDrive） | 基准移植成本项 |
| topoteretes/cognee | open issues 前 403 条均为 hackathon/connector 噪音，无机制级信号（2026-10-20 搜索快照） | 如实标注：无可用缺陷证据（非「无缺陷」） |

（issue 编号即 GitHub 链接路径：github.com/<owner>/<repo>/issues/<编号>，检索快照 2026-10-20，按评论数排序取机制相关前若干条。）

## 4. 评测基准评估

### B1 LongMemEval（2410.10813，ICLR 2025）——首选锚定

- 定义：500 道高质量问题，测五能力：Information Extraction / Multi-Session Reasoning / **Knowledge Updates** / **Temporal Reasoning** / **Abstention**；needle-in-a-haystack 式属性受控管线自动编制带时间戳的聊天史（repo README 直读；HF 数据集 xiaowu0162/longmemeval-cleaned，2025-09 清理版修复历史会话对答案的干扰；2026-05 出 LongMemEval-V2 转向 agentic context）。【文档】
- 适配性：**与本仓形态最贴合**（个人长程记忆助手 + 时效 + 弃答）。Abstention 类直接测「不该答时不编」，是「有效信息率=高价值条数/召回总条数」人工标注法的最近的学术代理指标——本仓 golden labels.jsonl（11 query/46 正例非循环真值，P@5≥0.633 现行验收线，docs/superpowers/evals/memory-recall-golden/README.md）可扩展出 negative/abstain 标注实现同型评测。
- 移植成本：M。graphiti 官方已内置 oracle 子集跑法（tests/evals/data/longmemeval_data/longmemeval_oracle.json，README 注明数据来自 HF）——**可直接抄其评测 harness 结构**【源码】。

### B2 LoCoMo（2402.17753）——次选

- 定义：LLM agent 生成 + 人工校对的超长对话（每例约 300 turns / 35 sessions，5 类问题含多跳与时序），grounding 于 persona + temporal event graph。【论文 abs 直读；README 抓取因 GitHub 限额 429 失败【未直接核实】】
- 适配性：memobase 有现成实验目录（docs/experiments/locomo-benchmark/{evals.py,prompts.py,fixture/memobase/*.json}）【源码结构】——可借道 memobase 的跑法；但 LoCoMo 语境是闲聊人格对话，与 td-agemem 的开发助手场景偏移更大。
- 移植成本：M~L（语料域偏移需重标）。

### B3 MemBench（2506.21605，ACL 2025 Findings）——参考框架，暂不移植

- 定义：multi-scenario（Participation 第一人称 / Observation 第三人称）× multi-level（High-Level Reflective / Low-Level Factual）四象限 + Memory Capacity 容量评测 + NoiseData 噪声扩展（每加 1 单位噪声约 +1k tokens）（arXiv html 直读目录结构 + README 数据说明）。【论文+文档】
- 适配性：其「低层事实 vs 高层反思」分轴与本仓病灶①（粒度）同构，**评测思想可借鉴**（分别对原子层/摘要层出题）；但数据在百度网盘/GDrive 且未上 HF（issue #1），工程上不可持续。
- 移植成本：L（数据获取不便；可只搬「分轴出题」思想进 golden 扩展）。

### 基准结论

主基准 = **本仓 golden P@5 体系扩展**（最小确定性、已有非循环真值）+ LongMemEval oracle 子集（外部效度锚，抄 graphiti harness）；「有效信息率」人工标注法与 LongMemEval 的 Abstention/Knowledge Updates 维度天然兼容，建议在 golden labels 里加「高价值/低价值/应弃答」三值标签试点。

## 5. Top 机制清单（病灶贴合度 × 工作量 排序）

| # | 机制 | 病灶 | 药方 | 工作量 | 本仓落点 |
| --- | --- | --- | --- | --- | --- |
| 1 | M1 原子事实抽取 prompt（mem0 七类清单+一句话一件事 few-shot+日期锚） | ① | G | **S** | l1-extraction.ts:38 升级 |
| 2 | M3 检索时衰减重算（MemOS 0.5^(Δt/30d) live + mem0 软偏置 0.3-1.5x，均「只动排序不动存在」） | ② | G | **S~M** | scorer.ts decay → sqlite.ts/rerank 打分乘性因子 |
| 3 | M6 查询侧清洗挂点（MemOS stripOpenClawUserEnvelope 先剥壳后检索 + 冷启动注入话术） | ③ | R | **S** | sanitize.ts → query-expand.ts:271 前挂点 + injector 话术 |
| 4 | M8 分层 tier seeding（MemOS 每层保底 1 条防饥饿） | ① | G | **S** | soul-anchor-scorer.ts:185 selectAnchorRowsMmr 前置 seeding |
| 5 | M4 候选池放大 + RRF 融合（graphiti 2x limit / mem0 top_k×3 / MemOS best-channel+RRF bonus k=60） | ②③ | R | **S** | sqlite.ts:251-263 融合处 + candidates=12→24~36 |
| 6 | M2 写入期对账合并（mem0 ADD/UPDATE/DELETE/NONE 保留信息量最大者） | ①② | G | M | l1-writer.ts + l1-extractor.ts |
| 7 | M5 失效对账双轨（graphiti invalidated_by 链 + 硬排除改降权；mem0 expiration fail-open 语义本仓已对齐） | ② | G | M | filter-invalidated.ts:6-32 + M2 联动 |
| 8 | M10 离线重整存量 L1（sleep-time/generative agents reflection 思想） | ① | G | L | L2 管线扩展，批量 M1 |

排序逻辑：1-5 全部 ≤M 且每个直击单一病灶（1→①、2→②、3→③ 三病灶各有 S 级首选项）；6-7 是 M 级根治项；8 是 L 级长线。graphiti/MemOS 的教训（#1728/#2499/#2501）已在对应机制内标注为实现警示。

## 6. 诚实边界（未核实/未覆盖项）

1. **letta**：main 分支无代码（tree 直读），代码去向未定位；机制描述基于 MemGPT 论文与二手资料，【未直接核实】；issues 搜索两次工具错误（fs-quality-fetch），未取得 letta 缺陷清单。
2. **memobase prompt 正文**（extract_profile.py / merge_profile.py 等）：GitHub core 限额耗尽未抓，仅路径清单级【未直接核实】；prompt 文本是 M1 的重要旁证，建议额度重置后补抓。
3. **graphiti RRF k 值**：search.py 的 rrf import 源文件未直读，k=60 结论目前仅由 MemOS 侧证实【未直接核实 graphiti 侧】。
4. **LoCoMo README**：429 未抓到，规模数字（300 turns/35 sessions）来自论文 abstract 与已知文献口径【论文级核实，repo 级未核实】。
5. **Generative Agents recency 公式**（recency×importance×relevance，指数衰减 0.995^h）：论文级通识，正文公式段未重抓【未直接核实】。
6. **cognee issues**：open issues 被 hackathon 活动噪音淹没，未逐条翻页，缺陷清单缺失（非「无缺陷」）。
7. **Zep 论文正文**（2501.13956）：仅 abs 直读（Graphiti 架构 + DMR 基准对比 MemGPT）；实体解析/语义分环细节未展开。
8. 时间盒：MemOS python 侧 src/memos（2438 文件树中的 python 核心）未拆，仅 TS 侧 memos-local-plugin 深拆——TS 侧恰是可移植性最高的参考实现（本仓同为 TS）。
