# Soul 分层块接口（#37 首交付物，S16/R5，2026-10-16）

> 状态：接口定义冻结（类型单一源 `src/injection/types.ts`）；分发层 `tools.before_call` 接线与三 regime 落地按依赖链推进（#34 尾块 → #36 报告 → 时机接线）。
> 裁决依据：r5-37（R5 对抗审查修正版）；本文件是「三块类型 + 挂点清单 + owner + 跨系统边界声明」验收项的落点。

## 1. 三块类型（`SoulBlockKind`）

| kind | 内容 | 变量速度 | 注入 regime（缺省） | 依赖票 |
|---|---|---|---|---|
| `soul.head` | 身份（self/identity slots）+ 价值锚行 + 品格行 + 红线段 | 慢（指纹 sv 门控） | 会话头注入 + 漂移再锚定（shadow 先行） | #34（当下性 state）、#31（探针） |
| `soul.tail` | 感受/当下（soul-feeling：方向清单 + 首要子句 + 近期基调） | 快（每轮） | 每轮注入 | #34（state 通道） |
| `soul.event` | 动作点近端红线（红线子集原文） | 事件驱动 | `tools.before_call`（需分发层接线） | #37 本票 |

接口先行的原因：#34/#36/#37 三票共同前置，先冻结块类型防三票各自发明（r5-37 修正 4）。

## 2. 挂点清单与 owner

| 挂点 | 用途 | 状态 | owner |
|---|---|---|---|
| `system.prefix` | soul.head 会话头（现状） | ✅ 已接线（现有 hook 路径） | tdai 召回钩子 |
| `user.before` | soul.tail 每轮（现状） | ✅ 已接线 | tdai 召回钩子 |
| `tools.before_call` | soul.event 动作点近端红线 | ⚠️ 类型已就位，**分发层未接线**（`pipeline.applyByPoint` 无 case=no-op，刻意保守） | **proxy 分发层**（需在 tool dispatch 前置位识别"即将执行工具的轮"并挂块；r5-37 修正 2） |
| —（harness 侧） | 子代理显式灵魂继承 | 跨系统边界，见 §4 | DSH harness fork 语义 |

## 3. 时机配置（`soul.timing.*` → `SoulTimingConfig`）

缺省 `DEFAULT_SOUL_TIMING` = 现状逐位（验收：timing off 时逐位等于现状）：

- `identity: "session_head"`（可升级 `session_head_drift_reanchor`，arXiv:2402.10962）
- `redline: "session_head"`（可升级 `action_proximate`）
- `feeling: "every_turn"`
- `driftTrigger: "off" | "shadow"`（成本红线：**禁每轮跑全量探针**——触发器=#34 事件流聚合+阈值 config 化+shadow 只记录建议，r5-37 修正 1）
- 事件 taxonomy 单一源（r5-34 修正 3）：`user_correction | tool_failure | task_switch` 定义于 **MemoryCore `src/core/hooks/soul-state.ts` 的 `SOUL_STATE_EVENT_KINDS`**，本仓不复制定义、只消费该清单（#34 已落地通道：state 参与 cacheKey 不参与 soulVersion 指纹；尾块行由 `renderStateLine` 渲染）。

config-first 纪律：任何 regime 升级必须显式配置才翻转，缺省永远=现状。

## 4. 跨系统边界声明（r5-37 修正 3）

- **MemoryCore 只供内容**：渲染分层块字节（soul-assembler 已有 head/tail 产物；event 块=红线子集原文直出）。
- **MemoryProxy 管挂点与时机**：按 `SoulTimingConfig` 决定块落位与轮次。
- **DSH harness 管 fork 语义**：子代理是否显式继承灵魂=harness fork 配置，不属于 MemoryCore/MemoryProxy 职责；两包不得越界实现"继承"逻辑。
- 触发器/探针（#31）在 MemoryCore 侧产出证据，MemoryProxy 只消费建议（shadow 报告），不做判定。

## 5. 交付物对照（r5-37 验收）

- [x] 三块类型+挂点清单+owner（本文档 + `types.ts`）
- [x] timing config 类型与缺省值（`DEFAULT_SOUL_TIMING`，测试 `soul-block-interface.test.ts`）
- [ ] 分发层 `tools.before_call` 接线（本票后续；#34 事件流依赖）
- [ ] 触发器 shadow 报告（依赖 #34 事件流聚合落地后跑真实数据）
- [x] 跨系统边界声明（§4）
