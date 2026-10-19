# core_values 锚冗余审计报告（2026-10-19）

> 只读审计，不落库；治理动作（alias 合并 / retireValue 退役）一律走人工裁决。生成：`node scripts/audit/core-values-redundancy-audit.mjs`

## 输入

- db: `D:\TDB\data\vectors.db`
- embedding: `doubao-embedding-vision` @ `https://ark.cn-beijing.volces.com/api/coding/v3`（生产同款，config-override.json）
- core_values 共 20 条；参与审计（theme/person/character）20 条；strict_rule 0 条（硬约束不参与冗余建议）
- 全对 cosine 分布（n=190）：p10=0.311 / p50=0.418 / p90=0.527 / max=0.669

## 分级结论

- A 建议 alias 合并候选（label 包含关系或 desc jaccard≥0.45，同 node_type）：1 对
- B 语义近重复观察（cosine≥0.60，同 node_type）：1 对
- C 轻度相关（0.55≤cosine<0.60，同 node_type）：4 对
- 跨 node_type 高相关（仅记录，合并语义危险，不建议）：7 对

## A 建议 alias 合并候选（人工裁决）

| 锚 A | 锚 B | cosine | desc jaccard | label 包含/alias 命中 |
| --- | --- | --- | --- | --- |
| 一手证据(theme，`auto-04402b1690`) | 端到端实证(theme，`auto-252e5e2966`) | 0.452 | 0.015 | 是 |

裁决模板（逐对执行其一）：① 保留胜者（更完整 desc / 更高 weight / 更早 origin），另一方 attrs.aliases 追加败者 label 后 retireValue；② 若两条 desc 语义各有侧重（非同义），保留双锚并在胜者 desc 里吸收对方侧重点。

## B 语义近重复观察

| 锚 A | 锚 B | cosine | desc jaccard | label 包含 |
| --- | --- | --- | --- | --- |
| 独立(character，`c-auto-05cdb30a54`) | 求实(character，`c-auto-6d909bc793`) | 0.605 | 0.037 | 否 |

## C 轻度相关

- 根因 × 取证先行（cos=0.589）
- 数据完整优先 × 取证先行（cos=0.582）
- 端到端实证 × 门禁亲跑（cos=0.580）
- 一手证据 × 取证先行（cos=0.577）

## 跨 node_type 高相关（仅记录）

- 一手证据(theme) × 求实(character) cos=0.669
- 取证先行(theme) × 求实(character) cos=0.662
- 实测验证(theme) × 何晨(person) cos=0.653
- 端到端实证(theme) × 严谨(character) cos=0.639
- 门禁亲跑(theme) × 严谨(character) cos=0.610
- 数据完整优先(theme) × 求实(character) cos=0.610
- 用户拍板(theme) × 用户(person) cos=0.322（label 包含）

## 渲染端联动说明

- 本报告的扎堆在渲染端已由 MMR 多样性（coreMemory.soulRender.anchorSelect.scorer.mmrLambda=0.7）缓解：同族锚不再同时入选同一 block。
- 渲染端 desc cosine 去重通道（anchorDedup.embeddingThreshold=0.85）对本生产模型为诚实 no-op：本次审计全对 max cos=0.669，绝对阈值跨嵌入模型不可移植（docs/research/2026-10-19-soul-rendering-survey-2025-2026.md）。
- 长期正解=入库端查重：discover 提案已带 containmentGate（v2-router discover 路开启），新增同义提案被包含门拦截；存量冗余按本报告人工裁决。
