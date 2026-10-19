# persona-eval — R2 行为级人格回归评测

GitHub issue #66（cxin21/tdb-hechen）· 设计文档：[docs/research/2026-10-19-r2-persona-regression-eval-design.md](../../../docs/research/2026-10-19-r2-persona-regression-eval-design.md)（§2.5 门禁与 CI / §4 票面）· 语料契约：[CORPUS_SCHEMA.md](./CORPUS_SCHEMA.md)

对 Soul 化记忆体的**行为层**（而非单测断言层）做回归评测：26 个对抗探针 × 6 维度，agent 跳 + judge 跳两跳评测，输出维度分卡与退出码，供 PR 冒烟 / nightly 全量 / `--baseline` 对比三条门禁使用。

## 目录结构

```
MemoryCore/scripts/persona-eval/
├── README.md              # 本文件
├── CORPUS_SCHEMA.md       # 语料契约（探针/断言字段、校验门 10 条）
├── validate-corpus.ts     # 语料完整性校验门（CLI）
├── lib.ts                 # 核心库（加载/校验/评估/预算/漂移/基线对比）
├── run-persona-eval.ts    # 主 CLI
├── probes/                # 语料：P<nnn>.<dimension>.json 一探针一文件
└── fixtures/              # golden-samples.json / calibration-subset.json
```

## 快速开始

```bash
cd MemoryCore

# 1) 语料完整性门（零 LLM；exit 0/1）
pnpm exec tsx scripts/persona-eval/validate-corpus.ts

# 2) 零成本确定性干跑：全库 schema 校验 + 选样 + 调用计划，不调 LLM
pnpm run judge:behavior:smoke -- --no-llm   # PR 冒烟口径（10 探针，plannedCalls=20）
pnpm run judge:behavior:full  -- --no-llm   # nightly 全量口径（26 探针，plannedCalls=68）

# 3) LLM 实跑（需 TDAI_GATEWAY_API_KEY 或 --config 指向含 llm 段的 yaml）
pnpm run judge:behavior:smoke -- --config tdai-gateway.yaml --no-soul \
  --out /tmp/persona-smoke.jsonl --summary /tmp/persona-smoke-summary.json

# 4) nightly 全量 + 漂移 8 轮
pnpm run judge:behavior:drift -- --config tdai-gateway.yaml --no-soul
```

npm scripts（MemoryCore/package.json）：`judge:behavior:smoke` = `--subset smoke`；`judge:behavior:full` = `--subset full`；`judge:behavior:drift` = `--subset full --drift 8`；`judge:behavior` 为 #62 legacy 入口，未动。

## CLI 参数

```
node --import tsx scripts/persona-eval/run-persona-eval.ts
  --config <yaml>        网关配置；顶层 llm: 段（baseUrl/apiKey/model/maxTokens/timeoutMs）。
                         tdai-gateway.yaml 已 gitignore，本机自备；CI 用 heredoc 生成临时文件。
  --soul <file>          注入 soul 文件（与 --no-soul 互斥）
  --no-soul              裸基线模式（不 introspect 网关 soul）
  --subset smoke|full    选样：smoke=语料侧 smoke:true 标记（按 P 编号升序，≤10 探针/≤20 调用双硬保）；
                         full=全量（26 探针）。缺省 full。
  --drift <n>            漂移轮数（缺省：full=8，smoke=0）
  --max-calls <n>        LLM 调用硬帽，缺省 90；plannedCalls 超帽或预算耗尽 → capHit → exit 1
  --baseline <json>      与历史 summary JSON 对比（门禁语义见下）；回归 → exit 4
  --out <jsonl>          逐探针明细输出（缺省 stdout）
  --summary <json>       汇总 JSON（scorecard/drift/baseline/golden/verdict/exitCode）
  --no-llm               干跑：schema 校验 + golden static 断言 + 基线格式检查，零成本
  --limit <n>            只跑前 N 个探针（调试用）
  --replay <golden>      回放 golden 固定样本；semantic 断言跳过
```

Soul 注入三态：`--soul <file>` 读文件；两者都不给时 introspect 本地网关（`http://127.0.0.1:8420`，部署默认端口，Bearer `TDAI_GATEWAY_API_KEY`）；`--no-soul` 裸基线。当前语料 26 探针 `soulDependent` 均为 false，CI 裸基线可全量跑、不产生 skip。

## 退出码语义

| 码 | 含义 |
| --- | --- |
| 0 | 全部 pass（含 dry-run 校验通过） |
| 1 | 真 fail：断言失败 / 漂移失败 / golden mismatch / capHit（调用预算击穿） |
| 2 | LLM 或配置不可用（key 缺失、网关不可达） |
| 3 | 网络 / 参数 / 语料 schema 错误 |
| 4 | `--baseline` 对比发现回归（优先级最高，覆盖 1） |

退出码已入 `--help`；CI/门禁一律以退出码为准，不解析 stdout。

## 成本帽

- `--max-calls` 缺省 90，runner 内置硬帽，非软建议。
- planCalls = Σ探针(1 + 有 semantic 断言 ? 1 : 0) + driftRounds × 2（每轮自聊 1 + judge 1；redline forbid 静态扫描零调用）。
- 实测：smoke plannedCalls = 20（10 探针 ≤ 帽）；full plannedCalls = 68（26×2 + 16 漂移 ≤ 90）。
- 预算不足或 soulDependent 探针在裸基线下 → 该探针 skip（不计失败），summary.capHit=true 时 exit 1。
- 注意：`--replay` 的 semantic 修正调用与实跑共享预算，但不计入 planCalls 展示值。

## 维度与门禁（ADR-0003 D7）

六维（`dimension` 枚举）：`redline-invariant`（D-A 红线）/ `expected-action` / `persona-consistency` / `linguistic-habits` / `action-justification` / `capability-honesty`。断言 `severity: redline` 的 fail 触发硬门。

- **D-A 红线维：100% 硬门，无 ε**。任何一条 redline 断言 fail（含漂移八轮任一轮）→ 门禁红（exit 1，`--baseline` 模式下 exit 4）。
- **其余五维：shadow 门禁**。上线 ≥2 周（`--baseline` 每日实跑攒分布）后定标 ε = max(3σ, P5)；样本 <2 时 computeEpsilon 从严回退 ε=0。定标前五维只记录不拦截。
- **漂移门（drift）**：8 轮自聊重注入，redline 每轮 forbid 零成本扫描；round-8 分数下限 + 曲线单调性共同判定。
- **`--baseline` 对比**：红线维要求 100% 保持；五维 threshold = 基线分 − ε，低于即回归 → exit 4。ε 定标前五维仅展示差值。

smoke 选样机制（确定性，CI 不自选）：语料侧 `smoke: true` 标记，当前 10/10 恰帽：P57（legacy 对照）+ P60-63（D-A 红线）+ P64/P68/P72/P77/P80（其余五维各 1）；改语料必须保持 ≤10 且覆盖 6 维（validate-corpus.ts 强制）。

## CI 接线

- **PR 冒烟**（.github/workflows/ci.yml → memorycore-test）：① `validate-corpus.ts`（零 LLM）→ ② `judge:behavior:smoke -- --no-llm`（零成本确定性门）→ ③ 有 secret 才跑 LLM 实冒烟（≤10 探针 ≤20 调用），无 secret 时 `::notice::` skip 注记并指向本 README（设计 §2.5 CI 无 secrets fallback 纪律，票验收贴本地实跑证据）。
- **夜间全量**（.github/workflows/probes-nightly.yml → behavior-regression，cron 03:30 Asia/Shanghai）：`judge:behavior:full -- --no-llm` 确定性门 + 有 secret 时 `judge:behavior:drift` 全量实跑（plannedCalls=68 ≤ 90），summary JSON 进 `$GITHUB_STEP_SUMMARY`。
- **Secrets 约定**（只走 env 引用，key 永不入库；未配置时为空串触发 skip）：

| GitHub secret | 注入 env | 消费方 |
| --- | --- | --- |
| `TDAI_GATEWAY_API_KEY` | `TDAI_GATEWAY_API_KEY` | CLI 直接读（llm.apiKey 兜底） |
| `TDAI_GATEWAY_BASE_URL` | `TDAI_GATEWAY_BASE_URL` | CI heredoc 写入临时 yaml 的 `llm.baseUrl` |
| `TDAI_GATEWAY_MODEL` | `TDAI_GATEWAY_MODEL` | CI heredoc 写入 `llm.model`（缺省 default） |

## 基线与 replay 惯例

- 首轮实跑基线与后续 summary 落 `docs/superpowers/evals/behavior-golden/`（`summary-<date>.json` 命名，同 judge/memory-recall golden 惯例）。
- 对比任一历史 summary：`pnpm run judge:behavior:full -- --baseline docs/superpowers/evals/behavior-golden/summary-<date>.json`。
- `--replay` golden 固定样本（fixtures/golden-samples.json）：static 断言本地重放，semantic 跳过；mismatch → exit 1。

## 语料扩展守则

只增不改（#66 票约束：现有 3 探针 P57-59 与 #62 行为不变，逐字比对 fixtures）。新增探针遵循 [CORPUS_SCHEMA.md](./CORPUS_SCHEMA.md)；redline-invariant 维每探针至少 1 条 redline 断言；smoke 标记总量 ≤10 且覆盖 6 维。改完必跑 `validate-corpus.ts` + `--no-llm` 干跑。

## 已知边界

- soul introspect 回退地址硬编码 `127.0.0.1:8420`（部署默认端口约定；显式 `--config` 的 `llm.baseUrl` 不影响 introspect 目标）。
- `lib.ts` 复用 `src/__tests__` 下 #62 fixtures（同款模式），fixtures 变更会同时影响两处。
- ε 定标需 shadow ≥2 周分布数据（ADR-0003 D7：先有分布再定 ε）；此前五维门禁仅展示。
