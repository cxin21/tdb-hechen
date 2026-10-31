# 设置页 25 键「真被消费」审计（task-107）

静态结论，快照 2026-11-01T03:45 +08:00。`src/index.ts` 正被 task-72 编辑，行号会漂 ⇒ 复跑 `node dsh-plugin/scripts/audit-config-keys.mjs` 取最新。

## §1 结论

1. 设置页 25 键**全部有真消费点**（读该字段并改变行为，不是只进日志）：脚本判 effective 25 / 仅解析 0 / 孤儿 0，人工逐条复核一致。
2. 真风险在反向面：配置面 76 条叶子，设置页看得见 27（25+2 secret），**看不见 49 条**，其中 44 条改行为 —— 运维在界面上永远调不到（口径见 §2）。
3. 反向面里 2 条是**真孤儿**（配置值到不了消费点）、4 条**落到未接线模块**、7 条只能通过对象别名/整段传参读到（脚本漏检面，§4 给了 file:line）。
4. `assetReflection.*` 4 键即使按拍板加进表单，**当前代码下点了也不会有任何行为**：`registerAssetReflection`（`src/asset-reflection.ts:310-318`）在 `src/` 里零调用点。
5. `?token= 401` 本轮未复核（纯静态审计，未起宿主）；task-57 的 §8.3 口径仍未由实跑证实。

## §2 复跑与读数

- `cd dsh-plugin && node scripts/audit-config-keys.mjs` → 25 行表 + 反向 49 行表；`--json` 出机器可读；`--strict` 有孤儿 exit 1。
- 本轮 `--strict` = **EXIT=0**（strict 只看 25 条可见键）。叶子总数 76，可见 27，隐藏 49。
- 隐藏 49 的口径：脚本 37 effective + 脚本 needs-review 12。12 里人工复核为**生效 7**（别名/整段传参 6 + `debugLogFile` 1）、**死接线 4**（`assetReflection.*`）、**传不到消费点 1**（`headPack.maxScenarioEntries`）⇒ 改行为 37+7=44。
- 脚本不 eval 配置、不执行插件、不联网：`DEFAULT_CONFIG` 按花括号结构解析（`src/config.ts:323` 起），键从 `src/config-schema.ts:62-97` 抽。

## §3 可见键三档（档位=脚本；消费点=人工实读）

| # | key | 档 | 消费点（行为相关） |
| --- | --- | --- | --- |
| 1 | enabled | 生效 | `src/index.ts:247` 总开关早退 |
| 2 | server.baseUrl | 生效 | `src/index.ts:351` 建 client |
| 3 | server.serviceId | 生效 | `src/index.ts:344`；`src/segments/knowledge.ts:29` |
| 4 | server.teamId | 生效 | `src/index.ts:345`；`src/segments/wiki.ts:32` |
| 5 | server.agentId | 生效 | `src/index.ts:346`（仅此一处，建 client 必带） |
| 6 | server.userId | 生效 | `src/index.ts:347`；`src/segments/wiki.ts:32` |
| 7 | server.apiKeyRef | 生效 | `src/index.ts:281` ref→凭据解析 |
| 8 | server.userKeyRef | 生效 | `src/index.ts:297`、`:307` 懒解析 |
| 9 | writeback.enabled | 生效 | `src/index.ts:836` if 包住整段写回 |
| 10 | writeback.skillFeed | 生效 | `src/index.ts:1044` → `src/writeback.ts:473` 真分支 |
| 11 | volatile.enabled | 生效 | `src/index.ts:772` 早退 |
| 12 | volatile.maxChars | 生效 | `src/index.ts:674`、`:721`、`:752` 预算 |
| 13 | volatile.soul.enabled | 生效 | `src/index.ts:714` |
| 14 | volatile.soul.maxChars | 生效 | `src/index.ts:716` → `src/recall-source.ts:227` |
| 15 | volatile.soul.includeFeeling | 生效 | `src/index.ts:717` → `src/recall-source.ts:232` |
| 16 | tools.enabled | 生效 | `src/tools/knowledge.ts:361`、`src/tools/recall.ts:11` 注册谓词 |
| 17 | tools.recall | 生效 | `src/tools/recall.ts:11` |
| 18 | skill.enabled | 生效 | `src/segments/skills.ts:45`、`src/tools/skills.ts:405` |
| 19 | skill.allowLlmWrite | 生效 | `src/tools/skills.ts:414` 决定写工具注册 |
| 20 | skill.headPackChars | 生效 | `src/segments/skills.ts:55` listing 预算 |
| 21 | volatile.wiki.enabled | 生效 | `src/segments/wiki.ts:56` |
| 22 | volatile.wiki.maxChars | 生效（别名） | `src/segments/wiki.ts:33` 传整段 → `:61` 读 maxChars |
| 23 | volatile.knowledge.enabled | 生效 | `src/segments/knowledge.ts:54` |
| 24 | volatile.knowledge.maxChars | 生效（别名） | `src/segments/knowledge.ts:31` → `:57` |
| 25 | debug | 生效 | `src/index.ts:241-243` debug=false 时连文件镜像都不构造 |

## §4 反向清单（看不见的 49 条里必须知道的）

- **真孤儿**：`writeback.maxMessagesPerRequest` 解析进 cfg 后 `src/` 零消费者（只在 `src/config.ts:662-665` 归一化）⇒ 批次大小实际无人限制；`headPack.maxScenarioEntries` 只在 `src/head-pack-compose.ts:57` 以 `options.maxScenarioEntries ?? 20` 出现，`src/segments/persona.ts:30-35` 没传 ⇒ 生效值恒为 20。
- **落到未接线模块**：`assetReflection.{enabled,triggerToken,alwaysOn,maxChars}` 仅在 `src/asset-reflection.ts` 内部被 `resolveAssetReflectionPolicy` 读（`:266-296`），该模块无任何 `src/index.ts` 引用（与 `docs/ops/dsh-plugin-capability-reference.md:173-176` 一致）。
- **别名读取（脚本 needs-review，实为生效）**：`volatile.wiki.{topK,perWikiLimit,minScore,timeoutMs}` → `src/segments/wiki.ts:33` 传整段 → `src/wiki-segment.ts:145-158` clamp；`volatile.knowledge.{maxResources,timeoutMs}` → `src/segments/knowledge.ts:31` → `src/knowledge-segment.ts:166-176`；`debugLogFile` → `src/index.ts:242`。
- **看不见但直接改行为（高风险）**：`server.requestTimeoutMs`（`src/index.ts:357`）、`volatile.timeoutMs`（`:677`）、`volatile.recallTimeoutMs`（`:708`，插件侧放弃阈值）、`volatile.recallMaxResults`（`:706`）、`tools.recallTopK`（`:748`）、`writeback.{maxAttempts,retryMs}`（`:1020-1021`、`:1051`）、`writeback.maxRequestBytes`（`:352`）、`skill.{searchTopK,maxResultChars,timeoutMs}`（`src/tools/skills.ts:410`、`src/index.ts:437`）。

## §5 「看着像消费，其实不算」的三个真例

- `volatile.wiki.maxChars` 在 `src/index.ts:1186` 的 ready 日志里出现 —— 日志读值不算消费；它真生效靠的是别名传参（§3 #22）。反向坑：`writeback.skillFeed` 也出现在 `:1179` 日志，但它另有 `src/writeback.ts:473` 的真分支。
- `headPack.maxScenarioEntries`：有类型、有 `?? 20` 兜底、有 DEFAULT_CONFIG 叶子 —— 三样齐全但配置值永远到不了函数，是「结构齐备、链路断开」。
- `debug` 唯一字面命中曾是 ready 日志 `:1226`；真 gate 在 `:241`（construct-or-undefined），只有实读才能分辨。

## §6 边界

- 纯静态：不执行插件、不起宿主、不跑真会话；「生效」= 代码路径可达且读值参与分支/预算，不等于实测行为。
- 脚本漏检面已点名：对象别名/整段传参（7 条 needs-review 即此形态），动态字符串拼属性、`(cfg as any).x` 同样捡不到。
- 未覆盖：`deploy/`、`~/.dsh/profiles/*` 的实际覆盖值（归生产档），以及 task-72 正在新增的 `skill.*` 三键接线后的复测。
