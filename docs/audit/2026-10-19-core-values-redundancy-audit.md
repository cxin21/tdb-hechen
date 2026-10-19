# core_values 锚冗余审计报告（2026-10-19）

> 只读审计，不落库；治理动作（alias 合并 / retireValue 退役）一律走人工裁决。生成：`node scripts/audit/core-values-redundancy-audit.mjs`

## 输入

- db: `D:\TDB\data\vectors.db`
- embedding: `doubao-embedding-vision` @ `https://ark.cn-beijing.volces.com/api/coding/v3`（生产同款，config-override.json）
- core_values 共 20 条；参与审计（theme/person/character）20 条；strict_rule 0 条（硬约束不参与冗余建议）
- 全对 cosine 分布（n=190）：p10=0.310 / p50=0.419 / p90=0.527 / max=0.669

## 分级结论

- A 建议 alias 合并候选（label 包含关系或 desc jaccard≥0.45，同 node_type）：0 对
- B 语义近重复观察（cosine≥0.60，同 node_type）：1 对
- C 轻度相关（0.55≤cosine<0.60，同 node_type）：4 对
- 跨 node_type 高相关（仅记录，合并语义危险，不建议）：7 对

## A 建议 alias 合并候选（人工裁决）

（无——2026-10-19 首轮报告唯一 A 级对「一手证据×端到端实证」已裁决并落地，见下节。）

## A 级对裁决记录（2026-10-19 已闭环）

- 对：一手证据（theme，auto-04402b1690，w=0.78，auto）× 端到端实证（theme，auto-252e5e2966，w=0.5，manual）。
- 触发源：「一手证据」的 alias「实证」被「端到端实证」label 包含——纯 alias 包含，label 本身互不包含，desc jaccard=0.015，cos=0.452（低于 B 线 0.60）。
- **裁决：模板②，保留双锚。** 理由：两条 desc 语义各有侧重、非同义——一手证据=「验证机制/定位缺陷时先亲跑测试、grep 源码取证」的证据来源纪律；端到端实证=「门禁全绿≠系统正确，跨票接缝盲区须真实数据+前后对照快照」的验证范围纪律。退役任一方都会抹掉一条真实价值轴；且端到端实证 3 条 coreRefs 独立绑定，退役会污染证据计数。
- **根因修复（已执行）**：摘除一手证据 attrs.aliases 中的过宽 alias「实证」（["实证"]→[]）。alias 在此是审计误报源：recountEvidence 的 label+alias 子串计证据会把「实证」族证据误归给「一手证据」，且 alias 包含关系会永久触发 A 级通道。摘除后一手证据仍保有 130 条直接 label/coreRefs 证据，远高于 minEvidence(5)，无误退风险；theme 渲染不消费 aliases（仅 person 行），渲染块零变化。
- **验证**：备份 D:/TDB/data/vectors.db.bak-r1-20261019；复跑本审计 anchors=20 pairs=190，A=0（清零）/ B=1 / C=4 / cross=7，B/C/跨类全线不变，确认修复无副作用。

裁决模板（逐对执行其一）：① 保留胜者（更完整 desc / 更高 weight / 更早 origin），另一方 attrs.aliases 追加败者 label 后 retireValue；② 若两条 desc 语义各有侧重（非同义），保留双锚并在胜者 desc 里吸收对方侧重点。

## B 语义近重复观察

| 锚 A | 锚 B | cosine | desc jaccard | label 包含 |
| --- | --- | --- | --- | --- |
| 独立(character，`c-auto-05cdb30a54`) | 求实(character，`c-auto-6d909bc793`) | 0.605 | 0.037 | 否 |

## C 轻度相关

- 根因 × 取证先行（cos=0.591）
- 端到端实证 × 门禁亲跑（cos=0.582）
- 数据完整优先 × 取证先行（cos=0.580）
- 一手证据 × 取证先行（cos=0.578）

## 跨 node_type 高相关（仅记录）

- 一手证据(theme) × 求实(character) cos=0.669
- 取证先行(theme) × 求实(character) cos=0.660
- 实测验证(theme) × 何晨(person) cos=0.654
- 端到端实证(theme) × 严谨(character) cos=0.640
- 数据完整优先(theme) × 求实(character) cos=0.615
- 门禁亲跑(theme) × 严谨(character) cos=0.607
- 用户拍板(theme) × 用户(person) cos=0.329（label 包含）

## 渲染端联动说明

- 本报告的扎堆在渲染端已由 MMR 多样性（coreMemory.soulRender.anchorSelect.scorer.mmrLambda=0.7）缓解：同族锚不再同时入选同一 block。
- 渲染端 desc cosine 去重通道（anchorDedup.embeddingThreshold=0.85）对本生产模型为诚实 no-op：本次审计全对 max cos=0.669，绝对阈值跨嵌入模型不可移植（docs/research/2026-10-19-soul-rendering-survey-2025-2026.md）。
- 长期正解=入库端查重：discover 提案已带 containmentGate（v2-router discover 路开启），新增同义提案被包含门拦截；存量冗余按本报告人工裁决。
