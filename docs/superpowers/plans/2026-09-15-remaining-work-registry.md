# 剩余工作登记簿（Remaining Work Registry）

> 文档标识：REG-REMAINING-001
> 日期：2026-09-15
> 维护规则：每完成一项打勾并注明 commit；新发现追加到对应分组。

## 分组 A · 召回质量（用户注入块可见，优先）

- [x] **A1 · FTS 复合词分词错位**（✅ 证伪关闭 2026-09-15：API 全链 buildFtsQuery 分词两侧一致，"组装器"实测命中——此前为裸 SQL 绕过查询分词的误报）
- [x] **A2 · dedup 召回率**（✅ cfe9eba：召回侧近重折叠 bigram Jaccard，阈值 0.25 实测校准——重复组 0.36-0.49 vs 非重复 ≤0.04 九倍分离；实测 6 行→2 行，Lane 2 全绿）
- [ ] **A3 · soul 标注透出覆盖率**（⚙️ 主修复已提交 76b1813：ftsResultToFormatable 补 soul 透传（与 vector 映射对齐）——但实测仍有路径缺标注（疑似 native-hybrid 分支的 FormatableMemory 构造点），需遍历全部构造点补齐；存量 soul 字段零 NULL（153/153 满列）已实锤，纯映射层问题）
- [x] **A4 · 11 组真实数据测试套件**（✅ 2026-09-15：11/11 ALL PASS——G1 身份段/G2 感受段宁缺毋滥/G3 锚方向/G4 折叠/G5 无误伤/G6 失效排除/G7 时间旅行双向/G8 租户隔离/G9 FTS 复合词/G10 durative/G11 valence 持久。套件自身两处预期修正均实锤系统语义正确：①tp 在记忆创建前→正确排除（bi-temporal）②time_point 仅 /v3/recall 贯通（P2.1 范围））
- [ ] **A5 · atomic/search time_point API 贯通**（本轮套件发现：时间旅行仅 /v3/recall 支持，atomic/search 忽略 time_point——管理面查询的时间旅行缺口，低优先）

## 分组 B · 鲁棒性（小而高价值）

- [x] **B1 · LLM 空响应 fail-loud**（✅ ac0899f + fd44634 对抗性审查收窄：仅纯文本任务（enableTools=false）抛错——工具流最终步合法无文本不误伤；空 text 抛错带 finishReason/completionTokens 上下文）
- [x] **B2 · 插桩清理**（✅ ac0899f：DEBUG-CFG 移除；DEBUG-GROW 保留为发现链路观测点，随 P4 清理）
- [ ] **B3 · Lane 2 时间探针弱断言**：0hits 空集 vacuous pass → 补非空断言
- [ ] **B4 · proxy 注释化妆**：proxy-config.yaml:495 过期 10.4.100.30 注释

## 分组 C · SOUL 迭代

- [ ] **C1 · 身份 GROW-MAINT**：slots 重验证/退场/演化（identity 内容含"P1–P3"类时效内容会过时）
- [ ] **C2 · 红线 pending 采纳**：4 项 strict_rule/core_value 提案待人工采纳（Panel 或 API）
- [ ] **C3 · 身份常驻注入**：无记忆轮次也注入身份段（当前 gating = 有记忆才有块）
- [ ] **C4 · 钩子路径租户贯通**：内部钩子路径 soul 前缀为空（端点路径已覆盖真实注入）

## 分组 D · 等外部条件（观察期，不主动）

- [ ] **D1 · P4**：evolution-worker + L2 失效传播 ｜ 等 conflict 观察期（2 周窗口 <5 边 → 先做 A2）
- [ ] **D2 · P5**：排序校准合成 + 九通道解禁 ｜ 等语料 ≥1200
- [ ] **D3 · 判官软轨** ｜ 等语料 ≥300
- [ ] **D4 · Lane 1 重建** ｜ 等语料 ≥500
- [ ] **D5 · 情感记忆检索**（R10 A/B 载体）｜ 等 D3
- [ ] **D6 · 权重密度语义裁决** ｜ P5 设计时
- [ ] **D7 · recordIds O(N)→索引路径** ｜ 大语料前
- [ ] **D8 · 自然观察**：锚 GROW-MAINT 演化（明日 12:23）/ kfyn 桶锚自发现（今晚 23:42）/ 归档率漂移 ±30%

## 优先级（按 价值/成本 比，B1 最高因防静默故障）

1. **B1** fail-loud（小，防复发）→ 2. **A1** FTS 分词（用户可见）→ 3. **A2** dedup 折叠（用户可见）→ 4. **B2/B3/B4** 卫生批 → 5. **C1** 身份演化 → 6. **C2** 红线采纳（需用户操作）→ 7. **C3/C4** 设计拍板 → 8. 分组 D 等条件
