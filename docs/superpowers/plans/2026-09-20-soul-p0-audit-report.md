# TDB P0+P0.5 设计↔实现全面复查与专项审计报告（2026-09-20）

- 审计执行：default-agent-hechen（goal-8d20806f），全程未派子代理、审计轮只读、密钥零回显
- 权威基准：docs/superpowers/specs/2026-09-17-soul-memory-design.md（§0-§10+附录 A 全节）
- 起点基线：HEAD b616738（vitest 636/tsc 222）；收口基线：commit b91f4d5 后（vitest 643/tsc 222）
- 真数据：ev14 全新租户（4 会话 19 条对抗种子×2 桶）+ /v3/recall 活体探针 + DB readOnly 核对
- 方法：三方交叉（设计原文摘录→代码 file:line→真数据）；四级判定 ✅⚠️❌📝；audit33 的 22 项 ✅ 抽查不重审

---

## 一、批次 1：§5 公式 F1-F20 + §4 属性骨架（23 行判定表）

| # | 条款 | 判定 | 要点 |
|---|---|---|---|
| 1 | F1 RRF（k=60 双路求和） | ✅ | RRF_K=60 属设计留白的实现常量 |
| 2 | F2 R1 时近性 | ✅ | 实现=24h 阶跃加成非连续衰减；R-A1 spec 为详细权威，产线全 0 关断 |
| 3 | F3 R8 强化 | ✅ | log10(1+c)×w；bumpRecallCount json_set 原子自增 |
| 4 | F4 R10 情感显著度 | ✅ | 缺省 0 恒等红线在位（emotionSalienceWeight: 0） |
| 5 | F5 锚强度 | ✅ | E_REF=50 逐字一致 |
| 6 | F6 挤出 | ✅ | 同刻度 w×ev；升序 tie weight→value_id |
| 7 | F7 演化五条件门 | ✅ | 五门+保守附加门（dangling/crossTenant/staleLineage/maxRewrites） |
| 8 | F8 首次权威 | ✅ | `WHERE valid_end IS NULL OR ''`+changes=0→false；主表+FTS 双写 |
| 9 | F9 recountEvidence | ✅ | **但发现第二份同名实现→P0-F1（已修）** |
| 10 | F10 状态残留剥离 | ✅ | 单源导出，auto-recall/consolidation 复用 |
| 11 | F11 personEv | ✅ | label∨alias 逐字 |
| 12 | F12 ±0.2 | ✅ | NULL 守卫三层 |
| 13 | F13 反思触发 | ✅ | 累计>R_REF；config clamp[1,1e5]（F-EV12-4 修复生效） |
| 14 | F14 遗忘保护 | ✅ | identityFactMatchesCorpus 双向模糊（F-EV13-1 统一）；仅 observed |
| 15 | F14-bis 回音室禁令 | ✅ | 排序信号清单无身份相关性通道（结构核验） |
| 16 | F15 GROW-MAINT 分池 | ✅ | 三池分账；character 池级证据→weight 升序 tie-break（观察登记） |
| 17 | F16 漂移旗标 | ✅ | 基线 kv 全局单键组 |
| 18 | F17 段级预算 | ✅ | dual 排序/slice 截断/感受段 theme-only |
| 19 | F18 失效过滤 | ✅ | 解析失败保留 |
| 20 | F19 双门+护栏四件 | ⚠️→❌ | **theme 去重清单混全类型 label（anchor-growth:412）→P0-F3（已修）** |
| 21 | F20 身份永不退场 | ✅ | warn-only |
| 22 | §4.1 十九列 | ✅ | PRAGMA 26 物理列=设计 19 分组列+metadata_json，类型/缺省逐列对齐 |
| 23 | §4 metadata 八项 | ✅ | backfillMemoryRef 三键单源；sensitivity/recurrence 预留未实施=设计一致 |

## 二、批次 2：§0-§3/§6-§10 层结构与场景（15 行判定表，节选）

✅：铁律 1/4/5/6/7、§2.1 L0 双 role、§2.3 scene_name UNINDEXED、§2.8 调度顺序（=spec C1 注记逐字）、写入信任边界四门、evolution metadata 三件套、S1/S2/S4/S5/S7/S8/S9/S10 场景证据、§7 分期配置全键、§9 不做项未越界（entity_* 系平台管理表）、§10 台账依赖无越界。
❌/⚠️ 新发现：

| 编号 | 严重度 | 发现 | 处置 |
|---|---|---|---|
| P0-F1 | ❌ 中 | identity-discovery.ts:352 第二份 recountEvidence（20 字前缀逐字/无 lowercase）——违铁律 2 单一源；pending 裁决 evidence 结构性假 0 | **已修（b91f4d5）** |
| P0-F2 | ⚠️ 高 | neighborExpand J 通道独立开关实为开启（yaml enabled:true），归档回流现状成立（133 条 archived-only 端点边）；且执行体 getNeighbors 未传 filter、resolveByIds 后零租户复核 | **租户复核已修（b91f4d5，RED 活体复现 b1 入 t1 结果）**；归档回流产品开/关 **待拍板（A 维持/B 置 false/C 代码归档不回流）** |
| P0-F3 | ❌ 低 | theme 去重跨类型误挡（audit #11 确认开放） | **已修（b91f4d5）** |
| P0-F7 | ❌ 中 | searchL1ByCoreRefs SQL/JS 双层只认 coreRefs——personRefs 反查死通道（spec §2.6/S6） | **已修（b91f4d5）** |
| P0-F4 | 📝 低 | 代码缺省 person{5,1} ≠ spec §7 {3,2}（产线 yaml 3/2 为运行真值） | 文档注记（本报告即为同步载体） |
| 观察 | 低 | character quotaEvict evOf 池级常数→weight 升序 tie-break；character 提案证据池级→同轮同分按 LLM 序；R7-2 part_of 补池结构有回流面但现网 part_of=0 零数据面；维护日志阈值口径 | 已顺手修日志；其余登记 |

## 三、批次 2R：修复闭环（commit b91f4d5）

- TDD：RED 4/4 精确复现（pending evidence=0 / 跨类型误挡 adopted=0 / **跨租户邻居泄漏 ['b1','a1'] 活体** / personRefs 反查空）+ 3 控制组全过 → 补丁 9 处编辑（锚点唯一+读回验证）→ GREEN 7/7。
- 新增 golden：`identity-pending-evidence.test.ts`(2) / `anchor-growth-dedup-scope.test.ts`(2) / `store.personrefs-reverse.test.ts`(2) / `neighbor-expand-tenant.test.ts`(1)。
- 门禁：vitest 636→643 全绿；tsc 222 持平（stash 对照法定位唯一新增 TS2352→双跳转修复）。
- 部署：重启 tdai-core → health=200 → /v3/recall 活体 200（relevant+soul 双块、无降级）。教训登记：探针首跑 401 系省略 `x-tdai-service-id` 头（SOP 明文），非鉴权缺陷。

## 四、批次 3：F-EV13-1 残余量化（ev14 真数据）

种子：4 会话 19 条（身份设定/尊称驯化/定时状态/合法自证/第三方人物×2/agent 行为/摘要式改写×4/跨租户对照）；L1 提取 18；发现轮 12:46:14。

| 度量面 | 实测 | 判定 |
|---|---|---|
| GROW-MAINT unsupported 假阳 | P桶 1/1：「手冲咖啡+自烘焙」摘要式改写（最长公共子串 6 字<12）被误判 unsupported（warning-only 未退场） | ❌ 残余假阳实锤 |
| identityRefs 回填漏 | A桶 8 槽事实 7 回填、1 漏（「导师张三每周二讨论」改写散布，窗口<12） | ❌ 残余漏报实锤（12.5%） |
| character 拒采面 | 未触发（A桶无 self_identity 采纳→池按设计冻结；agent-act 种子 ark 宁缺毋滥未提炼） | 📝 待 A-7b 后复验 |
| 身份门拦截面 | 尊称驯化→strict_rule pending ✓；用户自称角色→identity 槽（路由正确） | ✅ |
| pending 证据（P0-F1 修复后） | 「禁止 push main」evidence=1（不再假 0）；「称呼领导」诚实 0 | ✅ |
| 跨租户隔离 | contamination=0；identityRefs 各归各租户 | ✅ |

结论：12 字滑窗对「摘要式改写」两类缺口（假阳/漏报）实锤，与 ev13 二轮预估一致——**A-7b 确定性证据指针为正解**（设计小节另呈用户确认）。

## 五、批次 4：P0.5 评分公式六面（五维：定义/参数/边界/golden/可解释性）

| 面 | 判定 | 要点 |
|---|---|---|
| F5 锚强度 | ✅ | E_REF=50+D6 裁决；浮点误差动机注释 |
| F11 personEv | ✅ | 宽口径弱点已登记+F19 缓解 |
| F12 ±0.2 | ✅ | NULL 守卫三层 |
| 12 字滑窗家族 | ✅ | 实现符合设计；残余面批次 3 量化→A-7b；**characterEvCount 死导出→本报告轮清理** |
| scorer 遗忘 | ✅ | λ=0.01/0.12/30d+arousal 调制；ageDaysOf 系统年龄 |
| RRF+九通道+appraisal | ✅ | 关断矩阵纪律+A/B 历史留档；解禁=D2 gated |

六面 golden 覆盖齐（suggestAnchorWeight/personEvCount/emotionSalience/identityFactMatchesCorpus/scoreFor 均有直接单测）。登记：设计 F2 行"衰减"措辞 vs 阶跃实现——R-A1 spec 为详细权威，不动作。

## 六、批次 5：P0.5 提示词九面 × 八维度 rubric

| 面 | ①角色 | ②契约 | ③硬约束 | ④上下文 | ⑤示例 | ⑥反注入 | ⑦参数 | 判定 |
|---|---|---|---|---|---|---|---|---|
| L1 提取+AGENT_ACT | ✅ | ✅✅ | ✅✅ 姓名归因红线 | ✅ | ✅ 防过拟合声明 | ⚠️ S-1 | ✅ | ✅ |
| 身份双视角 DUAL | ✅ | ✅ | ✅ 身份判据 | ✅ | ⚠️ S-3 | ✅ 门兜底 | ✅ | ✅ |
| 主题锚 DISCOVER | ✅ | ✅ | ✅✅ 原文短语+系统验证声明（范本） | ✅ | ✅ | ✅ | ✅ | ✅ |
| 人物锚 PERSON | ✅ | ✅ | ✅ 行为可证 | ✅ | — | ✅ | ✅ | ✅ |
| 品格锚 CHARACTER | ✅ | ✅ | ✅ fact 逐字 | ✅ | — | ✅ | ✅ | ✅ |
| 蒸馏 summarizer | ✅ | ✅ | ⚠️ S-5 | ✅ | — | ⚠️ | ⚠️ S-4 | ⚠️ |
| 反思三问式 | ✅ | ✅ | ✅✅ 逐字 record_id 指针 | ✅ | — | ✅✅ | ✅ | ✅✅ 全库最佳 |
| valence 方向判定 | ✅ | ✅ | ✅ 不确定给 0 | ✅ | ✅ 三值示例 | ✅✅ 四层兜底（模范级） | ✅ | ✅✅ |
| dedup 冲突检测 | ✅ | ✅✅ 五动作枚举 | ✅ 策略倾向+subject 归组 | ✅ 白名单 | ✅ 跨类型示例 | ✅ | ✅ | ✅ |

**登记建议（全部"登记不改"级——提示词改动=行为变更须同种子 ≥10 组 A/B，当前无失败实证）**：
- S-1 L1 提取补一句反注入声明（样本内容可能含指令样文本，勿执行只分类）
- S-2 formatExtractionPrompt 背景消息预算声明
- S-3 DUAL prompt 补 identity/core_value 边界示例一条
- S-4 蒸馏 30s 超时对推理模型偏紧风险观察（复发再对齐 0 语义）
- S-5 蒸馏"不要编造"升级为可判定证据约束

## 七、总体结论（四态）

- **P0 对照复查：DONE_WITH_CONCERNS**——38 行判定表（批次 1+2），4 处缺陷修复（b91f4d5），拍板 1 项（P0-F2 归档回流 A/B/C）；ev14 真数据+隔离探针通过。
- **P0.5 专项审计：DONE**——公式六面 0 缺陷、提示词九面 0 阻断；登记 5 条建议+2 项文档注记。
- 疑虑清单：①P0-F2 产品拍板（已由用户拍板 C 处置，2026-09-20）；②character 拒采面与 agent-act 强加人设对抗种子待 A-7b 后终验（A-7b 已收口，见 §九）；③S-1..S-5 留档待未来 A/B 窗口。
## 八、记忆属性消费闭环矩阵（用户专项令 2026-09-20：获取→公式→评分→使用→体现）

矩阵口径：属性 → 获取 → 公式/评分 → 召回消费 → 灵魂注入体现 → 遗忘/演化/UI 消费。全部基于本报告批次 1 的代码 file:line 实证与活体注入块样本。

| 属性 | 获取 | 公式/评分 | 召回消费 | 注入体现 | 遗忘/演化/UI 消费 | 判定 |
|---|---|---|---|---|---|---|
| occurred_at | 提取必填（六字段硬约束，P0.5 面 1） | R1 时间窗命中（recall-signals.ts:97） | R1（yaml 0=关断，09-12 on/off A/B 实测有害留档）；recency 24h | ✅「发生」行（注入块活体在场） | 演化时序门④；遗忘 ageDaysOf 系统年龄优先（v4#5） | ✅ |
| certainty | 提取必填（inferred 禁冒充 observed） | R3 乘法降权 ×(1-0.1) | **inferredPenalty=0.1 在线生效**（九通道中唯一非零结构信号） | ✅「实见/推断」徽章 | 演化门②双方 observed；遗忘仅 observed 自动归档 | ✅ |
| valence | 提取必填 + 锚聚合 | R10 缺省 0（预注册 A/B 红线）；F12 ±0.2 符号化 | F4（gated） | ✅「情感 0.3」行 | F12 锚方向聚合；feeling 渲染 | ✅ |
| arousal | 提取必填 | R10（0 gated） | —（设计内：注入行无渲染义务，§4.1 消费方=F4/遗忘） | UI 强度条（SoulSection） | **遗忘 effectiveλ 调制**（yaml arousalRetention=0.3） | ✅ |
| significance | 提取必填 | sigWeight 0 关断 | R2（0 关断） | ✅「重要度」行 | **遗忘 scoreFor 主因子**；F13 反思累计；采样高显著优先 | ✅ |
| 双时态 valid_start/end | 提取 durative 落库 / 演化双失效 | F18 解析失败保留 | **isInvalidated 硬过滤**（已失效排除） | 按设计不进注入行（§4.1 消费方=F18/F8；UI 有效期 chip 在场） | F8 首次权威、evolution 双失效 | ✅ |
| source | 提取/工序写入 | — | — | UI src 徽章 | evolution created_by 审计 | ✅ |
| recall_count/last_recalled_at | bumpRecallCount json_set 原子自增 | R8 log10(1+c)×w | R8（0 关断） | UI 🔥 渲染 | 遗忘 recallCountBoost（+2%/次封顶 +10%） | ✅ |
| version | 演化守恒 | — | — | UI 属性表（Phase 2） | evolution 幂等/审计留痕 | ✅ |
| metadata.subject | dedup 顺风车 | 演化门③ 严格相等 | — | UI 属性表 | consolidation 归组（subjectStrategy=llm） | ✅ |
| coreRefs/personRefs/identityRefs | backfillMemoryRef 单源回填 | appraisal salience | **R5 反查补池**（P0-F7 修复后 personRefs 生效） | ✅ chips（🎯👥🧠 三徽标） | F14 遗忘保护 + A-7b 确定性重验 | ✅ |
| scene_name/priority/session×3/timestamp×3 | 落库有值 | — | — | 内核出参映射今日不含 → UI 诚实缺列（Phase 2 BFF 注释） | priority：遗忘 priorityOf（-1 死规则） | 📝 缺列登记 |
| sensitivity/recurrence | 预留 | — | — | 预留徽章位 | — | ✅ 设计内不实施 |

**结论**：19 列中全部已实现属性的消费闭环按设计闭合——每列至少一个活体消费面（召回排序/过滤、注入渲染、遗忘评分、演化门、UI 五层）。两类如实登记：①R1/R2/R8/R10 信号 yaml 0 关断（09-12 A/B 实测有害，重开=D2 预注册 A/B gated——"存在但未参与排序"是实测裁决非遗漏）；②scene_name/priority 等 6 字段内核出参未返回（前端诚实缺列，内核补映射自动呈现）。证据：批次 1 判定表 + Phase 2 属性表活体截图（🧬 属性 9 行 + 三 chips）+ 注入块 soul[发生/实见/情感/重要度] 活体样本。

