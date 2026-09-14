# 合并召回 · 设计（核心单点 /v3/recall + 代理瘦传输）

> 文档标识：DS-RECALL-MERGE-001
> 版本：v1.0（用户"按推荐"拍板，2026-09-12；三刀排序改革收口后的架构收敛项）
> 前置：排序三刀 5fc7962（字典序两段式）已落地；R7 分层/结论层生产运行中

---

## 1. 背景与问题

当前召回有两条注入链路、两套消费方式：

| 链路 | 服务对象 | 召回方式 | 现状 |
|---|---|---|---|
| A · MemoryProxy 注入管线 | 外部代理会话（dsh 等，经代理 8096） | TdaiL1RecallInjector 调 `/v3/atomic/search`（**朴素检索，未走九通道/R7 分层**） | 生产活跃 |
| B · MemoryCore auto-recall 钩子 | 直连核心的会话（openclaw/hermes） | 内部 searchMemories（九通道 + R7 分层全家桶） | 生产休眠 |

问题：**同一套召回智能（分层/结论层/预算）只在链路 B 实现，生产活跃的链路 A 反而拿简配召回**；两条链路并存还引入双注入风险（现靠 `<relevant-memories>` 标记防重，有跨进程盲区）。

## 2. 目标 / 非目标

**目标**
1. 召回逻辑核心单点化：分层组装只在 MemoryCore 实现一份，任何接入方式吃到同一套。
2. 代理瘦传输：TdaiL1RecallInjector 退化为纯传输（拿现成注入块前插）。
3. 双注入风险架构性消除（单一生产者）。

**非目标**
- 不改检索层（打分/门槛/RRF/字典序——5fc7962 语义原样复用）。
- 不动 wiki 召回注入器与 profile/current_feeling 注入器（它们与 L1 召回并行注入，不在合并范围）。
- 不改 R7 分层组装的注入形态语义（结论层幂等/预算切分原样）。

## 3. 方案对比

| 方案 | 说明 | 结论 |
|---|---|---|
| A. 新增 `/v3/recall` 端点返回**组装好的最终文本块**；代理纯前插 | 核心一次组装（结论层幂等 + 预算 + 截断全在核心），代理零逻辑 | ✅ **推荐**——瘦传输本意；注入形态演进只改核心一处 |
| B. `/v3/recall` 返回结构化数据（结论/经验分离），代理自行渲染 | 代理保有一层渲染逻辑 | ❌ 渲染逻辑留在代理 = 两处维护，违背合并初衷 |
| C. 升级 `/v3/atomic/search` 语义直接返回注入块 | 不加端点 | ❌ 破坏既有 API 契约（工具调用方依赖检索语义），混装两种职责 |

## 4. 选定方案（A）细节

### 4.1 核心侧：`/v3/recall` 端点

- 请求：query + maxResults + 会话标识（`x-tdai-session-id` 头或 body 字段——结论层幂等缓存的 sessionKey 由此而来）+ 既有三元组隔离头。
- 处理：内部复用 auto-recall 钩子的同一条组装路径（searchMemories + R7 分层 + 预算 + 幂等结论层 + CAL C1 截断），产出与钩子注入完全同形的文本块。
- 响应：`{ block: string, meta: { conclusionCount, experienceCount, sessionReused: boolean, layered: boolean } }`（meta 供观测/评估）。
- 组装实现收敛：把 auto-recall 钩子内的分层组装逻辑提取为可复用函数（`recall-layered.ts` 已大半是纯函数——缺的只是把钩子的编排层提出来），钩子与端点共用；**这是消灭两套逻辑的关键动作**。

### 4.2 代理侧：TdaiL1RecallInjector 瘦身

- 改调 `/v3/recall`，拿 `block` 直接前插（沿用现有注入位置与格式包装）。
- **降级路**：`/v3/recall` 不可用/超时/5xx → 退回现状（调 `/v3/atomic/search` 自己组装）+ loud 日志（防静默降级老纪律）。
- `recallL1: true` 语义不变——它控制的就是合并后的唯一代理注入链。
- `<relevant-memories>` 标记防重保留（降级为冗余保险，标记跳过逻辑不动）。

### 4.3 核心钩子（链路 B）处置

- 保留代码、维持休眠；其注入实现切换为调与端点共享的同一组装函数（分叉自然消除，§8.2 登记的"排序语义对齐激活前置"随共享实现自动满足）。
- 激活前置（对齐）在共享化完成时即闭环。

### 4.4 配置

```yaml
# MemoryCore tdai-gateway.yaml（memory.recall 下）
v3Recall:
  enabled: true        # 代码缺省 false（逐位现状），yaml 开启
  timeoutMs: 5000      # 端点内召回超时（与 recall.timeoutMs 同族）
```
代理侧无需新键（recallL1 复用）。

## 5. 验收标准

> 实施勾验（DS-RECALL-MERGE-001 实施工程师回填，2026-09-12；证据 = 单 commit 交付 + 下述测试套件）。

1. ✅ `v3Recall.enabled=false`（缺省）：全链与现状逐位一致。
   证据：config.ts 解析缺省 false；端点 404（`v2-router-recall-merge.test.ts` 验收1）；
   钩子路径提取回归钉——提取前 97/97 既有钩子/分层测试子集全绿，全量 vitest 408 基线绿；
   tsc 零新错（243 既有基线逐条对齐）。
2. ✅ enabled=true：`/v3/recall` 返回块与核心钩子同 query 同会话产出逐位一致（同形验证）。
   证据：`v2-router-recall-merge.test.ts` 验收4——真临时 SQLite 库 + scene index，钩子
   performAutoRecall 的 prependContext 与端点 block 逐位相等（`expect(block).toBe(prependContext)`，
   独立 sessionKey 避免缓存共转使验证空转）。
3. ✅ 代理切换后：生产注入块内容与合并前链路 B 形态一致（结论层幂等跨轮生效——同 session
   二次调用 block 不变）。
   证据：`v2-router-recall-merge.test.ts` 验收5——同 session 二次调用 `meta.sessionReused=true`
   且 block 逐位不变（幂等结论层跨 HTTP 生效）；代理侧 `client.recall-merge.test.ts` +
   `tdai-l1-recall-injector.test.ts` 新链路用例——block 原样前插零渲染。
4. ✅ 降级路径：端点 5xx/超时 → 代理退回旧路 + loud；工具调用 `/v3/atomic/search` 行为不变。
   证据：injector 测试降级两组（500/404 → 旧路 `<tdai_recalled_l1_memories>` 形态 +
   `log.warn` loud 一次，含状态码与端点名）；client 测试 404/5xx/超时/envelope≠0 全抛错；
   `/v3/atomic/search` handler 零触碰。
5. ✅ 全量 vitest 绿（MemoryCore + MemoryProxy）+ tsc 零新错 + golden 重放（注入形态不变式：
   off 档逐位）。
   证据：MemoryCore 全量 vitest（基线 408 + 新 6）；MemoryProxy 全量 vitest（基线 156 + 新 12）；
   tsc 双包与改动前基线差集为零；verify-layered-metrics 回归钉全绿（56/56）。

## 6. 待测试 / 待确认 / 待完善

- **待测试**：端点同形验证（钩子路径 vs 端点路径同 query 逐位）；降级路径注入；幂等结论层跨 HTTP 会话键传递。
  → 已全部落为自动化用例（`v2-router-recall-merge.test.ts` / `client.recall-merge.test.ts` /
  `tdai-l1-recall-injector.test.ts`），见 §5 勾验。
- **待确认**：会话标识传递形态（header vs body）实施时以 v3 隔离头族为准（`x-tdai-session-id` 已有先例）。
  → **已确认（实施结论）**：沿 v3 隔离头族既有先例——`resolveIsolation`（v2-schemas）统一解析，
  body `session_id` 字段优先、`x-tdai-session-id` 头兜底；端点 sessionKey 直接采用该值。
  session_id 缺省（非严格部署未传）→ 空串：幂等结论层与检索复用缓存通道退出（退化安全，检索照常）。
- **待完善**：评估侧 eval-layered-recall 的重放器是否需要支持端点形态采样（当前重放走内部函数不受影响，登记不动）。
  → 维持登记不动；端点侧 meta（conclusionCount/experienceCount/sessionReused/layered）+
  reportRecallMetrics 上报已为后续采样预留观测面。
