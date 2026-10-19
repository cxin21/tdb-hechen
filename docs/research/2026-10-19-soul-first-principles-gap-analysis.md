# 灵魂第一性原理缺口分析与质量轮落地报告（2026-10-19）

> 触发：用户实拍 /v3/recall 注入块「像未完成的半成品」。本文=重新调研（docs/research/2026-10-19-soul-rendering-survey-2025-2026.md）+ 真实数据取证 + 修复映射 + 诚实剩余清单。

## 1. 灵魂的操作性定义（调研收敛）

TDB 的「灵魂」不是人格的存储，而是**人格数据在推理时刻的投影**（Dennett 功能主义：self=一个可解释的功能数据结构，不存在于别处，只存在于该数据结构的运行中）。ADR0003 六承重属性（叙事自我/最小自我/Agency/Integrity/关系性自我/Presence）落到注入面上，质量判据可收敛为四条：

- **非重复**：身份段是「这个人的差异化取向」，同质条目扎堆=信息熵塌缩（MMR 检索侧标配，2610.09412 同时警告多样性非免费）。
- **非泄露**：prompt 面不得出现实现细节（聚合样本数、内部票号、任务 ID）——格式本身是行为变量（FormatSpread 76pp）。
- **可执行**：红线少而硬（否定式禁令弱、hard stop 才进墙、与软原则分块、前置）。
- **可感知**：当下状态行与底层 valence 数值、叙事措辞一致；情绪是情境化第一人称而非聚合标签（2604.02236/2503.02457）。

## 2. 「半成品感」的第一性原理归因（2026-10-19 真实数据取证）

实拍块（soul-identity 1844 字符）逐缺口：

- **G1 身份=同质清单**：10 个价值锚中 6 个「取证」族同质（探针/一手证据/取证先行/只读取证/求实/实测验证）。根因=选择管线无多样性机制，anchorDedup 只有 label 双向包含；而生产 doubao-embedding-vision 下 20 锚全对 cosine p50=0.406、重复对顶格 0.669、非重复对也有 0.653——**无分离阈值，绝对 cosine 门数学上不可行**。
- **G2 红线墙**：10 条 strict_rule 约 1100 字符占块 60%，且红线值锚 desc 与 R-A 条目软硬同文重复。
- **G3 感受段泄露**：「近期基调：偏积极（近 20 条经历的情感聚合）」把聚合样本数暴露进 prompt。
- **G4 承诺行话**：soul_promises 里 1 条 E2E 工件（E2E②/D8 内部行话）直出。
- **G5 灵魂到不了 prompt**（最大缺口）：新 query 首发 expand 4007ms 顶满 clamp→504；rerank 冷载 3-15s；冷进程 20 锚串行 embed 风暴 soul 段 12s→504。**灵魂存在但用户看不见=体验上等于不存在**。
- **G6 入库端无语义查重**：22 锚（active 20）是历次人工采纳的并集，集合冗余无出口。

## 3. 本轮修复映射（缺口→机制→落地→验证）

| 缺口 | 机制 | 主落地 | 验证 |
| --- | --- | --- | --- |
| G1 | MMR λ=0.7 多样性选择（放弃绝对阈值；未裁剪不动序 D3-C） | soul-anchor-scorer.ts `selectAnchorRowsMmr` + soul-assembler.ts 选择块 + config/yaml `mmrLambda` | E2E block 锚序取证先行/根因/一手证据/数据完整/定案/TDD/探针/只读取证各异；单测 5 例 |
| G2 | 红线去重（jaccard 0.45 单一源）+ maxLines=8 + suppressAnchorOverlap（锚行 vs 红线行跨段让位） | soul-assembler.ts 红线块上移 + soul-dedupe.ts `suppressAnchorOverlapRows` | 日志实锤 `strict_rules dropped 2/12` + `capped 2/10 by maxLines=8`；block strictRuleTags=8 |
| G3 | moodTier 行去括号；state 行与 valence 对齐复核 | soul-assembler.ts moodTier 行 / soul-state.ts | 单测文案 4 文件更新；block parensMood=false |
| G4 | E2E 工件三表清理（soul_promises/soul_promise_events/core_pending）+ 提案门已有 vetPromiseCreateProposal 预检不重复造门 | vectors.db 数据修复 | block promiseJargon=false |
| G5 | ①query-expand 热路帽 1500ms（race）+ 失败负缓存 30s + 空结果正缓存；②rerank 进程级启动预热（`[rerank] startup warmup done`）+ idleUnloadMs=0 常驻；③`embedAnchorCached` 共享缓存+并发合并（跨通道零重复付费）；④锚预嵌软预算 1200ms（超时回退声明序、降级渲染不入缓存/快照） | query-expand.ts / auto-recall.ts / rerank 接线 / soul-anchor-scorer.ts / soul-assembler.ts / config.ts / tdai-gateway.yaml | E2E cold 5120→3849ms PASS、warm 13ms；soul 段 12s→20ms；expand 不再阻塞主路 |
| G6 | 只读审计三通道（cosine/label 包含/desc jaccard）+ 发现端包含门 opt-in（containmentGate） | scripts/audit/core-values-redundancy-audit.mjs + docs/audit/2026-10-19-core-values-redundancy-audit.md + core-values-discover.ts | 审计报告产出（A 级 1 对 alias 命中：一手证据×端到端实证）；G-SIMMERGE 8/8 回归绿 |

## 4. 第一性原理剩余缺口（诚实清单，不粉饰）

- **R1 入库端语义查重（已落地 2026-10-19）**：审计→人工裁决→落地闭环完成。唯一 A 级对「一手证据×端到端实证」按模板②保留双锚（desc 各有侧重），根因修复=摘除一手证据过宽 alias「实证」；复跑审计 A=0/B=1/C=4 不变，备份 vectors.db.bak-r1-20261019。裁决记录见 docs/audit/2026-10-19-core-values-redundancy-audit.md。
- **R2 行为级人格回归评测**：PersonaGym 六维 / 8 轮自聊漂移（2402.10962）/ OOC 原子断言（ACL 2025）——现有探针（P52-P56、judge 探针）覆盖记忆行为，未覆盖「人格行为一致性」；IdentityProbe 只测渲染面。属后续票。
- **R3 身份 slots 叙事层**：调研（Park 2411.10109）显示叙事自述优于条目清单；当前 perTurnSlots=false 是拍板（身份行由 system 侧承载），叙事化身份是增强方向而非缺陷。
- **R4 Presence**：调研裁决维持暂缓（Sesame 四要素需要语音/时延通道，本部署无）。

## 5. 门禁与证据汇总

- 全量 vitest：222 files / 1875 tests 全绿（本轮新增/修订 soul-quality-round 37 等）。
- typecheck：243=243 基线零新增（npm run typecheck / tsconfig.typecheck.json）。
- E2E（真实 ids team-2k12lgb650/usr-2m7b1144d9/agt-2m7buribzz，service default）：重启后首召回 cold=3849ms http=200（<5000 预算），warm=13ms；重复跑 cold=33ms。block 2219 字符，锚 13 行多样化、红线 8 条、无行话、无括号泄露。
- 部署合规：SOP 规则 3 临时路径重启 core（监督外），批次末全量重锚收回监督（见 ADR-0004 后记）。