# 任务 2 设计小节：召回新信号 A/B（R-recall / R-identity / R-arousal）——呈拍板（v10 会话，2026-09-25）

- 状态：设计先行呈报，未实施零代码；拍板后按 RED→补丁→门禁→A/B→回切验证全流程执行。
- 证据基线：HEAD c07f75c；前置取证=td-agemem-recall-golden-anchor 技能（09-12 有害留档+D-5 shadow 报告）+A 深查总表（R 系开关生产真值）。

## 1. 三个信号的定义与前置事实

| 信号 | 机制位 | 生产真值 | 前置实证 |
|---|---|---|---|
| R-recall（R8 强化闭环） | reinforcementWeight，recall_count 对数加分 | 0 关断（yaml:83） | **D-5 shadow 09-22 实测 0/10 白开**（分量 0.009-0.032 被相关度分差吞没） |
| R-arousal（R10 情感显著度） | emotionSalienceWeight=\|valence\|×arousal 随池加权 | 0 关断（yaml:116「未过 A/B 不得置正」） | D-5 shadow 1/10 最大 3 位变化，无增益证据；09-12 结构信号组级有害留档（on 0.285-0.325 / off 0.325-0.345） |
| R-identity（identityRefs 排序信号） | 无现成通道（拟新增） | 不存在 | 纯设计提案，见 §2 张力裁决 |

## 2. F14-bis 张力正面回答：R-identity 裁定不实施

F14-bis 红线原文「身份相关性禁止参与召回排序（召回只由查询驱动）」，事故原型=回音室。R-identity 若把「支撑现行身份事实的记忆」加权，机制上正是**身份喂自身**：身份事实→加权支撑记忆→召回强化→GROW-MAINT 证据重算更壮→身份更稳固——与 R-A（情绪喂自身）同构的回音室变体。identityRefs 的合法消费面已经完整：F14 遗忘保护（scorer.ts:46-57）、注入徽章「核心事实」（auto-recall.ts 三构造点）、Panel 🧠 chips——**排序面缺席是红线的要求，不是缺口**。裁定：R-identity 不实施，登记为红线适用判定（与 D-5 维持关断同族）；F14-bis 与 R-identity 的张力就此正面回答并闭环。

## 3. R-A 红线与单一源纪律声明

- R-A（mood 不参与召回排序）：排序侧只读 L1 行级 valence/arousal 列（emotionSalienceOf，recall-signals.ts:189 独立纯函数）；**聚合量 computeMoodValence（mood-line.ts:41）永不进入排序**——两函数职责已分离、各只一份实现，单一源纪律满足，本设计不新增任何聚合副本。
- A/B 基线=「M1+M2 已启用」当前态（moodLine/characterTension enabled=true），对照含这两项的现行注入与排序。

## 4. 执行方案（R-recall/R-arousal 预注册 A/B）

1. **Golden 桶重建先行**（数小时工程主项）：测试桶 team-2j92u63hre 已清空（0 行）且 labels.jsonl 标注对应旧 1246 条语料跨语料无效——按 evN_* 对抗种子 SOP 重建结构化语料（覆盖 10 query 主题域，≥50 行含对抗/降级/边界样本），labels.jsonl 对新语料重标（每 query 3-5 正例+逐条理由），全程新桶零生产写入。
2. **重锚定线**：recall-anchor.mjs OFF 双跑确定性断言 → 新语料 P@5 重锚（**不沿用 0.345 旧线**，新基线−0.02=新验收线），runs JSON 归档+configSnapshot（embedding fingerprint+corpus 口径）。
3. **预注册 A/B ≥10 组同种子**：R8、R10 各自 ON（spec DEFAULT 值 0.03 起步）vs OFF，OFF 先行双跑防 bump 方向性污染（reconsolidationBumps 全落测试桶）；判据=预注册的 P@5 线+逐 query 位移归因通道。
4. **负增益诚实回退**：任一信号过不了线→维持关断+runs 归档留证；过线→呈报生产 yaml 置值再经你拍板（yaml 是运行真值，A/B 结论≠自动上线）。

## 5. 期望值管理（诚实披露）

D-5 shadow+09-12 两轮实证均指向「结构信号无增益、有扰动面」；本预注册的目的是**获得组级可裁决证据**（shadow 的 P@5 缺席与跨语料无效由重建弥补），不是翻案预期。若 A/B 再次负增益=关断裁决第三次确证，同样是有价值收口。

## 6. 边界

不触碰：生产 yaml 十开关值（A/B 全程临时网关 8422+临时 yaml，生产只读）、生产租户数据（bump 全落测试桶）、R-identity（§2 裁定不实施）、D2 预注册 A gated（本设计与 D2 判官路线互不代替，若你要求合并裁决请明示）。
