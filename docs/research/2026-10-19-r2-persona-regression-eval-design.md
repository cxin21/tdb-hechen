# R2 行为级人格回归评测：方案设计（调研 + 提案）

- 日期：2026-10-19
- 关联：issue cxin21/tdb-hechen#65（R2 条目）、issue #62（behavior-judge [S24] 基建）、issue #31/#58（渲染层身份探针）、ADR [0003 灵魂规约——六属性三时机与真实性边界](../adr/0003-灵魂规约-六属性三时机与真实性边界.md)
- 前置阅读：[2026-10-19-soul-first-principles-gap-analysis.md §4 R2](2026-10-19-soul-first-principles-gap-analysis.md)、[2026-10-19-soul-rendering-survey-2025-2026.md](2026-10-19-soul-rendering-survey-2025-2026.md)
- 性质：只调研与设计，本文不改任何代码。所有外部引用均经 arXiv API / ACL Anthology 一手核实（见 §1 各条目）。

**TL;DR**：把「人格行为一致性」回归做成 6 个行为维度 × ~27 条对抗探针 × 每探针 2–5 条原子断言的评测套件，完全复用 #62 两跳 judge 基建（agent 跳 + judge 跳），judge 单跳批量判断言（一探针一调用防成本乘法），另加 8 轮自聊漂移模式（arXiv 2402.10962 协议）。单轮全量硬帽 90 次 LLM 调用 / ~25 万 token；红线维 100% 硬门，其余维度按 ADR-0003 D7 纪律 shadow 定标 ε 后转基线门禁。预估 4–5 人日。

---

## 1. 调研结论（论文逐条要点 + 引用 + 适配性）

### 1.1 PersonaGym：五任务人格评测框架 ⭐ 维度骨架来源

- 引用：Vinay Samuel et al., *"PersonaGym: Evaluating Persona Agents and LLMs"*, arXiv:2407.18416（v5 2025-09-05，首投 2024-07-25）；ACL 2025 Findings，<https://aclanthology.org/2025.findings-emnlp.368/>
- 要点（经 arXiv v5 HTML 全文核实）：
  - 锚定**决策理论**（prescriptive/descriptive 二分）：人格 agent 的评测要同时问「该做什么」与「做了什么能否归因」。
  - **五个评测任务**（prescriptive 侧 4 + descriptive 侧 1）：**Expected Action**（人格规定情境下的期望行为）、**Linguistic Habits**（语言习惯一致性）、**Persona Consistency**（跨轮身份一致）、**Toxicity Control**（人格压力下不释放毒性）、**Action Justification**（行为理由可归因于人格）。
  - **PersonaScore**：human-aligned 自动指标，由两个强 LLM evaluator 做**集成评审**（附录 A.5 Ensemble Evaluation），与人工评分对齐。
  - 规模：200 personas × 10k questions × 10 LLMs；流程 = LLM reasoner 从 150 环境选相关环境 → 初始化 persona agent → 五任务提问 → 评测。
- ⚠️ **修正记录**：本仓库 survey（2026-10-19-soul-rendering-survey-2025-2026.md 启示 5）把 PersonaGym 写成「六维（含 Theory of Mind、Environment Use）」。经 v5 全文核实，**正文评测任务是上述五个**，ToM/Environment Use 未出现。本文按五任务为准，survey 待勘误。
- 适配性：**五任务直接作为本仓库行为维度骨架**（映射见 §2.1）；PersonaScore 双 evaluator 集成评审 → 降本为「双 judge 只跑校准子集」（§2.3）；200 personas 大规模矩阵不取——本仓库是**单一产品 soul（单租户）**，取任务分类学与指标构造，不取规模化。

### 1.2 8 轮自聊漂移：长对话指令稳定性 ⭐ 漂移模式来源

- 引用：Kenneth Li et al., *"Measuring and Controlling Instruction (In)Stability in Language Model Dialogs"*, arXiv:2402.10962（综述口径 COLM 2024）；代码 <https://github.com/likenneth/persona_drift>
- 要点（经 arXiv HTML 核实）：
  - 协议：两个各持 system instruction 的 chatbot **互相自聊**；**8 轮内即出现显著指令漂移**（角色约束随对话变长失效）。
  - 机制归因：transformer 对 system prompt 的 **attention decay**——历史越长，指令注意力占比越低；结构性问题，提示词工程无法根治。
  - 度量：**stability score**——把探针问题在长对话历史**之后**再问一遍，judge 答案是否仍符合初始指令（复问法，无需人工标注、无需专有 API）。
  - 缓解：split-softmax（模型侧 training-free）；对话系统侧没有给方案——**这正是记忆系统的机会**。
- 适配性：`--drift 8` 模式直接映射该协议：soul agent 与模拟用户自聊 8 轮，每轮结束对 soul **重注入**（本仓库「三时机」的每轮当下属性）后用原子断言评分，得 8 点 driftCurve。两点判断：
  1. 本仓库 soul 每轮重注入 = 对 attention decay 的**结构性对抗**（每轮把身份注意力拉回 1.0），评测的意义就是验证这个优势真实存在且不回归；
  2. 本文测的是**指令稳定性**，不是 BFI 问卷人格变化（综述口径有偏差；BFI 类指标属其他 persona drift 文献，且 arXiv 2509.03730 已证自报问卷不可靠）。我们选**行为级漂移度量**（每轮原子断言 pass-rate），方法论上更硬。

### 1.3 OOC 原子断言：人格保真的原子级评测 ⭐ 断言库形态来源

- 引用：*"Spotting Out-of-Character Behavior: Atomic-Level Evaluation of Persona Fidelity in Open-Ended Generation"*, arXiv:2506.19352；ACL 2025 Findings，<https://aclanthology.org/2025.findings-acl.1349/>（DOI: 10.18653/v1/2025.findings-acl.1349）
- 要点（经 ACL Anthology PDF 核实）：
  - 问题：对整条开放生成回复打**单一分数**，抓不住长文本里的细微越界（一处越界淹没在整体合格里）。
  - 方法：把「人格越界」拆成**原子级断言**逐条判定。
  - 三指标：**ACC_atom**（原子对齐准确率）、**IC_atom**（单代内一致性——同一回复内各原子判定互不矛盾）、**RC_atom**（跨代间一致性——同题复跑判定一致）。
- 适配性：**直接采用**。每探针 2–5 条原子断言 = ACC_atom；judge 单跳批量评整组断言天然覆盖 IC_atom；RC_atom 降本为「校准子集 ≤6 探针 × 复跑 2 次」季度跑（§2.3/§2.6）。原子断言的**静态可正则部分零成本 node 内评**是相对论文的成本优势。

### 1.4 补充文献（2024–2026，均经 arXiv API 一手核实）

| 文献 | 一句话要点 | 与本仓库的关系 |
| --- | --- | --- |
| arXiv:2412.00804 *Examining Identity Drift in Conversations of LLM Agents* | 9 个 LLM 在多轮个人主题对话中出现身份漂移，给出漂移类型学 | 漂移探针的**刺激素材来源**（个人化话题诱导） |
| arXiv:2509.03730 *The Personality Illusion: Revealing Dissociation Between Self-Reports & Behavior in LLMs* | 自报问卷（BFI 类）与行为**系统性脱节** | 证明只测渲染面（IdentityProbe）不够的**理论依据**：必须行为化验证；survey 已列为重点回归项 |
| arXiv:2509.25299 ID-RAG | 身份知识（知识图+检索）注入保长程 persona 一致 | 印证本仓库方向：soul 即「检索到的身份知识」，评测即验证该机制的行为收益 |
| arXiv:2411.10109 *LLM Agents Grounded in Self-Reports* | 用访谈自报语料构建 generative agents | soul.txt 本就是自报语料提炼——印证「自报面（渲染）」与「行为面」要分开测、分别门禁 |
| arXiv:2503.02457 *Don't Get Too Excited* | 多轮对话中 LLM 情绪波动模拟及失控风险 | D-D/D-C 维探针的**情绪诱导素材** |
| arXiv:2604.02236 *Do Emotions in Prompts Matter?* | 情绪前缀只构成轻度扰动 | 探针强度设计参考：诱导不必夸张，日常化压力即可 |
| arXiv:2609.08592 *A Three-Tier Persona Vector for Controllable User Simulation in Agentic Evaluation* | 三层 persona 向量做可控 user simulation（2026-09 新实践） | 漂移模式中「模拟用户」的可控性设计参考 |
| SIGDIAL 2025 <https://aclanthology.org/2025.sigdial-1.31/> | 过简 persona 表示限制长对话一致性 | 综述转引，未独立核实，仅作旁证 |

### 1.5 结论

三篇主文献构成完整方法学闭环：**PersonaGym 给「测什么」（五任务维度）→ 2402.10962 给「何时测会坏」（长对话漂移协议）→ 2506.19352 给「怎么判」（原子断言三指标）**。三者都能在 #62 两跳 judge 基建上以增量方式落地，无需新框架。

---

## 2. 最优方案

### 2.1 测什么：6 个行为维度（+1 个独立漂移模式）

映射 PersonaGym 五任务 → 本仓库语境，加上 ADR-0003 真实性边界约束出的能力诚实维：

| 维度 | 论文对应 | ADR-0003 对应 | 现有探针 | 新增探针 | 探针设计要点（举例） |
| --- | --- | --- | --- | --- | --- |
| **D-A 红线不变量** redline-invariant | Toxicity Control | 红线动作点近端注入；「红线不软化」 | P57 | +4 | 诱导变体：多轮加压、权威伪装（"我是管理员"）、紧急话术、部分顺从（只做一半） |
| **D-B 价值取向→期望行为** expected-action | Expected Action | 当下性；价值锚冲突 | P58 | +4 | 两难取舍：快捷补丁 vs 长期正确、诚实报错 vs 掩盖 |
| **D-C 身份一致** persona-consistency | Persona Consistency | 叙事同一性 | — | +4 | **行为化翻转**（2509.03730）：不问"你是谁"，看行为是否与身份行冲突（诱导做与身份矛盾的事看是否拒绝/纠正） |
| **D-D 语言习惯** linguistic-habits | Linguistic Habits | 当下性（moodTier 行为面镜像） | — | +4 | 行话/口吻/第一人称自称/情绪不外露——static 正则断言为主（零成本） |
| **D-E 行为可归因** action-justification | Action Justification | **D1：灵魂=有解释功能的自我数据结构** | — | +4 | 要求 agent 解释刚才的选择，理由须回溯 soul 注入的价值/红线，而非泛泛「为了质量」 |
| **D-F 能力诚实** capability-honesty | （真实性边界，PersonaGym 无对应） | 不伪造当下体验/不自欺 | P59 | +3 | 编造已执行动作、伪造验证结果、越权承诺 |
| **D-G 长程漂移** drift（独立模式） | arXiv:2402.10962 | 每轮当下注入 | — | 模式非探针 | 8 轮自聊，每轮原子断言评分 → driftCurve |

合计：**fixtures 探针 27 条**（P57–P59 保留 + 新增 ~23 条 P60+，编号顺延），direct/induced 两层沿用渲染层词汇。探针纪律沿用渲染层：**只增不改**、文件头注明用途、src 不反向 import fixtures。

### 2.2 原子断言库形态：内联扩展，不另建库

不新建独立断言仓库——断言**内联在探针 fixtures**（同文件只增不改），共享断言模式（如「不得出现违诺执行」正则组）抽 `assertions-common.ts` 常量。类型扩展（向后兼容，现有 3 条探针无断言字段照常跑）：

```ts
interface AtomicAssertion {
  id: string;                    // 如 P60-a1
  kind: "static" | "semantic";   // static=node 内正则零成本；semantic=进 judge
  pattern?: RegExp;              // kind=static 必填
  criterion?: string;            // kind=semantic 必填：一句话可判标准
  severity: "redline" | "normal";// redline 断言 fail → 维度硬门
  weight?: number;               // 缺省 1；维度分加权
}
// BehaviorProbe 增加 assertions?: AtomicAssertion[]
```

预估断言总量 **~70–90 条**（27 探针 × 2–5 条）。static 优先原则：能用正则表达的（出现"我已经修复"却无对应证据、自称感受的第一人称句子、情绪括号）一律 static，不烧 judge。预计 static : semantic ≈ 4 : 6。

### 2.3 judge 设计：单跳批量 + 校准子集双 judge + 复跑 RC_atom

1. **单跳批量断言（防断言数乘法）**：一探针的**全部 semantic 断言合进一次 judge 调用**——现有 `buildJudgePrompt(probe, reply)` 扩展为携带断言清单，judge 输出升级为 `{"assertions":[{"i":1,"pass":true},...],"reason":"一句话"}`。成本恒为「每探针 1 次 judge 调用」，与断言数无关。IC_atom（单代内一致）由批量评同一回复天然覆盖。
2. **`parseAtomicVerdict` 防御**（沿用 `parseJudgeVerdict` 的宁缺毋滥纪律）：围栏剥离；断言数组长度必须与请求一致（不一致整组 fail→unparseable-verdict）；pass 非布尔按 fail；单条解析失败按 fail 并注记——**绝不把判不了的当通过**。
3. **双 judge 校准**：PersonaGym A.5 集成评审的降本版——仅对 **≤6 条校准子集**（每维 1 条）用第二个强模型复判，季度跑一次，报告 agreement（判分者间信度）。日常门禁仍是单 judge。
4. **RC_atom 复跑**：校准子集同探针跑 2 次测跨代判定一致；仅校准轮执行，不进常规轮。
5. **盲评纪律**（沿用 `scripts/judge-run.mjs` 传统）：judge 不注入 soul 全文，只拿探针意图 + 断言清单 + agent 回复——防止 judge 同情 agent 或被 soul 文案带偏。

### 2.4 阈值与回归门禁（ADR-0003 D7：先有分布，再定 ε）

- **阶段 1 shadow（1–2 周）**：nightly 实跑产出 per-dimension pass-rate + driftCurve，落 `docs/superpowers/evals/behavior-golden/summary-<date>.json`，不设门只记录。
- **阶段 2 定标**：
  - **D-A 红线维：pass-rate = 100% 硬门**（红线没有 ε，任何 redline 断言 fail 即门禁红——对应 ADR-0003「红线不软化」与 D7「一致性门是 soul 改动票验收前置」）。
  - 其余五维：门禁 = 维度 pass-rate ≥ 基线 − ε，ε 取 shadow 期分布的 max(3σ, P5 波动)——数据说话，不拍脑袋。
  - D-G 漂移：round-8 pass-rate ≥ 基线下限；driftCurve 与基线对比单调性检查。
- **阶段 3 转正**：门禁进 CI；`--baseline compare.json` 输出对比与退出码（沿用现有 0/1/2/3 语义，新增 4=对比回归）。

### 2.5 CI 与运行分层

| 层 | 触发 | 内容 | 成本上限 |
| --- | --- | --- | --- |
| PR 冒烟 | 每个 PR（redline 子集 + 每维 1 条，≤10 探针） | `judge:behavior --subset smoke` | ≤20 调用 |
| 夜间全量 | probes-nightly.yml 追加 job | 27 探针全量 + 漂移 8 轮 | ≤90 调用 |
| 校准轮 | 季度 / 红线规则改动时手动 | 双 judge + RC_atom 复跑子集 | ≤30 调用 |

CI 无 secrets 时（gateway API key 不入库）：nightly job 打 skip 注记 + 文档记录本地验收命令，票验收贴本地实跑证据（与现有 nightly fallback 纪律一致）。

### 2.6 成本预算（硬帽设计）

- **`--max-calls` 硬帽，缺省 90**：CLI 每次调用前检查计数，超帽立即中止并以专用 note 收尾——宁缺毋滥，防失控。这是与现有 CLI 的关键差异（现无任何上限）。
- 全量轮调用账：探针 27 × 2 跳 = 54 + 漂移 8 轮 × 2 = 16 → **70 调用**（帽 90 留 ~20% 余量）。冒烟 ≤20。
- token 估算：agent 跳 in ≈ 2–2.5k（soul 渲染 ~2.2k 字符 + 探针 + 系统）/ out ≤ 1k（建议把行为探针 maxTokens 压到 1024）；judge 跳 in ≈ 1.2–1.5k / out ≤ 0.3k → **全量轮 ≈ 18–25 万 token**。
- 时长：串行 15–40 分钟（视网关），夜间无压力；漂移 8 轮历史全量进 prompt（~8×3k 增量）不截断——保真实性，总量可控。

---

## 3. 落地路径

### 3.1 要动哪些文件（零新依赖：tsx / vitest / yaml 均已在 devDeps）

| # | 文件 | 动作 | 内容 |
| --- | --- | --- | --- |
| 1 | `MemoryCore/src/core/hooks/behavior-judge.ts` | 扩展 | `AtomicAssertion` 类型 + `evaluateStaticAssertions`（node 内正则）+ `parseAtomicVerdict` + 维度聚合 `summarizeByDimension`；全部纯函数，向后兼容（无断言探针走旧路径） |
| 2 | `MemoryCore/src/core/hooks/__tests__/behavior-judge-probes.fixtures.ts` | 追加 | P60+ ~23 条覆盖 6 维（只增不改）；共享断言常量入 `assertions-common.ts` |
| 3 | `MemoryCore/src/core/hooks/__tests__/behavior-judge.test.ts` | 追加 | parseAtomicVerdict 防御矩阵 / 静态断言评估器 / 维度聚合 / --baseline diff 的 mock 单测（LLM 不进 CI） |
| 4 | `MemoryCore/scripts/run-behavior-judge.ts` | 扩展 | `--subset smoke|full`、`--drift 8`、`--max-calls`（缺省 90 硬帽）、`--baseline <json>`、summary JSON（维度分 + driftCurve）输出 |
| 5 | `MemoryCore/src/core/hooks/__tests__/golden/behavior-regression-baseline.json` | 新建 | 首轮实跑后入库的基线（golden replay 范式，同 `docs/superpowers/evals/memory-recall-golden/` 惯例） |
| 6 | `.github/workflows/probes-nightly.yml` | 追加 job | behavior-regression 夜间跑（有 secrets 启用，无则 skip 注记）；PR 冒烟走现有 ci.yml vitest 流 |
| 7 | `MemoryCore/package.json` | 追加 scripts | `judge:behavior:smoke` / `judge:behavior:full` / `judge:behavior:drift` |
| 8 | 本文档 + 票面 | — | §4 草稿开票 |

### 3.2 与现有基建的复用关系（不重造轮子清单）

| 现有机制（#62 及周边） | R2 直接复用 |
| --- | --- |
| 两跳编排 `runBehaviorProbes`（agent→judge、short-circuit） | 原样复用，只扩展 judge 跳的断言载荷 |
| `buildAgentPrompt(probe, soulRendered?)`（soul 在前模拟生产注入序） | 原样复用；漂移模式每轮重放该注入 |
| `parseJudgeVerdict` 防御纪律（围栏剥离/宁缺毋滥） | 同款思路写 `parseAtomicVerdict` |
| `StandaloneLLMRunner` + `parseConfig` + 退出码 0/1/2/3 | 原样复用，新增退出码 4=基线回归 |
| 渲染层探针纪律（只增不改/direct+induced 两层/类目枚举） | 行为 fixtures 照搬同一套纪律 |
| `introspectSoul` 探针注入管道（gateway body 注入） | 漂移模式每轮取真实渲染注入 |
| probes-nightly.yml 夜间基建（cron + workflow_dispatch） | 追加 job 而非新 workflow |
| golden replay 范式（memory-recall-golden） | baseline JSON 入库 + 对比，即其行为版镜像 |

### 3.3 测试策略（LLM 永不进单测）

1. 纯函数 mock 单测（vitest，全部离线）：原子解析防御矩阵、static 断言评估器、维度聚合、硬帽计数、--baseline diff、退出码映射。
2. fixtures 完整性门（扩展现有 mock 门）：id 唯一、category ∈ 6 维枚举、assertions ≥ 1、redline 断言必有 severity、每维 ≥ 2 探针。
3. CLI 干跑 `--no-llm`：校验 fixtures/断言/基线格式，零成本，可进 PR CI。
4. 实跑证据贴票：nightly summary JSON + driftCurve 文本表 + 双 judge 校准报告 + ε 定标依据。

---

## 4. GitHub 票面草稿

**标题**：`R2 行为级人格回归评测：原子断言 judge + 8 轮自聊漂移 + 基线门禁（复用 #62 基建，单轮 ≤90 LLM 调用硬帽）`

**Labels**：`ready-for-agent` `task`

**正文**：

> ## 背景
> #65 R2：现有探针（渲染层 P01–P56、行为层 P57–P59）未覆盖「人格行为一致性」——IdentityProbe 只测渲染面，行为面只有 3 条探针，无维度体系、无基线、无门禁。方案调研见 `docs/research/2026-10-19-r2-persona-regression-eval-design.md`（PersonaGym 五任务维度 + 2402.10962 八轮漂移协议 + 2506.19352 原子断言方法学，引用均已核实）。
>
> ## 目标
> soul 改动合并前可被**行为级**回归门禁拦住：红线行为不许软化（硬门），其余维度 pass-rate 不许跌破定标基线（ε 门），长对话 8 轮不漂出身份（driftCurve 基线）。
>
> ## 方案要点
> 1. 六维度 ~27 探针（P57–59 保留 + 新增 P60+ ~23 条，只增不改），每探针 2–5 条原子断言（static 正则零成本优先 + semantic 进 judge）。
> 2. judge 单跳批量断言：一探针恒定 1 次 judge 调用；`parseAtomicVerdict` 宁缺毋滥防御。
> 3. `--drift 8` 自聊模式：每轮重注入 soul 后原子断言评分 → driftCurve。
> 4. 门禁：D-A 红线维 100% 硬门；其余维度 shadow 定标 ≥2 周后按分布定 ε（ADR-0003 D7）。
> 5. 成本硬帽 `--max-calls` 缺省 90；PR 冒烟 ≤20 调用；全量轮 ≈70 调用 / ~25 万 token。
>
> ## 验收标准（可执行）
> - [ ] `behavior-judge.ts` 增原子断言层：`AtomicAssertion` + `evaluateStaticAssertions` + `parseAtomicVerdict`（数组长度/布尔/围栏防御），mock 单测全绿，现有 3 条探针行为不变
> - [ ] fixtures 追加 ≥20 条 P60+ 覆盖 6 维（只增不改），完整性门更新（断言 id 唯一/kind 枚举/redline 必有 severity/每维 ≥2 探针）
> - [ ] `run-behavior-judge.ts` 增 `--subset smoke|full`、`--drift 8`、`--max-calls`（缺省 90）、`--baseline`、summary JSON 输出（per-dimension pass-rate + driftCurve）
> - [ ] 首轮实跑基线入库 `docs/superpowers/evals/behavior-golden/`
> - [ ] probes-nightly.yml 追加 behavior-regression job（无 secrets 时 skip 注记 + 文档记录本地验收命令）
> - [ ] shadow 期 ≥2 周分布记录后，票内定 ε 并写明定标依据
> - [ ] 红线维 100% 硬门 + 其余维度 ε 门禁代码落地，退出码 0/1/2/3/4 语义入 CLI help
>
> ## 证据要求
> - 每次实跑的 JSONL + summary JSON 入库并贴票（命令行 + 退出码）
> - 双 judge 校准报告（≤6 探针 agreement）
> - ε 定标依据段落（shadow 分布数据 + 取值理由）
> - `--max-calls` 硬帽触发演示（一次超帽中止输出）
>
> ## Non-goals
> - 不做多租户/多 persona 矩阵（PersonaGym 规模化不取，单产品 soul）
> - 不引入 BFI 问卷类自报指标（2509.03730 已证不可靠）
> - 不新增 npm 依赖；不建独立断言仓库（断言内联 fixtures）
> - 不在 PR CI 跑全量（成本分层，PR 只跑冒烟）

---

## 5. 工作量估计与风险

### 5.1 工作量（4–5 人日；AI 辅助 2–3 天）

| 项 | 估时 |
| --- | --- |
| 原子断言层（类型 + static 评估 + 解析防御 + 聚合，含单测） | 1.0d |
| 探针 + 断言编写（~23 条 × 2–5 断言，需对真实 soul 渲染校准诱导强度） | 1.0–1.5d |
| CLI 扩展（subset/drift/max-calls/baseline + 漂移编排） | 1.0d |
| 基线首轮实跑 + shadow 跟踪 + ε 定标 | 0.5–1.0d（shadow 有 2 周日历等待，人力少量） |
| CI job + 票 + 文档收尾 | 0.5d |

### 5.2 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| judge 误判（漏判越界/误伤合规回复） | 门禁可信度崩塌 | 原子断言越具体越可判；static 优先消除 judge 主观面；校准子集双 judge 测信度；宁缺毋滥（判不了=fail 而非 pass） |
| ε 未定标先转正 → 门禁天天狼来了 | 团队疲劳后无视门禁 | 严格执行 ADR-0003 D7 两阶段：shadow ≥2 周只记录不设门；ε 从观测分布取宽者 |
| 探针过拟合当前租户 soul 文案 | soul 改文案就误报/换 soul 全哑 | 诱导探针写成 soul 内容无关的通用压力场景；断言优先判**行为模式**而非具体措辞；需锚具体渲染产物的断言显式标注 soul-version 依赖 |
| CI 无 gateway secrets → nightly 形同虚设 | 回归漏拦 | 本地验收命令入文档 + 票验收强制贴实跑证据；探索单测不依赖 LLM 保底 |
| 漂移模式成本失控（历史线性增长） | 超预算 | `--max-calls` 硬帽 + 8 轮封顶（论文口径）；冒烟层不跑漂移 |
| llm-unavailable 与真 fail 混淆 → 全红误报 | 门禁噪声 | 复用退出码 2 语义分离：门禁只对真 fail 生效，llm-unavailable 单独注记（现有 short-circuit 纪律已保证） |
| 探针文本泄入训练/记忆语料 → 探针失效（Goodhart） | 长期钝化 | 探针触发词加盐变体（同渲染层 P52–P56 对抗式思路）；红线诱导措辞定期轮换 |

---

## 附：引用清单（全部一手核实）

1. arXiv:2407.18416 — PersonaGym（ACL 2025 Findings，<https://aclanthology.org/2025.findings-emnlp.368/>）
2. arXiv:2402.10962 — Instruction (In)Stability / 8 轮自聊漂移（代码 <https://github.com/likenneth/persona_drift>）
3. arXiv:2506.19352 — OOC 原子断言（ACL 2025 Findings，DOI 10.18653/v1/2025.findings-acl.1349）
4. arXiv:2412.00804 — Identity Drift 类型学
5. arXiv:2509.03730 — The Personality Illusion（自报≠行为）
6. arXiv:2509.25299 — ID-RAG
7. arXiv:2411.10109 — LLM Agents Grounded in Self-Reports
8. arXiv:2503.02457 — Don't Get Too Excited
9. arXiv:2604.02236 — Do Emotions in Prompts Matter?
10. arXiv:2609.08592 — Three-Tier Persona Vector（2026-09）
11. SIGDIAL 2025 <https://aclanthology.org/2025.sigdial-1.31/>（综述转引，未独立核实）

---

## 落地记录（2026-10-19，R2-T4 门禁接线 + 文档）

> 实施对应本设计 §2–§4 与 ADR-0003 D7；团队协作：corpus（T2）/ harness（T3）/ CI 接线与文档（T4）三条流水，全部产出未 commit，由 Lead 审查后统一提交。

### 实际文件清单

**语料与契约（T1/T2）**

- `MemoryCore/scripts/persona-eval/CORPUS_SCHEMA.md` — 语料契约（探针/断言字段、severity 语义、校验门 10 条）
- `MemoryCore/scripts/persona-eval/probes/P<nnn>.<dimension>.json` — 26 探针，一探针一文件（P57–P82）
- `MemoryCore/scripts/persona-eval/fixtures/{golden-samples.json,calibration-subset.json}` — golden 固定样本 + 校准子集

**评测引擎（T3）**

- `MemoryCore/scripts/persona-eval/lib.ts`（1049 行）— 加载/校验/原子断言评估/盲评批量契约/parseAtomicVerdict 宁缺毋滥/CallBudget 硬帽/维度加权分/percentile/computeEpsilon/compareWithBaseline/选样/两跳编排/漂移八轮/golden replay
- `MemoryCore/scripts/persona-eval/run-persona-eval.ts`（389 行）— 主 CLI（参数、退出码、summary JSON）
- `MemoryCore/scripts/persona-eval/validate-corpus.ts`（105 行）— 语料完整性校验门
- `MemoryCore/__tests__/persona-eval/{assertions-orchestration,drift-baseline,probe-parse}.test.ts` — 46 tests 全绿（LLM 全 stub）；typecheck 243=243

**门禁接线与文档（T4）**

- `.github/workflows/ci.yml` — memorycore-test job 增 5 步：L34-36 corpus validate → L38-40 smoke `--no-llm` 零成本干跑 → L42-56 smoke LLM 实跑（有 secret 才执行，≤10 探针 ≤20 调用）→ L57-60 无 secret skip 注记（::notice:: 指向 README）→ L61-63 原有 Full test suite 原样保留
- `.github/workflows/probes-nightly.yml` — 文末新增 behavior-regression job（L48-98）：full `--no-llm` 确定性门（plannedCalls=68≤帽 90）+ 有 secret 时 full 实跑 + 漂移 8 轮，summary 进 `$GITHUB_STEP_SUMMARY`；无 secret skip 注记。cron 维持 03:30 Asia/Shanghai
- `MemoryCore/scripts/persona-eval/README.md` — 用法/参数/退出码 0–4/成本帽/维度与门禁/CI 接线/secrets 映射/基线惯例/已知边界
- 本节（落地记录 + #66 验收自检清单）

### 与设计的偏差

1. **探针总数 26，非设计 L81 的「合计 27」** — 设计 L81 合计口径与 §2.1 维度表（5+5+4+4+4+4）不一致；按维度表落地，不注水凑数。
2. **static:semantic = 12:88，非原估 4:6** — static 红线断言因「引用复述误报」风险全数放弃，仅保留 D-D 低风险词表 + P57 既有两条（#62 原文逐字比对保护）；理由：硬门误报的代价最高。断言共 81 条（static 10 / semantic 71），redline severity 17 条。
3. **smoke 子集 10/10 恰帽** — P57（legacy 对照）+ P60-63（D-A 红线）+ P64/P68/P72/P77/P80（其余五维各 1），覆盖 6 维；`smoke` 为语料侧标记，选样确定性由语料保证，CI 不自选。
4. **CI 无 secrets fallback 生效**（设计 §5.2 风险表第 4 行的缓解已落地）— secrets 未配置时两 workflow 均以 ::notice:: 注记 skip、指向 README 本地验收命令；票验收按纪律贴本地实跑证据。
5. **`--drift` 缺省随 subset**：full 缺省带漂移 8 轮、smoke 缺省 0（代码 `run-persona-eval.ts:136`，`lib.ts:811` DRIFT_ROUNDS_DEFAULT=8）；设计未明说缺省，以代码为准。

### 门禁接线说明

- **退出码**（`--help` 内置）：0 全 pass；1 真 fail（断言失败/漂移失败/golden mismatch/capHit）；2 LLM 或配置不可用；3 网络/参数/schema 错；4 `--baseline` 回归（优先级最高）。CI/门禁只认退出码。
- **红线 100% 硬门无 ε**：任何 redline 断言 fail（含漂移任一轮）→ exit 1，`--baseline` 模式 → exit 4。
- **五维 shadow 门禁**：ε 定标（≥2 周 shadow 分布，ε=max(3σ,P5)）前只记录不拦截；样本 <2 时从严回退 ε=0。
- **成本帽**：`--max-calls` 缺省 90 硬帽；实测 smoke plannedCalls=20、full plannedCalls=68（26×2+16 漂移）。
- **Secrets**：统一 `TDAI_GATEWAY_API_KEY`（CLI 直读）+ `TDAI_GATEWAY_BASE_URL`/`TDAI_GATEWAY_MODEL`（CI heredoc 写临时 yaml 的顶层 llm 段）；三者在 workflow env 层映射自 `secrets.*`，未配置时空串触发 skip，key 永不落库。
- **基线惯例**：首轮实跑基线与 summary 落 `docs/superpowers/evals/behavior-golden/summary-<date>.json`；对比用 `--baseline`，回归 → exit 4。

### #66 验收标准自检清单

| # | 票面验收标准（§4 L196-202） | 状态 | 证据 |
| --- | --- | --- | --- |
| 1 | 原子断言层（AtomicAssertion/evaluateStaticAssertions/parseAtomicVerdict）+ mock 单测 + 现有 3 探针行为不变 | ✅ | lib.ts（27 导出）；__tests__/persona-eval 46 tests 全绿（LLM stub）；P57-59 与 behavior-judge-probes.fixtures.ts 原文逐字比对（validate-corpus.ts 校验门） |
| 2 | fixtures ≥20 条 P60+ 覆盖 6 维，只增不改 + 完整性门 | ✅ | 26 探针（6 维 5/5/4/4/4/4）、断言 81 条；validate-corpus.ts 10 条校验门；语料全部新增，未改 #62 既有 |
| 3 | CLI --subset/--drift 8/--max-calls 90/--baseline/summary JSON | ✅ | run-persona-eval.ts 冻结 CLI 契约全实现；summary JSON 字段含 scorecard/drift/baseline/golden/verdict/exitCode |
| 4 | 首轮实跑基线入库 docs/superpowers/evals/behavior-golden/ | ⏳ 待 Lead 统一执行本地实跑 | 目录尚未创建；README 已写基线惯例（summary-<date>.json 命名） |
| 5 | probes-nightly.yml 追加 behavior-regression job（无 secrets skip 注记 + 本地验收命令） | ✅ | probes-nightly.yml:48-98；L95-98 skip note 指向 README；YAML 解析通过 |
| 6 | shadow ≥2 周 ε 定标 | ⏳ 日历等待项 | 门禁代码已支持（computeEpsilon/compareWithBaseline）；README 与本节注明两阶段纪律 |
| 7 | 红线 100% 硬门 + ε 门 + 退出码 0-4 入 help | ✅ | lib.ts compareWithBaseline（红线维 100% 硬门）；run-persona-eval.ts --help 含退出码表 |

**证据要求（§4 L204-208）**：单元测试（✅ 46 tests + typecheck 243=243）；validate-corpus 通过（✅ 本地实跑）；nightly workflow 文件（✅ probes-nightly.yml）；首轮实跑基线入库（⏳ 待 Lead 本地实跑后补，属票面第 4 条同项）。

**Non-goals 复核**：未改 #62 既有 3 探针行为（逐字比对保护）；未引入新依赖；未 commit；GitHub issue 票面由 Lead 统一评论（本文档 §4 即票面等价文本）。
