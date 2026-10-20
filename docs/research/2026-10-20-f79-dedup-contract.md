# #79 dedup 超时根修合同（Batch E · A1 全链透传）

日期：2026-10-20 · 票：cxin21/tdb-hechen#79 · 授权：m00637 git 链 + m02315 方案拍板权

## 1. 范围（A1 timeoutMs 可配置化，镜像 extractionTimeoutMs L1-OUTAGE-20261015 先例）

| # | 文件 | 改动 |
|---|------|------|
| 1 | MemoryCore/src/config.ts（类型 :55 后） | dedupTimeoutMs: number + 注释（#79 崩溃根修；dedup LLM 判重超时；缺省 300_000=逐位现状；clamp 60_000..3_600_000） |
| 2 | MemoryCore/src/config.ts（parse :1638 后） | Math.min(3_600_000, Math.max(60_000, num(...) ?? 300_000)) 同款 |
| 3 | MemoryCore/src/core/record/l1-extractor.ts | ExtractOptions +dedupTimeoutMs?: number；batchDedup 调用（:459-481）透传 |
| 4 | MemoryCore/src/core/record/l1-dedup.ts | BatchDedupParams +dedupTimeoutMs?: number；:280/:297 两处 timeoutMs: params.dedupTimeoutMs ?? 300_000 |
| 5 | MemoryCore/src/utils/pipeline-factory.ts（:649 后） | dedupTimeoutMs: cfg.extraction.dedupTimeoutMs 透传 |

## 2. 非目标

- B 并发背压：**裁定为观察项**（票内评论披露）——悬挂堆积的根因是 300s 硬编码 × 风暴；A1 配短超时后 dedup 快失败 → 既有降级路径（l1-extractor.ts:520-524 catch → storeAllDirectly；l1-dedup.ts:308-317 内部 catch 全 store 兜底）自然快降级。背压引入跨请求并发控制新风险，无生产证据不复杂化（config-first 纪律）。
- 不改降级逻辑、不改 dedup 判重语义、不碰 recall 链路。

## 3. 测试（TDD RED 先行）

1. config/__tests__/config.extraction-timeout.test.ts 并入 describe：缺省 300_000 / 900_000 透传 / clamp 下限上限（4 断言镜像 extractionTimeoutMs 形态）。
2. core/record/l1-dedup.call.test.ts +2 用例：params.dedupTimeoutMs 缺省 → captured.timeoutMs=300_000；=90_000 → captured.timeoutMs=90_000（既有 :105-120 回归用例同形态）。
3. utils/l1-runner-failure.test.ts +1 用例：cfg.extraction.dedupTimeoutMs=123_456 → dedup 阶段 run 调用 captured timeoutMs=123_456（镜像 :152 透传用例，extraction 成功走到 dedup）。

## 4. 验收

- RED 因正确原因失败留档 → GREEN 最小实现 → vitest-core 全绿（基线不破）→ vitest-proxy 47/368 → pnpm run typecheck error TS=243 基线守恒 → golden no red cards 且 hitRate 逐位持平（缺省 300_000=现状契约）→ 对抗审查 diff 全文精读 → surgical commit+push（m00637 链：盘点+纯净核查+绝不裹挟 %SystemDrive%/.local 外来 WIP）。
- R-A 核查：纯稳定性改动，零情绪数据进召回。
- 生产观察窗：部署配短超时后不再出现 dedup 悬挂→静默死形态（关票依据）。
