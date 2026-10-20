# Batch B 合同（#76）：F2 结论层密度优先截断 + 字符预算再分配

> 2026-10-20 · 依据 final-plan D1 路线（用户 m00637 授权按序执行）· 票面 cxin21/tdb-hechen#76

## §0 背景与病灶（一手取证）
- 结论层 consolidation 产物整包注入，`conclusionLayer.maxCharsPerMemory` 缺省 2000 逐位截断（`recall-layered.ts:239-251`，接线 `auto-recall.ts:812-818`）。
- `applyRecallBudget`（`auto-recall.ts:1066`，对结论+经验合并行生效）的 `recall.maxCharsPerMemory/maxTotalRecallChars` 缺省 0=off（`config.ts:1634-1635`）→ 生产结论行 2000 字/行直通、无总预算；T4：行均 ~2000 vs 全体 p50 348，字符口径 ~90% 注入预算被结论层占用。
- 活体：同一「TDD 总纲」2024 字整包结论 14 天内 P10/P9/P1/P4/P6 重复召回 5 次；结论层 8 行 0 高价值（「命中了也用不上」= 粒度/密度失败，非主题相关性失败）。

## §1 范围（surgical，config-first 缺省关）
1. **recall-layered.ts 新增 `export function truncateConclusionContentSentences(content, maxChars)`**：句界累积截断（。！？；\n 分句，Array.from 码点安全）；预算内整句累积、句尾不劈半；首句单独超预算→退化既有 chars 逐位语义（绝不返空）；尾部标注同款 `…[截断:原文N字]` 计入预算；0/负/NaN=透传；limit≤markerLen→纯码点截断（同现退化路径）。**既有 `truncateConclusionContent` 语义零变化**（scene-governance.ts:106/:111 复用面不动）。
2. **config.ts（MemoryCore/src/config.ts）conclusionLayer 增两键**：`truncateMode?: "chars"|"sentences"`（缺省/非法值="chars"=逐位现状）；`maxTotalChars?: number`（缺省 undefined=关；负值/非有限 clamp 0；floor）。`RecallConfig.conclusionLayer` 类型同步。
3. **auto-recall.ts :812-818 截断块扩展**：读入 mode+maxTotalChars；maxTotalChars>0 且有结论→`perLine=floor(min(maxTotalChars/结论行数, maxCharsPerMemory))`，逐条按 mode 截断（chars→既有函数；sentences→新函数）；maxTotalChars 关/无结论→perLine=maxCharsPerMemory 现状逐位。截断仍先于幂等指纹与 rerank 门（:811 注释语义保持）。
4. **新增纯函数 `allocateConclusionPerLineChars(count, maxTotalChars, maxCharsPerMemory)`**（recall-layered.ts）——可单测、接线单一源。
5. **测试**：recall-layered.test.ts 新 describe（sentences 截断全语义 + allocate 边界）+ config parse 用例（两键缺省/非法/边界）；既有 Task CAL C1 用例 = 现状回归锚。

## §2 非目标
- 不碰 selectL2Conclusions 选择器/九通道排序/绝对门槛；不改 scene-governance；不改经验层 applyRecallBudget 语义；F1 拆条/F4 small-to-big 另票（Batch D）。
- 生产 yaml 翻转（truncateMode=sentences、maxTotalChars 取值定标）属部署侧运维域；验收含 runner 临时 yaml 显式开旋钮的 A/B 对照轮。

## §3 验收门
1. TDD RED 先行：新用例确认因特性缺失失败（正确原因）；GREEN 最小实现。
2. vitest-core 基线 231 files/2024 + 新增零回归；vitest-proxy 47/368 逐位一致；typecheck error TS=243 零新增。
3. golden runner（#73 交付）对生产 DB 副本真实数据复跑 A/B：sentences+maxTotalChars 对照 chars 现状——高价值率不降、注入字符下降、perfMs p50 不升。
4. 独立对抗审查（只读）→ 全量门复跑 → 分步 commit+push（用户已授权，surgical 逐 commit 核对）。

## §4 工作量与风险面
S-M；风险面=注入面（结论块文本形态），不触写入管线与反思管线；零生产数据触碰（runner 只读副本）。
