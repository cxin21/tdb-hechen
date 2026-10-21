# #79 修复面只读预研：dedup LLM 悬挂与超时风暴（2026-10-20 round 24 scout）

> 零实施零 git 写。未拍板不动工。供 A/B 拍板参考的合同草案备料。

## 一手锚点（代码）
- **l1-dedup.ts:280 / :297**：dedup LLM 判重两条路径（llmRunner 直调 + fallback runner）硬编码 `timeoutMs: 300_000`（5 分钟）
- **l1-dedup.ts:203**：decisions = runLlmJudgment(...)（判重主入口）
- **l1-dedup.ts:341**：embedding 超时可配（embeddingTimeoutMs，:98 注释 Override embedding timeout for capture-path calls）——embed 路已有可配先例，LLM 路没有
- **l1-extractor.ts:779**：extraction 主调 `timeoutMs: extractionTimeoutMs ?? 300_000`
- **l1-extractor.ts:459/:470**：dedup 调 batchDedup 透传 llmRunner
- **l1-extractor.ts:521**：batchDedup failed → storeAllDirectly 降级已存在（但触发要等满 300s）
- **l1-extractor.ts:335**：task watchdog 只记日志不杀（stage=dedup elapsed=Nms）

## 机理链（崩溃前实测）
LLM 端点超时风暴（20:37 起）→ 每个 dedup LLM 调用吃满 300s → 并行任务堆积
（watchdog elapsed 269s/239s/329s/354s/414s——超 300s 部分=排队叠加）→ 高 CPU/内存 → 20:55:29 外部强制终止（死因定性见台账，凶手不可定位）。
32516 新进程 21:31-21:34 重演（414s 峰值），21:34:40 第三批卡产出=端点间歇恢复、风暴间歇性。

## 药方草案（供拍板）
- **A1**：dedup LLM timeoutMs 可配置化（config-first：recall/extraction 配置树新增 dedupTimeoutMs，缺省 300_000=逐位现状）；embed 路 :98/:341 已有同款先例可镜像
- **A2**：风暴场景降级等待随 A1 缩短（batchDedup 超时→storeAllDirectly 快降级，不丢数据只绕判重）
- **B**：并发背压（同时 dedup/extraction 任务上限，超出排队），防堆积放大
- **R-A 核查点**：药方只动超时与并发，零情绪数据进召回
- 验收：RED 先行（超时配置 parse+dedup 传参断言）→GREEN→三门（vitest-core 基线对账/typecheck 243 守恒/proxy 全绿）→对抗审查→surgical commit+push

## 关联
- 死因定性闭环：docs/research/2026-10-20-observation-window-log.md（崩溃预取证+死因定性两节）
- 决策卡：A(立 #79 TDD 根修)/B(加背压并入同票)/C(保守观察，预算剩 1)/D(先推进口径 A 采样) —— 等用户拍板
