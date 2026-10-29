# E3 · 30 题人工抽检（#143）

本目录只放可入库的评测材料：交互判定页与抽样说明。原始报告与含证据原文的 JSON 在
<code>MemoryCore/.eval-data/bench/</code>（.gitignore 排除，属一次性产物，可随时用命令重建）。

## 文件

| 文件 | 用途 |
|---|---|
| <code>e3-review-30.html</code> | 单文件判定页：逐题读证据 → 选足够/部分/不足/存疑 → 不一致时选归因桶 → 一句话理由；判定存 localStorage，可导出 JSON |
| <code>e3-review-summary.md</code> | 汇总结果：一致率、高报/低报拆分、分层一致率、分歧逐条、四桶计数（由 summarize 生成，同名 .json 为机读版） |
| <code>e3-verdicts-*.json</code> | 判定原件（谁判的就叫什么：<code>e3-verdicts-ai-proxy.json</code> 为 AI 代理判定；真人判定另存一份，互不覆盖） |
| <code>README.md</code> | 本说明（抽样口径与复现命令） |

## 复现 / 重建

    cd MemoryCore
    npm run audit:e3:build          # 等价：node scripts/audit/r143-e3-review.mjs build

默认读 base=longmemeval-oracle-2026-10-27T05-45-51.json（d64004e）、arm=r142-deep105-base0.json（90416ec），
数据集=仓库根 .eval-data/longmemeval_oracle.json。换报告：--base / --arm / --dataset；换题量：--sample。

## 汇总（拿到判定 JSON 后）

    cd MemoryCore
    npm run audit:e3:summarize -- --verdicts ~/Downloads/e3-review-143-verdicts.json

输出 docs/superpowers/evals/e3-review-30/e3-review-summary.md：人机一致率、分歧逐条（含机器预检与归因桶）、按桶计数——直接回填 #143 票面评论。

判定主体必须在票面注明是「人工」还是「AI 代理（含授权来源）」：同一分母下可叠加两份判定做交叉，换主体只需换 --verdicts，不必重抽样。

## 抽样口径（摘要）

分层互斥 A→F（见脚本头注释），层内按 arm/base 答对翻转 > kept 差 > turnCov 差 > caseId 排序，同层同题型最多 2 题；配额 {"A":6,"B":8,"C":10,"D":3,"E":2,"F":1}，不足从剩余池按 A→F 补足。可复现：同一对报告 + 同一 --sample 得同一批题。

本次各层候选数：{"C":21,"F":32,"A":12,"B":13,"D":10,"E":2}；入样分布见工作表清单的「层」列。
