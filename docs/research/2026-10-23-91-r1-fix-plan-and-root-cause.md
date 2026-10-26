# #91 R1 修复方案与重新根因分析（2026-10-23）

> 票：cxin21/tdb-hechen #91（self_identity 提案洪泛结构治理——复现即投票+默认终局）
> 授权链：用户 2026-10-23 拍板「按 R1 出修复方案，调到 72h，在 #91 票内返工；出完方案后重新进行根因分析」（m00659）
> 本文=方案+根因重析落盘，未动任何生产/代码文件；实施待用户对方案确认后按 TDD 执行。

---

## 1. R1 修复方案

### 1.1 修复面总览（基于重新根因分析的修正结论——比上轮呈报缩小一处）

| # | 改动点 | 位置 | 现状缺陷 | 修法 | 影响面 |
|---|--------|------|----------|------|--------|
| A | sweep 租户缺省 | MemoryCore/src/core/store/sqlite.ts:3206-3208 | tenant undefined→||"default"→生产 WHERE default 三元组→0 行空转 | tenant 整体 undefined→不加租户 WHERE（跨租户 sweep）；显式传入→逐字段 ||"default" 保持现状 | 唯一调用方 lifecycle-scheduler.ts:208（传 undefined）——从空转变生效；其余 0 调用方 |
| B | sim-gate 语料含 expired | sqlite.ts listPendingCore（state 过滤 :3109 附近）+ proposal-sim-gate.ts:154 | includeDecided:false→仅 state='pending'→expired 行不在匹配语料→「复活继承计数」不可达 | listPendingCore opts 加 includeExpired?: boolean（缺省 false=现状逐位）；:154 调用改传 { includeDecided:false, includeExpired:true } | listPendingCore 共 7 调用点（identity-discovery.ts:246/:315、pending-adopt-sweep.ts:63、sim-gate:154/:227/:279、reflection.ts:475/:534）——仅 :154 传新参，其余 6 处缺省 false 逐位不变 |
| C | TTL 24h→72h | MemoryCore/tdai-gateway.yaml selfIdentityGate.recurrence.ttlHours: 72 | 缺省 24h 与日更复现周期同量级→误杀慢复现 | yaml 显式配置 72（代码缺省 sqlite.ts:3211 ?? 24、reflection.ts:221 ?? 24 均不动——config-first，回退=删配置行） | votesN 缺省 3 不变；spanHours 联动效应见 §1.3 |
| D | 接口注释同步 | MemoryCore/src/core/store/types.ts（sweep/listPendingCore 签名注释） | 注释未含「undefined→不限定」「includeExpired」语义 | 补注释，零行为变更 | 仅文档面 |

**updatePendingRecurrence 零改动**：sqlite.ts:3150-3176 已完整实现复活（:3153 state 检查放行 expired、:3156 `const revived = row.state === "expired"`、:3158 count 继承 +1、:3171 `UPDATE ... SET recurrence_json = ?, state = 'pending'`）。断点只在 B（语料面）——expired 行根本进不了匹配候选，命中不了 pid，复活分支不可达。

**实施前待确认位点**：proposal-sim-gate.ts:227（includeDecided:true）与 :279（includeDecided:false）的语义归属需实施时逐位审读——:154 是主命中路径必改；:227/:279 若为对比面（rejected/adopted 对照）则不传 includeExpired（裁决行不应复活，符合票面）。此确认不改变方案面。

### 1.2 TDD RED 合同（测试先行，测试文件 MemoryCore/src/core/lifecycle/proposal-recurrence.test.ts，现有 22 用例=回归锚）

新增 5 用例（全部临时 SQLite fixture，先 RED 确认因正确原因失败，再最小 GREEN）：

1. **A-RED**：sweep 传 undefined tenant，fixture 三租户（team-A/team-B/default）各一条 count=1 超 TTL 行→期望 3 行全 expired（现状：0 行）。
2. **A-回归锚**：sweep 显式传租户→仅该租户行 expired（现状语义保持，防 A 修过头）。
3. **B1-RED**：listPendingCore(tenant, { includeDecided:false, includeExpired:true })→返回 pending+expired；缺省调用（6 处现状）→仅 pending（逐位锚）。
4. **B2-RED（端到端复活链）**：fixture 一条 expired 行（与提案向量相近）→ similarSelfIdentityProposalExists 命中返回该行 pid→updatePendingRecurrence(pid,...)→revived=true、count 继承 +1、state 回 pending。现状：sim-gate 不命中（走新行落库）→RED。
5. **C-RED（配置链）**：ttlHours:72 注入→fixture count=1 行 age=48h→sweep 不 expired；age=80h→expired。现状（缺省 24）age=48h 被误杀→RED。

### 1.3 C1/C2：72h 的联动效应（需用户知情）

yaml 单键 ttlHours 同时是 sweep TTL 与 ready 晋升跨度（reflection.ts:432 spanHours: recTtlHours）：
- **C1（缺省臂，本方案采用）**：单键 72h 联动——sweep 防误杀达成；副作用=ready 晋升窗口 24h→72h（日更提案 day1/2/3 跨度 48h<72h 不 ready，第 4 次复现才 ready，慢 1-2 天）。
- **C2（备选）**：拆键（yaml 加 spanHours: 24 + reflection.ts:221 读点一行改动）——晋升节奏保持，代价+2 行代码面。
洪流主诉是孤行堆积而非晋升速度，取最小改动 C1；用户若要分离节奏再切 C2。

### 1.4 验证门

1. cd MemoryCore && pnpm run typecheck（tsconfig.typecheck.json）→ 243 错=基线逐位（触文件 0 新增，只认日志 error TS 计数）。
2. MemoryCore vitest 全量→零新增回归（既有失败集合=基线）；proposal-recurrence.test.ts 22+5 全绿。
3. MemoryProxy vitest 全量绿。
4. 生产观察窗（用户部署重启后）：expired 行出现+sweep 日志生效证据；48h 孤行不 expired（72h 生效）；pending 存量 80→下降趋势；跨日复现命中→revived 行出现。

### 1.5 不做清单（防夹带）

- stage2 自动采纳（#92 票，未动工）。
- count≥2 僵尸行永久 pending 边界（票面已记录，属后续票）。
- simGated 拦截数进 lifecycle 日志行（可观测性缺口，反思三不足之一）——**待用户拍板是否夹带**（默认不夹带，单列票外建议）。
- suppression.maxPending 命名误导重命名（纯改名扩 diff 面，不做）。

---

## 2. 重新根因分析（全新穿透，含上轮实锚错误修正）

### 2.0 诚实账目：上轮实锚③错误修正

上轮自对抗复演（m00632–m00658）实锚③称「updatePendingRecurrence 查行也仅 pending→revived 恒 false」。**本轮逐行实锚证伪**：updatePendingRecurrence（sqlite.ts:3150-3176）按 pending_id 查行、:3153 显式放行 expired、复活语义完整。上轮把 initPendingRecurrenceByContent（sqlite.ts:3187，按 content 查行、state='pending'）的实现段误读为 update 的查行——两段相邻（:3148-3202），段位归属搞混。**修正后断链从三处缩为两处（A sweep 租户 + B 语料面），修复面更小更准**。这一修正本身即「重新进行根因分析」的直接产出。

### 2.1 断链清单（修正后）

- **断链 A（sweep 静默空转）**：lifecycle-scheduler.ts:208 把 deps.config.filter（L1 内容过滤配置，非租户）当 tenant 传入 sweep；store 层 `tenant?.X || "default"` 宽容兜底把类型误用静默吞掉（undefined→default 是合法形态）→WHERE default 三元组→生产 self_identity 行全在 team-2k12lgb650 两真实租户→0 行命中→swept=0 无日志。
- **断链 B（复活环不可达）**：sim-gate.ts:154 语料查询 includeDecided:false→state='pending' only；#91 新增 expired 状态后该读面未扩展→expired 行不在匹配语料→票面「再命中→复活继承计数」承诺不可达→跨 24h 复现=落全新行 count 重起=跨日洪泛永动机。

### 2.2 为什么会写出这两处偏差（五层穿透）

1. **参数误用+宽容缺省叠加**（断链 A 根因）：scheduler 层无「当前租户」概念（per-tenant 循环在 reflection 内部），传 filter 是想传「上下文」却传错对象；store 接口 tenant?: CoreTenant 可选+||"default" 兜底在写路径合理（归属确定性），在读/迁移路径是语义陷阱——读的缺省应是「不限定」，兜底成 default 会静默缩小扫描范围且零报错。
2. **状态机扩展未传导到全部消费面**（断链 B 根因）：sim-gate.ts:154 写于 #81 Phase0（彼时无 expired 概念）；#91 实施改了 store（update 复活+types 注释「行保留在匹配语料」）却没改 sim-gate 调用面——新增 state 值的影响面=全部按 state 字面量过滤的读点，该审计在 #91 改动清单里是漏项。
3. **测试盲区：单元绿≠链路通**：22 用例全绿但 ①无任何 tenant=undefined 路径用例（sweep 用例全传显式租户/default fixture，恰好与兜底行为吻合→绿）；②复活用例直接调 updatePendingRecurrence(pid) 验证 store 层（store 单元绿），但「expired 行被 sim-gate 命中→复活」的集成链路无用例——断点恰在两段绿之间的缝上。
4. **可观测性缺失让断链存活到生产**：sweep 空转无声（swept=0 无日志、无扫描/命中计数）；若首轮部署即有「扫描 N 行/swept M 行」日志，断链 A 当拍即可发现——实际是靠人工 SQL 切面（WITH_RECURRENCE_JSON=0/EXPIRED=0）事后发现。
5. **收尾自审对照的是「机制」不是「承诺清单」**：diff 逐块复核确认「机制与票面一致」，但未做「票面每句行为承诺→实现位点→对应用例」的逐条映射——「行保留在匹配语料」这句承诺没有对应验收项，漏网。

### 2.3 系统级教训（跨任务沉淀候选）

1. 可选参数+兜底缺省的设计必须区分读/写语义：写缺省=归属确定（default 合理），读缺省=不限定或显式拒绝（default 是陷阱）。
2. 状态机加新值时，强制审计「全部 state 字面量过滤点」（grep state = 'x' / state === "x"），读面扩展进改动清单。
3. 票面行为承诺→验收用例映射：每句「X 应 Y」承诺须有对应用例，收尾自审按承诺清单核对而非按 diff 核对。
4. 低频后台任务（sweep 类）必须有扫描/命中计数日志——无声空转是最贵的故障形态。

---

## 3. 待用户拍板点

1. §1.3 C1（单键 72h 联动，晋升窗口 24h→72h）vs C2（拆键保节奏）——本方案默认 C1。
2. simGated 日志缺口是否夹带进本次返工（默认不夹带）。
3. 方案确认后按 §1.2 TDD 实施（RED 留档→最小 GREEN→全量门→呈报 commit/push 授权）。

## 4. 边界

本文档 untracked 落盘（docs/research/），不入库不提交；生产/yaml/代码零改动；#91 保持 OPEN；测试实施一律临时 SQLite，绝不触碰生产库。
