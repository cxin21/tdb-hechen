# 灵魂记忆 · 收尾与补全计划（第三档拍板后）

> 日期：2026-09-10。用户拍板：①讨论件全做（TCVDB 实现入围，推翻 YAGNI）②尽快档仅修 bug ③择机打包一个任务清完。
> 前置：第五轮审计 + 可信性修复 21 任务 + 第二档 + 第三档首批 C1-C4 均已合入 main（HEAD 0ae3970）。

## 阶段一 · Bug 修复（尽快档）
- **B1**：verify-p2-t11-13 七断言失败——测试自产密钥未接线到临时 server 实例（T13 验证链自身缺陷）。修法：temp server start() 后从实例读 resolved apiKey（或 getter），测试用它发请求。
- **B2**：`loadGatewayConfig` catch 静默吞 yaml 解析错误（config.ts:416）——改 console.error 带路径+原因（启动期无 logger，console 是正确工具；调用频度低不刷屏）。

## 阶段二 · 择机打包（8 项一个任务）
1. env 命名统一：gateway 同时接受 `TDAI_GATEWAY_APIKEY` 与 `TDAI_GATEWAY_API_KEY`（主用前者）
2. summarizer significance 补 clamp [0,1]
3. wiki 结构页附尾数量上限（常量 cap）
4. T15 探针词拼时间戳（防 provider 缓存假探活）
5. /health 注释更新（"unconditionally cheap" 已不成立）
6. derive 同步阻塞 30s + LLM 热更 null 哨兵 → 文档登记（异步任务态=后续）
7. spec §6.4 coreRef 条目状态更新（C1 已实现 metadata 形态）
8. MemoryProxy 25 处 tsc 存量错误清零（workbuddyHandler/anthropicHandler/codexHandler/handler/memory-bridge/storage-factory 等）+ MemoryCore 补 tsconfig 类型检查门禁

## 阶段三 · 讨论件实现（中）
- **C5**：C1 排序加成延伸 auto-recall 注入排序（复用 applyCoreRefTiebreak）
- **C6**：getPath(a, b, maxHop) 图查询接口（graph 设计 §4；BFS 实现 + /v3/atomic/path 路由 + 单测）

## 阶段四 · TCVDB 后端补全（大件，TCVDB 实证与补全清单落地）
**前置事实**：生产 sqlite；tcvdb 无本地实例——score 刻度实证只能代码级推演 + 真实实例留待部署时。七项缺口：
1. `searchL1Vector` score 刻度实证（代码级：读 tcvdb SDK 距离/相似度语义并文档化）
2. `l1_links` 全套：addLink/getNeighbors(filter)/deleteLinksFor/pruneOrphanLinks
3. `l1_archive`/`restoreL1`/`archiveL1`/`getL1ByIdsWithArchive`
4. core_memory/core_values 表 + CRUD（upsertCore/readCore/upsertValue/listValues/deleteValue/resetValueValences/restoreValueValences）
5. `updateL1Metadata`/`bumpRecallCount`
6. `countL1VectorRows`/`deriveValueValences` 支持
7. native-hybrid 路径补 reconsolidation 触发（T12 审计 F7 同族收官）
**实现约束**：tcvdb 无本地实例——全部验证走 mock/契约测试（接口形状对齐 sqlite 语义），真机实证登记为部署时任务；spec §6.4 同步更新。

## 验收
- 全部 verify 脚本（含修复后的 p2-t11-13）exit 0；MemoryProxy vitest 全量；MemoryCore 新增契约测试
- 收口重启 + 生产冒烟；CHANGELOG 登记

## 执行
Subagent-Driven：阶段一（1 任务）→ 阶段二（1-2 任务）→ 阶段三（1 任务）→ 阶段四（2-3 任务），每任务独立审查。
