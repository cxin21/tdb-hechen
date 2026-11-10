# ADR-0028 人格卡 v3：声明 × 缓慢趋近、两段注入、清库重生

- 状态：已实施（2026-11-07）；取代 [ADR-0026](0026-soul-self-maintenance-six-layers.md) 与 [ADR-0027](0027-soul-episode-layer.md)
- 决策者：何晨（拍板：影响而非覆盖、去掉启停总闸、清库重生、人格卡必须完整）
- 规范：`docs/specs/2026-11-07-soul-production-grade-spec.md`（v3.7，唯一权威；issue #180）
- 运行手册：`docs/soul-self-maintenance.md`

## 背景：三个结构性错位（复核后仍成立）

1. **记录工具冒充人格**：八层里有七层是「我做过什么」，92.3% 条目是关系史/自我史流水账，卡里没有名称、形象、使命、特质。
2. **派生视图当事实**：persona 条目 id 由 `layer:hx-hash(kind|text|首个episodeId)` 生成，滑出 7 天窗口就判 `freeze`——232 条事件史只有 47 条活着（20.3%），190 条永久退出注入，且原因全是 `episode_history`。
3. **注入与判据两套口径**：读侧渲染、写侧门、承诺兑现各用一套「修复」正则；人格卡还散在 `soul-assembler` 的字符串拼接里，无法版本化、无法观测。

## 决策

### D1 一条产线、一个写者

`soul_persona` 生产唯一写者是 `runSoulMaintenance` 的 `commitSoulPersona`（单事务，含红线投影与账本）。identity 发现并入同一候选数组（`collectIdentityFacts`），不再有第二个写者。

### D2 状态机四态 + 时间区间

ADD / UPDATE / INVALIDATE / NOOP。滑出窗口不再 `freeze`，改写 `validTo`（`meta_json`）+ 权重×0.5；被取代写 `supersededBy`；渲染只取未失效。事件层改归档（`soul_episodes.archived_at`），事实从全量史派生，不再硬删。

### D3 特质：轴承载状态，标签是视图

6 轴（亲和/主导/严谨/开放/稳定/守界）承载漂移，`α=0.02`、单 tick 每轴 ≤0.05、`Σ|state|≤0.5`；标签是空间里的方向向量，由判侧提议、四闸准入（结构/去重/证据≥3/显示阈值），名字与注解冻结不重算。理由：`Σ=1` 的词表归一会让「加一个新特质」稀释全部旧特质；词表越长标签越互相关（16→5 的教训）。

### D4 注入两段，都在插件

稳定段 = `systemPrompt.section` 的人格卡（getter、冻结、后台刷新）；每轮段 = `agent/pre-step` 尾部 volatile（≤400 字符、append-only、producer-owned、两级去重）。Core 只提供只读接口；失败 fail-open 并留因。

### D5 人物设定是外生的，人格是内生的

Panel 表单只写「属于人物设定的部分」（名称/自称/形象/说话方式/使命/种子特质/红线），落 `meta_agent_persona`；经历只**缓慢影响**这些设定（不是覆盖、不是否决）。红线双源：声明行（随表单 retire）+ 用户拍板原话（只 append）。

### D6 清库重生

改造前数据一律丢弃（`soul_*` 全清、`episodeWatermark` 写清库时刻）；不做兼容读取、不做迁移。退役面：`core_pending`/提案通道、`core_values`、`anchor_growth_state`、`slot-import`、`soulMaintenance.enabled`、`role_prompt`/`rules_prompt`、插件 `volatile.soul.*`。

## 后果

- **好的**：卡可版本化（`version/hash/chars`）、注入可对账（`soul_snapshots.payload_json` + `journal kind=injection`）、漂移可追（账本带 `protocol_version`）、事实不再退化（`validTo` 取代 `freeze`）。
- **代价**：稳定段要复核总长（head pack 4565 + 卡 ~500–1600，上限 8000）；特质漂移需要判侧 LLM 每 tick 一次（受 6h 节流）；清库后需要真实对话重新长出关系史与底色。
- **不宣称**：有限轴集覆盖不了全部特质——`axis_gap` 与 `AXIS_VERSION` 是唯一合法的加轴入口；情绪标签仍有零实例类别，那属于语料边界，不是实现缺失。
