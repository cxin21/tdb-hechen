# 召回精度调研汇总：机制→病灶→适配点→工作量映射（T5 / Phase4 拍板材料）

> 2026-10-20 · Lead 汇总 · **只读调研汇总，供拍板，不实施**。任何代码/配置/数据改动待用户定案后另立批次（拍板→合同→TDD RED→实现→对抗审查→全量门绿）。

## 0. 上游文档与亲核状态

| 文档 | 产者 | 行数 | Lead 亲核 |
| --- | --- | --- | --- |
| docs/research/2026-10-20-recall-internal-forensics.md | Lead（T4） | 105 | 亲证（一手取证） |
| docs/research/2026-10-20-survey-papers-memory.md | papers-memory | 313 | 抽验 6 锚全过（l1-writer/scorer/signals/bitemporal/config/maxChars） |
| docs/research/2026-10-20-survey-papers-rag.md | papers-rag | 231 | 抽验 2 承重锚全过（timeProx 权重/candidates clamp） |
| docs/research/2026-10-20-survey-repos-bench.md | repos-bench | 196 | 抽验 3 锚全过 + 2 项独立复核（见 §6） |

## 1. 病灶定量结论（T4 一手取证摘要）

| 病灶 | 定量 | 一手锚 |
| --- | --- | --- |
| ①粒度错配（**主因**） | 结论层行 8/8 零高价值；生产 34 行高价值率 26.5%（经验层短行 33%）；memoryLine p90=2024 / max=2030 字符截断帽；注入面 59.7% 为结论层整包行 | internal-forensics §1/§4；config.ts:249/1712 maxCharsPerMemory=2000+尾部…标注 |
| ②时效无衰减 | 过时 4 天过程状态条目 2 例仍高分召回；bi-temporal 列+invalidate/restore API+两路读面测试全就绪，但 proxy JIT 召回不传 time_point，衰减通路未接线 | internal-forensics §5；bitemporal-two-path.test.ts:1-60；v2-router.ts:1841 body 支持 time_point |
| ③查询侧污染 | fresh 77.7% 携带 harness 噪音（<acp>/时间戳/系统提醒）；空召回 59.5% 主体为脚手架查询（生产真实轮 11/11 均有返回）；算力浪费：rerank p50≈1.1s p90≈3.6s、expand p50≈1.5s | internal-forensics §1/§3；utils/sanitize.ts + sanitize-harness-noise.test.ts 在位，缺召回入口接入点 |

**底座事实（三成员一致 + Lead 抽验）**：本仓底座比病灶描述更完整——bi-temporal 读/写面、l1_links 表（sqlite.ts:823-831，写入 :1797）、遗忘归档门（forgetting/scorer.ts:35/39 λ=0.01 minAgeDays=30 仅离线归档）、recall 记账、importance 乘法门全部现成。**缺的是策略接线与执行，不缺底座**。

## 2. 执行缺口新证据（Lead 本轮增补）

- 原子性上限规则（一条记忆只记一件事；>300 字或 2 个以上互不依赖事件必须拆分）在 `MemoryCore/src/core/prompts/l1-extraction.ts:38`（:27/:214 同款），**git log -S 实锚 2026-10-06 e1514c2 引入**。
- 生产 journal（10-12→10-20）持续出现 2024-2030 字符整包结论 → **规则生效 14 天，结论产出链未执行**。
- Phase4 需现场甄别 producer：consolidation/反思管线产出整包 conclusion（lifecycle-embed.test.ts:33 [{question,conclusion,evidence}]）可能不经该抽取 prompt 约束；或 LLM 违反且无校验门。无论哪种，落点=**产出侧确定性校验门**（超限拆分/拒收）而非仅改 prompt。

## 3. 机制→病灶→适配点→工作量→锚点 总映射

| # | 机制 | 病灶 | 本仓适配点 | 量级 | 锚点 |
| --- | --- | --- | --- | --- | --- |
| F1 | 原子事实抽取强化（mem0 FACT_RETRIEVAL_PROMPT few-shot 拆条「一句话一件事」） | ① | 结论产出链补确定性校验门 + few-shot 升级；先甄别 producer（§2） | M | mem0/configs/prompts.py（sha bdcb6af3）；l1-extraction.ts:38；record/l1-writer.ts:154 DedupAction |
| F2 | 注入端截断改密度优先（保完整事实单元/句子边界，替换头部硬截断） | ① | recall-layered.ts:229（maxCharsPerMemory 2000，config.ts:249/1712）+ auto-recall.ts:812 | S | CAL C1；RECOMP 2310.04408 替代方向 |
| F3 | 候选池 12→24~36 + 满吃 cross-encoder reranker | ①通用 | config.ts:1820 candidates clamp[1,100]；reranker 已是 bge-reranker-base | S | 1901.04085；graphiti search.py:293-296 双路 2×limit |
| F4 | small-to-big：原子召回+父块回链注入 | ① | 结论层选择（recall-layered scene/text hit）改造，M-L 后置 | L | RAPTOR 2401.18059；Dense X 2312.06648 |
| F5 | supersession 写侧自动失效（反思时矛盾检测→置 valid_end，软失效可逆） | ② | invalidate/restore API + 两路读面已就绪；graphiti invalidated_by 对账范式（edge_operations.py:424-461；#1728 全局误伤警示） | M | 2501.13956；bitemporal-two-path.test.ts |
| F6 | 检索期重算衰减 + timeProx 根因修复 | ② | 衰减因子挂 rerank/信号层（MemOS 0.5^(Δt/30d)、mem0 软偏置 never-a-filter）；l1_records 时间列填实 occurred_at（现常空 content-soul.ts:3）+ 过程性条目失效标记；timeProx=0.15 已有但权重失衡（memory-search.ts:601） | S-M | MemOS ALGORITHMS.md §1-2；2501.13956 |
| F7 | proxy JIT 召回传 time_point | ② | injector 调 handleRecall 补参（v2-router.ts:1841 已支持） | S | internal-forensics §5 |
| F8 | 召回入口剥噪接入（先剥壳后检索） | ③ | sanitize.ts 已有工具+测试；接入点=handleRecall 入口 + query-expand（core/recall/query-expand.ts:271-301）之前 + injector 零召回话术 | S | MemOS stripOpenClawUserEnvelope；sanitize-harness-noise.test.ts |
| F9 | 已建门启用评估（config-first 核对+启用） | ①② | v18-c 结论块低密度门、#53 textHit IDF（缺省 off）、R71-A1 conclusionBm25 预地板、R71-A2 conclusionRerank | S | internal-forensics §2（机制-启用差距） |
| F10 | 评测承接：golden 三值标签（高价值/低价值/应弃答）+ LongMemEval oracle 子集 | 验收 | docs/superpowers/evals/memory-recall-golden/ 加标签位；graphiti 内置 harness 可抄（tests/evals/data/longmemeval_data/） | M | 2410.10813 ICLR25；LoCoMo 2402.17753 |
| F11 | expand 串行阻塞治理（并行/降频） | 延迟 | query-expand.ts:271-301（p50 1.51s 串行在召回主链） | S-M | #63 先例（journal l1=4305ms 中 ~4s 为 expand） |

## 4. Top3 组合建议（供拍板）

- **Top1 快赢批（S 级，当天可落地，config-first 可逆，零 LLM 依赖）**：F8 剥噪接入 + F2 密度优先截断 + F3 扩池 24~36 + F9 已建门核对启用 + F7 time_point 传递。直接改善信噪比、注入密度与时延；不动写入面。
- **Top2 时效根治（M）**：F5 supersession 写侧失效（软失效可逆，合零删除红线）+ F6 衰减接线与 occurred_at 填实。治病灶②根因（T4：bi-temporal 通路在、未接线）。
- **Top3 粒度主药（M→L，后置）**：F1 结论产出链拆条 few-shot+确定性校验门（先做 §2 producer 甄别）→ F4 small-to-big 父块回链。治病灶①主根。
- 验收线：F10 三值标签先于任何机制改动落 golden 基线（先锁基线再动刀，test-gated 纪律同构）。

## 5. 拍板决策点（ready-for-human）

1. **D1 批次顺序**：是否按 Top1→Top2→Top3；Top1 快赢批可否先立票开工。
2. **D2 存量处置**（涉生产记忆库写面，须拍板）：原子化只对新写入生效；存量整包结论建议**软失效可逆**（新增原子行、旧整包置 valid_end），绝不删除。
3. **D3 衰减参数缺省**：半衰期 30d/λ 取值、衰减因子缺省关（config-first）。
4. **D4 剥噪词表准入**：<acp> 标签/m-ref/时间戳脚手架/系统提醒 pattern 清单——词表类准入属用户裁决权先例。
5. **D5 验收门**：golden 三值标注是否采纳为门；LongMemEval oracle 子集引入与否（需联网拉数据集）。

## 6. Lead 复核偏差台账（成员汇报 vs 一手实锚）

- candidates 实锚 **config.ts:1820**（repos-bench 引 1763 为旧快照；papers-rag 勘误成立）。
- l1-writer 实路径 **MemoryCore/src/core/record/l1-writer.ts**（papers-memory 引文未带全路径；work_fact :36、DedupAction :154 已实锚）。
- mem0 prompts.py：Lead 确认存在性（api.github.com sha bdcb6af3 size 64064 main@2026-10-20），正文未逐字复验（base64 解码未做），采信 repos-bench 源码直读。
- mem0 prompt/issues 其余外部锚点均成员一手（源码直读/issues 直抓），Lead 未逐条复验，实施前现场复核。
- 快照勘误沿用：handleRecall=v2-router.ts:1841、query-expand=core/recall/query-expand.ts:271-301、MMR 用于 soul 锚选择非召回去重。

## 7. 诚实边界

- T4 生产标注 n=34 行、单标注人（rubric 文字化缓解主观性）；「结论层 0%」n=8 小样本，作方向依据不作精确率声明。
- 外部机制 papers 侧多数摘要级（papers-memory M2/M4/M5/M7-M9/M11-M14 等），实施前每机制需现场复核（各文档诚实边界节为准）。
- letta main 分支已无代码（repos-bench 未直接核实项）；getmemos/memobase 不存在已修正 memodb-io/memobase。
- 本汇总与四份上游文档均为调研产物，**未实施任何代码/配置/数据改动，零 git 操作**。

## 8. 对抗性复审与方案重排（v2，2026-10-20，应用户「这就是最优方案么」复审要求）

### 8.1 自审结论：v1 两处高估、两处遗漏

| # | 发现 | 证据（一手） | 处置 |
| --- | --- | --- | --- |
| A1 | F3 扩池 12→24-36 **非无脑快赢**：rerank p50≈1.08s 近线性随时延，p90 3.59s 或翻倍；papers-rag 自标「延迟未实测」 | internal-forensics §1 | 降级为独立 A/B（config-first 开关 + journal perfMs 前后对照），移出批次 |
| A2 | 「5 项 S 当天落地」**高估**：F2 动全部注入块渲染路径涉 golden 回归面（S→M）；F9 各门当初缺省关有因，启用需逐门评估非橡皮章 | config.ts:1713-1732 全缺省关 | Batch A 收窄为真·快赢 3 项 |
| A3 | **【新杠杆】病灶①直接机制 = 结论层 textHit**：query 任一 ≥2 字符 token 为结论文本**子串**即整条拉入 2000 字符级结论（recall-layered.ts:78-81）——中文 2 字词（记忆/工作/召回）几乎必然命中任何长结论，「越长的记忆越容易被选中」 | recall-layered.ts:78-81 | 四门启用评估升 Batch A 核心 |
| A4 | **【新杠杆】预算错配**：结论层行数吃对半，但行均 ~2000 字符 vs 全体 p50 348 → 字符口径 ~90% 注入预算被结论层占用，33% 有效率的经验层短行被挤压 | internal-forensics §1/§4 | 字符预算再分配入 Batch B |
| A5 | **评测应 Step 0**：T4 34 行活体标注（真实生产 query+评级）可近零成本转 golden 回归集，先锁「有效信息率」基线再动刀 | internal-forensics §4 | F10-lite 升 Step 0，先于一切机制改动 |
| A6 | F5 supersession 工作量诚实化 M→L（反思/consolidation 管线 prompt+管线改动；graphiti #1728「失效对账全局搜索误伤」实现陷阱） | repos-bench issues 实锚 | 保持 Batch C，不拔高 |

### 8.2 机制-启用差距全貌（config.ts 一手，2026-10-20）

四道已建防线**全部缺省关**（逐位现状设计，config-first）：

| 门 | 位点 | 缺省 |
| --- | --- | --- |
| P1 万词面剔除门 textHitMaxTokenRatio | config.ts:1719-1722 | undefined=关 |
| #53 textHit IDF 加权排序 idfWeighted | config.ts:1728（auto-recall.ts:771 透传） | false=关 |
| v18-c 结论块低密度门 minUniqRatio | config.ts:1714-1717 | undefined=关 |
| R71-A1 work_fact bm25 预地板 minBm25Rel | config.ts:1730-1732 | undefined=off |

→ 结论层选中目前无任何对药生效：任一 ≥2 字符子串命中即整条拉入。**四门启用评估 = 零写入面风险的最高杠杆**，逐门独立 config-first A/B + journal 命中率/perfMs 前后对照，测试全走临时 SQLite。

### 8.3 重排路线（v2，以「每单位风险的精度收益」排序）

| 阶段 | 内容 | 量级 | 风险面 |
| --- | --- | --- | --- |
| **Step 0 评测基线** | T4 34 行活体标注转 golden 回归集，锁定基线有效信息率 | 近零 | 无（只加测试资产） |
| **Batch A 真·快赢** | F8 剥噪接入（sanitize.ts 工具+测试在位）＋ F7 time_point 传参 ＋ 四门启用评估（§8.2 逐门 A/B） | S | 写入面零风险 |
| **Batch B 注入面重组** | F2 截断改密度优先（句子/事实单元边界）＋ A4 字符预算再分配 | S-M | golden 回归保护 |
| **Batch C 时效根治** | F6a occurred_at 填实（数据前提）→ F6b 检索期软衰减（never-a-filter）→ F5 supersession 写侧失效（防 #1728 陷阱，软失效可逆） | M-L | 生产写面（软失效可逆合零删除红线） |
| **Batch D 粒度主药** | F1 producer 甄别 → 产出链确定性校验门 + few-shot 拆条 → F4 small-to-big 父块回链 | M-L | 反思管线 |
| **独立 A/B** | F3 扩池 12→24-36（带延迟测量门，journal perfMs 对照） | S | 延迟 |

### 8.4 对「这就是最优方案么」的直接回答

诚实回答：**v1 不是最优**——病灶→机制的对应方向有定量支撑，但 A1/A2 高估与 A3/A4/A5 遗漏使 v1 排序非最优；v2 是当前证据下的最优排序。且「最优」取决于目标函数：精度优先 / 延迟优先 / 风险最小三者权重属用户裁决（新增拍板点 D6：四门启用逐门顺序与取舍）。定案以用户明示授权为准，本节仅证据与排序建议。

### 8.5 勘误附录（2026-10-20 对抗审查 + P3 归因后定案，勘误 §8.2/A3/A4 与 final-plan D6 表述）

**勘误 1（四门「已建未启用」表述对生产不成立）**：§8.2 四门锚点（config.ts:1714-1732）是**代码缺省值**（undefined/false=关），但生产部署 tdai-gateway.yaml:86-177 recall 段**显式全开**：conclusionLayer.enabled=true(:160)、maxCharsPerMemory=2000(:161)、minUniqRatio=0.35(:163，v18-c 拍板)、textHitMaxTokenRatio=0.5(:169，P1 issue#2)、idfWeighted=true(:172，#53)、minBm25Rel=6.5(:177，R71-A1 2026-10-19 生产语料定标)，另 maxResults=5(:88)。→ **A3/A4 病灶机制（textHit 子串整条拉入 + 2000 字整包预算占用）在生产门已开的前提下仍然成立**（P3 归因实证：门全在位，期望行仍因 clean 查询 textHit=0 而漏召回）——病灶定性从「门未启用」修正为「门已开仍不解决粒度与文本命中主导问题」。

**勘误 2（final-plan D6 口径）**：D6「四门逐门翻转启用」应修正为「已开启状态下的有效性评估/调参」（idfWeighted 配比、textHitMaxTokenRatio 阈值回调空间、minBm25Rel 地板值）。方案变更**待用户拍板**，本附录仅记录勘误，不擅改 final-plan。

**勘误 3（P3 红牌=复放保真伪影，非 #74 回归）**：方差探针（临时网关 :8423，鉴权修复后）P3 clean×3+raw×1 全部 0 行且 raw≡clean（#74 剥噪生效）；temp journal ftsHits=36/embHits=3/expandMs≈1513 与生产 journal #303 逐位同，差异唯一=结论层 FTS 池 kept 16（生产，raw 噪音查询 queryLen 58）vs 2（复放，clean 查询）。生产 03:19 为 pre-#74 端点裸传，噪音 token（m03958/acp/tokens 等）意外捞回期望行；复放为 post-#74 剥噪 clean 查询，池仅 2 条 work_fact→textHit=0。诚实披露：**#74 剥噪使 P3 轮命中 1→0**——噪音 token 曾意外捞回相关行，恰从新角度佐证结论层病灶（命中依赖噪音而非语义）。

**勘误 4（池上限漂移，诚实边界）**：searchL1Fts 第二参=limit（sqlite.ts:5713，缺省 20）；工作区结论池=halfLimit×2=4（auto-recall.ts:713）。生产 journal #303 kept=16>4 → 生产部署构建与工作区 R71 池构造存在漂移（或 scene_block 豁免计入 kept），本批不深追；Step 0 复放测的是工作区代码行为。

**对抗审查（2026-10-20 只读，总裁决=需修复后收口）**：M1（sanitize.ts pattern8 全角 only，生产 journal 半角形态 22/22 漏剥）+ M2（eval.mjs levelOf 漏裸 tag/episodic 行→误判 other，休眠缺陷）已修（pattern8 两形态并容 + MEM_TAGS 白名单 + 红牌 raw 计数兜底 + gitSha resolver + D1/client 测试补断言）；修复后三包门：vitest-core 231 files/2024 全绿（基线 230/2008+16=#74 新增 15+M1 用例 1）、vitest-proxy 47/368 逐位一致基线、typecheck-core 243 零漂移。Minor m3（脚手架查询+非法 time_point 返 400 非 skip，语义可辩护）与 Nit n1-n4 记录不修（本批边界外或已有兜底）。
