# 剩余工作登记簿（Remaining Work Registry）

> 文档标识：REG-REMAINING-001
> 日期：2026-09-15
> 维护规则：每完成一项打勾并注明 commit；新发现追加到对应分组。

## 分组 A · 召回质量（用户注入块可见，优先）

- [x] **A1 · FTS 复合词分词错位**（✅ 证伪关闭 2026-09-15：API 全链 buildFtsQuery 分词两侧一致，"组装器"实测命中——此前为裸 SQL 绕过查询分词的误报）
- [x] **A2 · dedup 召回率**（✅ cfe9eba：召回侧近重折叠 bigram Jaccard，阈值 0.25 实测校准——重复组 0.36-0.49 vs 非重复 ≤0.04 九倍分离；实测 6 行→2 行，Lane 2 全绿）
- [x] **A3 · soul 标注透出覆盖率**（✅ 终极闭环 2026-09-15：R-A1 分离携带的 soul 从未并回 keyword 通道 formatable——三处构造点全部补齐（fts 76b1813 / record+池插入 66cdca0），**用户产线注入块目视 4/4 全标注**；终极根因 = 分离携带设计未在池插入并回）
- [x] **C2 · 红线 pending 采纳**（✅ 2026-09-15：core_value 1 条 + strict_rule 3 条合并经 API 写入，source=human-adoption，注入块实时呈现）
- [x] **C1 · 身份 GROW-MAINT 修订制**（✅ 5872811：prompt 修订制 + slots 全文透出；staleness 场景实证 v3 修订采纳；**产线自然演化实证**——identity 内容自动更新至"P0–P2.1 与 P3 已全部落地…剩余 P4/P5 处于自然观察期"v2）
- [x] **A4 · 11 组真实数据测试套件**（✅ 2026-09-15：11/11 ALL PASS——G1 身份段/G2 感受段宁缺毋滥/G3 锚方向/G4 折叠/G5 无误伤/G6 失效排除/G7 时间旅行双向/G8 租户隔离/G9 FTS 复合词/G10 durative/G11 valence 持久。套件自身两处预期修正均实锤系统语义正确：①tp 在记忆创建前→正确排除（bi-temporal）②time_point 仅 /v3/recall 贯通（P2.1 范围））
- [x] **A5 · atomic/search time_point API 贯通**（✅ d2dd15e：双 trim 点 validityNow 双时态过滤（vs ≤ tp < ve）+ 原始 body 读取（generated schema 不动）；实测效期内复活/现在排除双向正确）
- [ ] **A6 · /capture 端点租户隔离缺口**（⚙️ Phase 1 完成 76f7ceb：headers→CompletedTurn→performAutoCapture→l0Record 四级贯通，L0 归属实测正确落 l5ug 桶。**Phase 2 待做**：pipeline 任务/提取 traceContext 的租户贯通（scheduler notifyConversation → L1 任务 → l1-extractor traceContext 三跳）——未完成前带头 capture 有 L0(l5ug)/L1(default) 分裂风险。产线真实会话不受影响（recall 钩子副作用 capture 自带隔离））
- [x] **A7 · coreRefs 机制三层验证 + 回填**（✅ 0324f9b：①机制全链在位（l1-dedup:190 loadValueCandidates→prompt 候选清单→parse 过滤→attach）②存量 7 锚→90 记忆一次性回填（双表同步）③90/90 零误标（70 字面回填+20 语义标注互补——LLM 捕获大小写变体 sdd→SDD）④新提取的自动标注待 A6 修复后生效）

## 分组 B · 鲁棒性（小而高价值）

- [x] **B1 · LLM 空响应 fail-loud**（✅ ac0899f + fd44634 对抗性审查收窄：仅纯文本任务（enableTools=false）抛错——工具流最终步合法无文本不误伤；空 text 抛错带 finishReason/completionTokens 上下文）
- [x] **B2 · 插桩清理**（✅ ac0899f：DEBUG-CFG 移除；DEBUG-GROW 保留为发现链路观测点，随 P4 清理）
- [ ] **B3 · Lane 2 时间探针弱断言**：0hits 空集 vacuous pass → 补非空断言
- [ ] **B4 · proxy 注释乱码修复**（⚠️ 升级认知：proxy-config.yaml 全文件中文注释预存乱码 299+ 行（部署时编码链损伤，注释不影响功能）。恢复尝试已逆转。**正确方案已明确**：从 MemoryProxy/config.yaml 模板重灌注释段（生产=模板+6 处差异，见 deploy/tencent-cloud/config/proxy/CLOUD-DIFF.md）——精细运维操作，择机独立执行）

## 分组 C · SOUL 迭代

- [ ] **C1 · 身份 GROW-MAINT**：slots 重验证/退场/演化（identity 内容含"P1–P3"类时效内容会过时）
- [ ] **C2 · 红线 pending 采纳**：4 项 strict_rule/core_value 提案待人工采纳（Panel 或 API）
- [ ] **C3 · 身份常驻注入**：无记忆轮次也注入身份段（当前 gating = 有记忆才有块）
- [x] **C4 · 钩子路径租户贯通**（✅ 证伪关闭 2026-09-15：MemoryProxy 注入器明示"主链路（瘦传输）调 /v3/recall 拿组装好的注入块"——**生产注入仅端点路径**，内部钩子（tdai-core.recall）无产线调用方；其全局召回隔离缺口登记为潜在项（仅当未来启用进程内召回才需修））

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
