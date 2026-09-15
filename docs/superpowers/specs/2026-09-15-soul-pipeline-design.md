# 灵魂管线（Soul Pipeline）· 双轨同步设计

> 文档标识：DS-SOUL-PIPELINE-001
> 日期：2026-09-15
> 状态：设计定稿（用户确认无修改）
> 承接：DS-AGENT-SOUL-MEMORY-001（灵魂记忆 spec）、DS-MEMORY-EVO-001（P1-P3 已落地）

## 0. 灵魂公式与架构审计

> **灵魂 = 此刻的你 + 过去的记忆 + 当下的感受 → 下一刻的你**

| 灵魂要素 | 系统对应物 | 审计时状态 | 本设计补齐 |
|---|---|---|---|
| 此刻的你 | core_memory slots（identity/core_value/strict_rule）+ persona | slots 空置（身份层无材料） | **身份自发现提案制**（LLM 提案 → 分级门 → 写入 slots） |
| 过去的记忆 | L1 经验层 + L2 场景块 + 记忆图 | 管道全通；维度惰性待校准 | **维度标注透出**（经验行带 [时间\|确定性] 标注） |
| 当下的感受 | appraisal（core_values → fired → moodSign）→ current-feeling 注入器 | 注入器活跃；**4 锚 valence 全 NULL**（C2 derive LLM 空响应同族） | **valence derive 修复**（与 discovery 同族，解除限制已覆盖） |
| → 下一刻的你 | capture 管道反馈闭环 | 隐式 | **显式化**（组装器输出 → 对话 → 提取 → 锚/slots 演化 → 下一轮组装） |

**核心转变**：注入块从"检索结果堆叠"变为"灵魂状态组装"——LLM 每轮看到的是一个有身份、有经历、有情绪的状态。

## 1. 双轨架构

### 轨道 1 · 灵魂组装器（立即交付）

注入块三段式，每段带来源标注：

| 段 | 内容 | 来源 | Token 预算 | 变化频率 |
|---|---|---|---|---|
| 【此刻的你】 | identity slots + persona 摘要 + 价值锚（label+weight） | core_memory slots + persona.md + core_values | 小（~200 tok） | 低（缓存友好） |
| 【过去的记忆】 | 经验层（维度标注：[活动时间\|确定性]）+ 结论层（work_fact） | R7 分层召回 | 主预算 | 中 |
| 【当下的感受】 | appraisal：fired 价值锚 + moodSign + 情绪基调 | current-feeling 注入器（已活跃） | 极小（~100 tok） | 每轮 |

### 轨道 2 · 维度校准（语料门槛后交付）

| 阶段 | 语料 | 交付 |
|---|---|---|
| 1（现在） | 75 | 维度特征接口标准化（九通道+R10 统一签名）；判官软轨设计定稿 |
| 2 | ≥300 | 判官软轨标注积累（LLM 盲评起草 + 对抗复核） |
| 3 | ≥1200 | 校准拟合上线（九通道+R10+情感+失效命中 → yaml 权重）→ 价值通道解禁 |

## 2. 身份自发现（IdentityDiscovery）

### 2.1 机制（复用 GROW 模式）

扫描对话 → LLM 提案身份事实 → 证据重算 → **分级门**：

| slot 类型 | 采纳门 | 理由 |
|---|---|---|
| `identity`（描述类："我负责 TDB 开发"） | 多源一致 ≥3 + observed → **高置信自动采纳** | 描述类错误可被 GROW-MAINT 类重验证纠正 |
| `core_value` / `strict_rule`（红线类："绝不删除用户数据"） | 提案 → **Panel 人工采纳** | 红线错误 = 每轮注入投毒（K 信任边界） |

### 2.2 写入与护栏

- 存储：`/v3/core-memory/write`（既有 API，slot 白名单内）
- 冷却/去重/状态机：与 anchor-growth 同款（anchor_growth_state 同表 per-slot 键族）
- 演化：已采纳 identity 可被后续更高证据提案**取代**（版本递增，非覆盖——旧值入审计日志）

### 2.3 与 persona 的关系

persona.md（L2 蒸馏）保持独立演化；slots（L1.5 身份常驻块）由 LLM 自发现直接填充。两者在组装器的【此刻的你】段共存：slots 优先（更精准），persona 补充（更丰富）。

## 3. 感受层修复（前置依赖）

4 锚 valence 全 NULL 的根因 = `buildValenceLlmRunner` 与发现轮**同族 LLM 空响应**（StandaloneLLMRunner，finishReason=length、thinking 耗尽预算）。

修复：valence derive 调用路径与 discovery 同步解除限制（timeoutMs: 0 / maxTokens: 0），并对空响应 fail-loud（非静默返回）。

## 4. 维度标注透出（诚实原则）

经验行格式升级：`- [episodic|fixture|2026-09-15|observed] 内容`——LLM 知道每条记忆的时效与可信度。Token 增量 ~20 tok/行。

## 5. 剩余待设计与完成项登记

| 项 | 内容 | 依赖 | 状态 |
|---|---|---|---|
| **P4** | 受控正文演化：evolution-worker（五条件门+审计边）+ **L2 失效传播**（L1 失效 → scene_blocks/persona 重蒸馏） | conflict 观察期数据 | 待数据 |
| **P5** | 排序校准合成：离线拟合 → yaml 权重 → 九通道解禁 | 语料 ≥1200 + 判官软轨 | 待语料 |
| **记忆召回优化** | 九通道校准回归 + R10 情感显著度检索加权 | P5 校准产物 | 待 P5 |
| **情感记忆检索** | valence/arousal 联合检索加权（情感记忆差异化） | R10 A/B 载体（判官软轨） | 待 P5 |
| **身份 GROW-MAINT** | slots 的重验证/退场机制 | slots 有内容后 | 待一期交付 |
| **LLM 空响应 fail-loud** | StandaloneLLMRunner 对空 text 的静默返回改 fail-loud（本问题静默两天） | 独立小任务 | 待做 |

## 6. 自生长自维护终态（本设计交付后）

| 能力 | 覆盖 |
|---|---|
| 自生长 | L0→L1 自动提取（soul 全字段）→ 价值锚纯自发现 → **身份 slots 自发现** → L2 蒸馏 |
| 自维护 | GROW-MAINT（锚重验证/权重/退场）+ 失效排除+时间旅行 + 遗忘（×arousal）+ 巩固 |
| 自进化 | 校准拟合（P5）+ 判官软轨（标注积累） |
| **缺口** | L2 失效传播（P4）、退休滞回（P4'）、R10 A/B 载体（P5） |
