# #99 验收 4 · held-out 同句式探针证据（2026-10-25）

> 票面要求：「从 production journal 另挑 3-5 条同句式 held-out 探针验证泛化，不从 golden dataset 抄题」。
> 本档为一次性探针脚本的**逐字转写存档**（脚本按「探针跑完删净」纪律用后即删；boot 配方与
> `scripts/recall-precision-eval.mjs` seed 模式一致：golden seed-fixture 副本 + 生产 config-override
> 运行时只读合并 + 临时网关 :8423 自起自停 + 零注入零删除；查询全部为本票新造，非 dataset.jsonl 抄题）。

## 探针设计

- **H1–H4（泛化组）**：同句式「给我一个可复制的 X，不要 Y」变体，打 seed 库四个不同锚域
  （交接耐久锚 / TDD 工程纪律 / GitHub 网络环境 / rerank 闭环），判据 = 返回行 frag32 包含锚域原文。
- **A1–A3（对抗组，precision）**：与库无关查询（天气 / 电影 / 币价），判据 = 零行，
  或仅少量行且归因可解释（词面 FTS / 既有 V2-3 分析型放宽通道）。

## 结果（逐字转写自运行输出 RESULT JSON）

| id | query | memRows | layer | fragHit |
| --- | --- | --- | --- | --- |
| H1-交接域(同锚异问) | 帮我写一个可复制的交接提示词，别发整份文档 | 4 | conclusion2·work_fact2 | **true**（头位即锚） |
| H2-TDD纪律域 | 给我一份能直接落地的TDD纪律提示词，不要整篇规范文档 | 4 | conclusion2·work_fact2 | **true** |
| H3-GitHub网络域 | 给我一段能直接用的GitHub代理配置说明，不要整篇网络调研文档 | 4 | conclusion2·work_fact2 | **true**（head[1]=GitHub锚） |
| H4-rerank域 | 帮我整理一个可复用的rerank调参提示词，别给论文文档 | 4 | conclusion2·work_fact2 | **true** |
| A1-无关天气 | 明天上海天气怎么样，要带伞吗 | 2 | conclusion2 | n/a（见归因） |
| A2-无关电影 | 推荐几部适合周末看的科幻电影 | 0 | — | n/a |
| A3-无关币价 | 比特币现在的价格是多少 | 2 | conclusion1·persona1 | n/a（见归因） |

H1 返回头两行（锚复现实证）：

```text
- [结论|reflection] 交接质量取决于只写耐久锚：提示词仅记重复发生的环境事实，合同放票评、判据放 ADR、数据留日志；两份交接提示词按此落盘，且终审任务书红线已延续适用，新会话无需本会话上下文即可接续。
- [结论|reflection] 截至 2026-10-16，R3 灵魂注入质量轮 #22-#38 已全部实现并推送、main 与 origin/main 一致；项目转入 P3（队列 #39-#43，红线动作点接线打头），并已生成冷启动交接提示词，续作靠 ADR/票面/留档而非会话记忆。
```

## journal gates（归因取证，H1 全量转写）

- `gates.rerank`（经验层，F3）：`{provider:"local", kept:3, dropped:9, topScore:-3.348, scoreScale:"logit-sigmoid", threshold01:0.1192, top01:0.0340, degraded:"all-below-minScore"}`
  —— **全员低于阈值不清零**生效：12 候选全杀改降级原序注入，`degraded` 归因 + 归一化刻度观测齐全。
- `gates.conclusionBm25`（F2）：`{minRel:5.110, kept:2, dropped:2, keptWorkFact:2, keptSceneBlock:0, mode:"relative", alpha:0.4, topRel:12.774}`
  —— 相对门 `α×topRel` 口径在生产形态链路如实落账。
- `gates.conclusionRerank`（shadow 观测）：`{mode:"shadow", kept:1, dropped:1, topScore:0.961}`——shadow-first 纪律不变。

## 对抗组归因（诚实边界）

- **A2** 零行（完美）。
- **A1**（天气，2 结论行）与 **A3**（币价，价目行 + persona）的少量行来自**既有通道**，非本票重开：
  A1 的结论行经 V2-3 分析型放宽（query 含「怎么」→ `isAnalyticalQuery` → significance top-5 免命中追加，
  引擎三 E3.2 既有行为）；A3 的价目行经词面 FTS（「价格」token 子串命中「价格管理」），
  且被 F2 相对门（topRel 口径）与 halfLimit 预算帽约束在 ≤2 行。
  基线 eval 无对抗探针，无 before 数字可对照；三条对抗查询合计 4 行，无「高置信误归因」超出词面邻近范畴。

## 结论

- 泛化：同句式 4/4 命中各自锚域 → 修复非针对 golden P3 调参。
- precision：对抗组无塌方证据；残余误召回全部可归因到既有通道（V2-3 / 词面 FTS），
  如需进一步收紧属独立调参票（α / minUniqRatio / V2-3 门槛），不在本票 scope。
