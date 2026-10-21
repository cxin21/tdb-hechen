# #80 P3 合同：红线槽近似合并（相似→更新而非新增）

用户拍板（2026-10-21 m02636）：「P3 红线去重……要实现生成的时候增量生成，如果有相似的更新而不是新增」。

## §1 范围（四文件）

| 文件 | 改动 |
|---|---|
| MemoryCore/src/core/lifecycle/proposal-dedup.ts | 新增 export REDLINE_MERGE_THRESHOLD=0.4（标定注释：真重复对 0.508/0.459 孤立峰，次高 0.097，安全边距 4 倍；区别于 pending 闸门 0.75） |
| MemoryCore/src/gateway/pending-adopt-merge.ts | mergeStrictRuleContent 增强：adopted 逐行 → 全等幂等（保持）→ 相似≥阈值取最高 sim 行 → adopted 码点更长则原位替换（更新）、否则丢弃旧行保留 → 不相似追加（V12-ADJ 语义不变）；复用 proposalSimilarity 单一源 |
| MemoryCore/src/gateway/pending-adopt-merge.test.ts | RED 用例：阈值常量/L1L2 更新/反向 L2L1 保留/L4L10/全等幂等/不相似追加/0.097 对不合并/多行保序 |
| 生产数据（数据面，不入 git） | 存量清理 fold 14→12 行 upsertCore 等价更新（行体逐字保留，只归并不改写；两包门全绿后执行，写后复核） |

## §2 语义细则

- 全等（norm 相等）幂等优先于相似合并；等长边界→旧行保留（保守）。
- 替换=原位（保序），非尾部追加；被替换行体逐字消失=预期（更新语义）。
- existing 侧行间不互并（本轮只处理 adopted↔existing 相似；行间级联由存量清理 fold 一次性完成）。

## §3 验收

RED 先行（全因 REDLINE_MERGE_THRESHOLD/相似合并未实现而红）→ GREEN → 单文件绿 → 三门（vitest-core/vitest-proxy/typecheck 243 守恒）→ 两包门全绿后存量清理写回+SELECT 复核 → 下一轮 soul-event 行数收敛实证 → surgical commit。

## §4 非目标

- identity 类槽（mergeIdentityFacts）不动；渲染端条数差异（探针 8/事件 12/槽 14）随存量清理收敛后关闭观察项。
- 生成端 identity-discovery 带已有红线上下文（:316）已在位，不改。
