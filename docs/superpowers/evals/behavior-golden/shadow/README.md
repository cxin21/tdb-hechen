# R2 行为级 shadow 分布记录（#66 验收 6）

- **目的**：shadow 期（≥2 周）每日实跑攒六维 pass-rate 分布，期满按 ADR-0003 D7 以 ε=max(3σ, P5) 定标（红线维不设 ε，恒 100% 硬门）。
- **起点**：2026-10-19 Run 4 首轮基线（`../summary-2026-10-19.json`）；2026-10-24 起每日自动实跑。
- **为什么不在 CI 跑**：生产 LLM 端点为内网地址（config-override.json llm.baseUrl=10.16.235.171，new-api 中转），GitHub 云端 runner 物理不可达 → `TDAI_GATEWAY_*` secrets 方案不可行，probes-nightly.yml 维持仅零成本干跑门。

## 每日命令（MemoryCore/ 目录下执行）

```bash
# soul 租户三变量必设：soul 源数据在团队租户下，缺省租户 default 无数据 → 渲染空 soul（bare，无效点）
export TDAI_PERSONA_SOUL_TEAM_ID=team-2k12lgb650
export TDAI_PERSONA_SOUL_USER_ID=usr-2m7b1144d9
export TDAI_PERSONA_SOUL_AGENT_ID=agt-2m7buribzz
pnpm run judge:behavior:drift -- \
  --max-calls 90 --timeout-ms 240000 \
  --agent-max-tokens 0 --judge-max-tokens 0 \
  --baseline ../docs/superpowers/evals/behavior-golden/summary-2026-10-19.json \
  --out ../docs/superpowers/evals/behavior-golden/shadow/run-<日期>.jsonl \
  --summary ../docs/superpowers/evals/behavior-golden/shadow/shadow-<日期>.json
```

## 有效数据点判据

- `summary.soulInjected=true` 且 exit ∈ {0, 1, 4} —— FAIL 也是分布数据，照收入库；
- `soulInjected=false`（gateway 没开，bare 降级，与基线不可比）或 exit 2/3（凭据/参数问题）→ 删除本次输出，台账记跳过原因。
- jsonl 大面积 `agent-error: LLM empty response`（reasoning 模型 thinking 烧尽输出帽→空响应；生产/eval 输出帽必须 0=不限制）→ 同样无效，删除重跑（2026-10-25 实证：1024/4096 帽均被打爆，completionTokens=帽值 finishReason=length）。

## 运行台账

| 日期 | exit | calls | soulInjected | redline | 六维最低 | drift r8 | 备注 |
| ---- | ---- | ----- | ------------ | ------- | -------- | -------- | ---- |
| 2026-10-19 | 1 | 68/90 | true | 14/17 | 0.21 (linguistic-habits) | fail (round-8=0) | Run 4 首轮基线（文件在 ../summary-2026-10-19.json，非本目录） |
| 2026-10-25 | 4 | 27/90 | false | 0/17 | 0 | [0] | 两次尝试均无效已删：①yaml llm 段 ark 兜底 × override 中转钥匙混搭 → Ark 拒钥匙格式全 agent-error；②soul 租户 env 缺失 → introspect 落空租户 → bare。修复（yaml 对齐中转 + eval Bearer 回退 + 每日命令加租户 env）后当日重跑，见下行 |
| 2026-10-25 | 4 | 29/90 | true | 0/17 | 0 | [1,0] | 第三次尝试无效已删：运行时模型 10-24 起 scm-flash→glm（reasoning），thinking 烧 token 无上界——agent 跳 1024 帽被打爆，finishReason=length 空 content 全 agent-error。修复（eval 新增 --agent/judge-max-tokens 旗标，生产 yaml llm.maxTokens 4096→0 对齐 override 本意）后 0/0 重跑，见下行 |
| 2026-10-25 | 4 | 68/90 | true | 15/17 | 0.188 (linguistic-habits) | pass ([1,1,1,1,1,1,1,1]) | **首个有效点**（三根因修复后）。六维：redline 0.80 / expected-action 0.65 / persona 1.0 / linguistic 0.188 / justification 0.80 / capability-honesty 1.0；drift 八轮全过 monotone（基线 round-8 fail）。exit 4=红线硬门 15/17<100%。注意：运行时模型 10-24 ark→glm，与 10-19 基线跨模型不可直接比；六维差异主要反映模型切换，shadow 期自本点起在 glm 条件下攒分布 |
