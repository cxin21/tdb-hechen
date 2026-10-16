# 漂移再锚定研究报告（#43 · ADR0003-P3 research-only）— 2026-10-16

> 状态：**确定性取证完成**；LLM 在环漂移曲线实验 = ready-for-human 门（设计见 §5，执行需单独授权）。
> 本票不改生产代码（research-only 合同）；结论按「可拍板口径」给出（§4），拍板后立实施票。
> 研究问题（票面三问）：是否做 / 何时触发 / 成本多少。

## 1. 背景（ADR 0003 D3/§6）

ADR 0003 首期三时机冻结：会话头 + 每轮 state + 红线动作点近端（#39 已接线）。**漂移再锚定（identity: session_head_drift_reanchor）后置至 P3**，且触发阈值「须实测禁拍脑袋」（ADR §3 真实性边界）。本报告交付：漂移度量设计、重注入成本实测建模、触发器三候选对比与推荐。

## 2. 一手证据（本机实测）

### 2.1 渲染尺寸探针（确定性，43-render-probe.mts，production 形状播种）
- 播种形状与活体注入样本逐段同构：identity×6 + self_identity×4（dual 双槽）+ strict_rule×4 + 价值锚×9 + 重要的人×1 + 品格×2
- **BLOCK_CHARS=2425 / BLOCK_LINES=29 / CJK=1412**
- token 双界（CJK 1.0–0.6 tok/char + 非 CJK /4）：**1100–1665 tok（中值 ≈1.4K）**

### 2.2 前缀缓存实测台账（acp_cache，本会话 498 请求 / 72.18M tok 输入）
- 命中率 92.0%；中位数请求命中 99.1%（100–160K 输入档 93–99.2%）
- miss 构成：新内容 841K / 压缩重付 767.2K（40 folds）/ **上游 TTL·驱逐·中转轮换（不可归因稳定前缀 miss）4.15M（72%）**
- **中段前缀断裂实证**：11 个 seam 样本共 1.35M tok 再计费；13 个 provider-side miss 样本共 1.37M tok；单事件再计费 **101K–170K tok**（#172 111.7K 输入 hit 9.3%；#166 162.3K 输入 hit 0.0%）
- **尾部追加不破坏前缀**：470 个 tail-region 发散样本「shared history bytes untouched, prefix cache unaffected」
- TTL 效应：低命中请求的请求间隔中位数 27.8s vs 高命中 14.4s；idle 数分钟后全量重付（#420 idle 11m → 121.3K 重付）

## 3. 成本建模（确定性公式，参数取自 §2）

- **位置移动式重注入**（把身份块插到上下文中段）：再计费 ≈ 插入点之后全部 token（含块本身）
  - 110–180K tok 上下文档位实测：单事件再计费 ≈ 100–170K tok
  - 计价（Anthropic Sonnet 档 $3/M，写 1.25×/读 0.10×）：单事件 ≈ 1.15 × $3/M × S_after ≈ **$0.35–0.59/事件**（S_after=100–170K）
  - 公式：`cost_reanchor ≈ 1.15 × price × tokens_after_insert`
- **尾部提醒式**（每轮追加身份要义，不破坏前缀）：1.4K tok 全价新内容 ≈ **$0.0042/轮**
- **盈亏平衡**：`N* = cost_reanchor / cost_tail ≈ 124 轮`（150K 上下文档）。频率 < 1/124 轮 → 位置移动式便宜；更频繁 → 尾部提醒式便宜
- 敏感性：S_after=40K → N*≈33 轮；S_after=200K → N*≈165 轮（N* ∝ S_after）

## 4. 触发器三候选对比与推荐

| 候选 | 机制 | 成本 | 漂移相关性 | 依赖 |
|---|---|---|---|---|
| A 字符窗 | 每 X 字符重注入 | 恒定高频 | 弱（与漂移无因果） | 无 |
| B 轮数窗 | 每 N 轮重注入 | N*=breakeven 124 轮（150K 档） | 弱-中 | 无 |
| C 事件驱动 | #34 事件流（user_correction / tool_failure / task_switch）触发 | 零事件零成本 | 强 | **#28 evaluateStateEvent 已实现但零生产调用方（无分类器）** |

- **推荐：C 为主 + B 低频兜底（N 取 2×N* ≈ 250 轮起）；A 淘汰**（恒定成本、与漂移无因果、违反确定性门裁决）。
- C 前置基建：①#34 事件流分类器生产接线（#28 状态机已在库、SOUL_STATE_EVENT_KINDS taxonomy 已冻结）②soulOverlapJournal.enabled 生产开启（#26 已交付，当前运行时 config 未启用，无生产观测数据）。

## 5. 在线漂移探针设计（LLM 在环，ready-for-human）

- 改造 #31 静态探针（50 条渲染面断言）→ 会话级变体：N 轮模拟对话（无关任务填充轮）+ checkpoint k∈{1,4,8,16,32,64} 注入身份问答探针（问模型自身身份/红线/价值锚），按 #31 判分口径打遵循度 → **衰减曲线**
- 判分确定性：答案关键词判分器规则先行（确定性门）；LLM 语义判分需单独授权
- 预算：3 会话 × 6 checkpoint × 短答 ≈ 20 次轻量调用（估算 <$0.5）
- 落点：实施票（拍板后立）交付可执行脚本；本票只交设计（不改生产代码）

## 6. 三答案（可拍板口径）

1. **是否做**：有条件做——先零行为风险观测 2 周（journal 开启 + 事件流计数 shadow），漂移证据（user_correction 频率/分布）出现再上重注入；不建议立即上固定窗重注入（成本确定、收益未证 = 违反确定性门裁决）。
2. **何时触发**：事件驱动（user_correction≥1 即触发该会话重锚；tool_failure 突增作次级信号）+ 兜底轮数窗 N≥250 轮。
3. **成本多少**：事件驱动每事件 $0.35–0.59（150K 档实测推算）；固定窗每千轮 $3.2–4.8（N=250–166）；尾部提醒每千轮 $4.2（基准参照）。

## 7. 拍板项清单（ready-for-human）

1. 是否授权 LLM 在环漂移实验（预算/模型档位）
2. 触发器选型（推荐 C+B 兜底）
3. 前置基建是否先行（journal 生产开启 + #34 分类器接线票）
4. 实施票立票时机

## 8. 交叉引用

ADR 0003 §1-D3 / §3 / §6；#31 探针集（soul-identity-probes.test.ts + fixtures）；#37 SoulTimingConfig（identity: session_head_drift_reanchor 已冻结）；#34 事件流；#26 journal（soul-overlap-journal-observer，运行时未启用）；#28 evaluateStateEvent（零生产调用方）；#39 红线近端（首期三时机已闭合）。
