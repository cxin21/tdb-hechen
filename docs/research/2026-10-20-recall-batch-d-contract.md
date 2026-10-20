# Batch D 合同（#77 · survey F1 粒度主药 · D-a 先行，F4 后置另合同）

## 1. 范围

**D-a（本合同）**：反思结论卡产出侧确定性校验门 + few-shot 拆条升级（survey §2 :28 拍板口径：落点=产出侧确定性校验门，非仅改 prompt）。

1. `soul-reflection-contract.ts` 新增 `validateConclusionCard(content: unknown): { ok: true } | { ok: false; reason: string }`——确定性机械门：空/非串 → empty-content；码点长度 > `REFLECTION_CONCLUSION_MAX_CHARS=300`（复用 l1-extraction.ts:38 原子性上限同刻度，`Array.from` 码点计数）→ too-long。互不依赖事件数**不做确定性判定**（语义判定非机械门能力，宁缺毋滥交 LLM few-shot 引导）。
2. `reflection.ts` 写卡循环（:243 for proposals）内、`rec` 构造前：`validateConclusionCard(pr.conclusion)` 不 ok → `skipped++` 记日志（reason 附带）并 continue（拒收，不拆分——拆分语义属 LLM 职责，D8 纪律=门只裁决不创作）。
3. few-shot 产出指令（gate `cfg.soulProposals?.conclusionContract?.enabled === true` 才附加，**缺省 off=逐位现状**，对齐 #60 cardContract 先例 :235）：附加 `REFLECTION_CONCLUSION_CONTRACT_PROMPT`——「一句话一件事：每条 conclusion 只记一个稳定事实/结论，≤300 字；多个互不依赖的事拆成多条卡；宁缺毋滥」。
4. config.ts `soulProposals.conclusionContract.enabled`（boolean，缺省 false；parse 对齐 cardContract 同款形态）。

**F4（small-to-big 父块回链）**：量级 L、检索面大改（recall-layered scene/text hit 选择器改造），本合同不含，依此合同续票另立。

## 2. 非目标

不碰 consolidation/evolution 产出链（其产物 occurred_at/粒度由 C-a 与后续批次处置）；不碰 l1-extraction.ts:38 既有抽取链；不碰身份叙事 #60 契约；不碰检索面（F4 另票）；不引入 LLM 拆分调用（门零 LLM）。

## 3. 验收

- RED 先行：新用例先红（validateConclusionCard 边界 6 例：空/非串/300 内/301/码点 emoji/trim）+ reflection 拒收路径 1 例 + config parse 1 例 + few-shot gate off prompt 逐位断言 1 例；确认 RED 因正确原因失败后最小 GREEN。
- 门：vitest-core 全绿（基线 232/2052 + 新增，精确对账）；vitest-proxy 47/368 逐位；typecheck（pnpm run typecheck）243 守恒 ADDED 0/REMOVED 0。
- golden：缺省 off → no red cards + 命中率与 09-22 基线逐位一致（缺省关=逐位现状契约）。
- 对抗审查（只读 diff 精读，R-A 红线核查）→ surgical commit + push（m00637 授权链，只读盘点+diff 纯净核查，绝不裹挟外来 WIP）。
