# S-CHAR-2 品格张力检测 M2 实施计划（DS-SOUL-EVOLUTION-001 §2 配套）

- 日期：2026-09-24
- 状态：**已实施收口（2026-09-24，P1→P6 全链，见 CHANGELOG V9-M2 与 v9 台账 M2 行；生产启用 gated 待拍板）**。原定稿记录：spike 已过=燃料 18 张力锚 >> 止损线 2；何晨已拍板立项；执行会话按 P1→P6 串行，RED 先行，禁子代理
- 关键勘正（本计划与设计文档的前提差异）：**character 池已在生产活跃**（生产 yaml anchorDiscovery.character.enabled=true @tdai-gateway.yaml:185-189，minEvidence 3/maxPerPass 2/maxTotal 8；6 条 c-auto-* 锚 3 active/3 retired，origin=auto created_by=auto-growth，journal 2026-09-23 rationale 采纳痕迹）。设计 §2.1「给休眠池接燃料」前提修正为：**现有池聚合源=self_identity 槽事实（P3 品格锚分支），S-CHAR-2 增量=张力实例燃料 T1/T2 + 确定性门收紧**。池启用开关（character.enabled）已开；张力检测自身新增独立开关缺省关断。

## §0 开工前核验

1. HEAD ≥ 本计划 commit；门禁基线 core vitest 780/tsc 222/panel 144/web tsc 2（M1 后终态）。
2. 生产 moodLine 已启用（2026-09-24 拍板）——A/B 对照基线须以启用后状态为新基线（mood 行在场），勿与 d12af34 前旧基线混淆。
3. 读 DS-SOUL-EVOLUTION-001 §2/§7.2/§8（R-B/R-D）+ 母 spec F19 护栏四件/F15 分池。

## §1 现状实锚（本轮取证）

| # | 事实 | 锚点 |
|---|---|---|
| 1 | character 池配置解析已存在（enabled/minEvidence/maxPerPass/maxTotal，clamp） | MemoryCore/src/config.ts（anchorDiscovery.character 解析块，person 同族 clampC 模式） |
| 2 | 池生产启用 | tdai-gateway.yaml:185-189 |
| 3 | character 锚渲染现状：价值锚行含 character（activeAll 只滤 person）；感受段已排除（directional filter node_type==='theme'） | soul-assembler.ts（active=activeAll.filter(node_type!=='person')；directional.filter 主题锚） |
| 4 | 现有池燃料=self_identity 槽事实聚合（P3） | anchor-growth.ts character 分支（GROW 调度） |
| 5 | T2 数据面：coreRefs 反查 valence 分布可行（spike SQL 已验证） | l1_records.metadata_json.coreRefs=[label]（JSON 数组）+valence 列 |
| 6 | identity-discovery 双视角 worker+确定性门+proposal-dedup | identity-discovery.ts（selectSampleRows/双视角 prompt/分级门）；proposal-dedup.ts（IF-4：narrative/characterProposal 不入比对域，现状 slot 白名单行为不变仅钉文档） |
| 7 | R-B 已满足：character 不入感受段 | soul-assembler.ts directional filter |

## §2 实施步骤

### P1 store 只读查询（T2 数据源）
- types.ts 追加可选方法（IF-1 同款可选签名先例，mood 的 recentAffectSignals? 同位）：
  `anchorEvidenceValences?(tenant?: CoreTenant): MaybePromise<Array<{ label: string; valence: number; ref_kind: 'coreRefs' | 'identityRefs' }>>`
- sqlite.ts 实现：l1_records metadata_json LIKE '%coreRefs%' AND valence IS NOT NULL，JSON.parse 后按 label 展开（node 侧解析，单查询全量+进程内聚合；租户三元组硬隔离）。只读零写库。
- 单测 ≥3：隔离/NULL 排除/label 展开。

### P2 character-tension.ts 单一源纯函数（RED 先行）
- `detectEvidenceSplit(anchorLabel → valences[], minInstances): { tension: boolean; pos: number; neg: number; tensionRefs: Array<{recordId?}> | null }`
- `detectEvolutionReversal(before, after, labels): { tension: boolean; reversed: string[] | null }`（T1：价值域 label 匹配+极性对照；「不做 X」→「做 X」极性词对照表确定性实现）
- RED ≥8：minInstances 边界/全正/全负/分裂/空输入/确定性/T1 正反向对照/极性词表命中。

### P3 检测接线（确定性门，config-first）
- config：`memory.coreMemory.characterTension.{enabled=false, minInstances=2, maxCandidatesPerPass=2}`（解析 clamp 同 anchorDiscovery 族；**enabled 缺省 false=逐位现状，生产启用=A/B 后呈报**）。
- T2 挂点=GROW-MAINT recountEvidence 周期（anchor-growth.ts GROW-MAINT 段）；T1 挂点=upsertCore version++（identity-discovery 采纳路径）。候选张力实例只入内存传递，不落表（O14 边界）。

### P4 identity-discovery 提案链（IF-3 宽松读取）
- worker prompt 增第三产出字段 `characterProposal: {label, rationale, tensionRefs}`（宽松读取：旧输出无字段=逐位现状）。
- 确定性门：tensionRefs 数≥minInstances + F19 护栏四件（ev≥minEvidence/maxPerPass/maxTotal 分池/(node_type,label) 复合去重）+ F15 character 池配额（生产 3/2/8）→ 走既有 upsertCore 落库（R-D：不新造第二套门）。
- proposal-dedup.ts：IF-4 文档钉死（characterProposal 不入 pending∪已采纳比对域）+守卫用例 1 条。

### P5 渲染迁移（行为变更，A/B 主对象）
- 现状：character 锚混入价值锚行（实锚 3：soul-assembler active filter）→ 改为「我是谁」小节尾新行 `我的品格：label(方向·w)：描述`（§2.3）；**价值锚行排除 character**（与感受段同 filter 对齐）。
- 快照守卫：characterTension.enabled=false 且池为空→逐位现状；enabled 且有品格锚→价值锚行不含 character+品格行在场。
- UI：ValueAnchorsPanel/锚面板展示随 node_type 既有类型徽标位自然承载（零新增，验证即可）。

### P6 验收与收口
- A/B：同种子 ≥10 组（张力语料合成租户 + 生产租户快照）；负增益（含 KV 抖动/品格行翻转频率）诚实登记回退；红线 R-B（不入感受段）与 R-C 扩展（品格张力不产生 identityRefs——蒸馏物非事实）断言化。
- 门禁：core vitest ≥780+新增/tsc 222/panel 144/build+bundle/密扫 \b/双重启/CHANGELOG/台账四态。
- 渲染迁移属注入行为变更：逐字节快照对照 + 呈报数据一并记录（本次拍板已覆盖立项，渲染迁移若 A/B 出现负增益回退并单独呈报）。

## §3 边界（明确不做）

- 不建张力史表（O14 边界维持）；不新造确定性门（R-D）；T1 极性词表只做确定性匹配不做 LLM 极性判定；提案语义去重沿用 P1 闸门（0.75）不改比对域（IF-4）。
