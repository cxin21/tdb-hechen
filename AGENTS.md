# AGENTS.md — td-agemem（TDB 自进化记忆系统）

## Agent skills

### Issue tracker

Issues 记录在 GitHub Issues（仓库 `cxin21/tdb-hechen`，经 `gh` CLI 读写）。See `docs/agents/issue-tracker.md`.

### Triage labels

标签词汇 = triage 五角色默认名（`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`）+ wayfinder 五标签（`wayfinder:map` / `research` / `prototype` / `grilling` / `task`），已在仓库建齐。See `docs/agents/triage-labels.md`.

### Soul (人格注入)

自维护人格层 = 六层（voice/identity/values/boundary/relationship/narrative）+ 确定性判据 + append-only 账本，0 人工采纳。开关注入：`memory.coreMemory.soulMaintenance.enabled`。改人格层、注入预算或情绪/心境逻辑前先读 `docs/soul-self-maintenance.md`（运行手册）与 `docs/adr/0026-soul-self-maintenance-six-layers.md`（决策与后果）。回放验收：`SOUL_REPLAY_DB=D:/TDB/data/vectors.db pnpm vitest run src/core/soul/__tests__/soul-replay-prod.test.ts`。

### Domain docs

single-context —— 一份根目录 `CONTEXT.md` + `docs/adr/`，架构决定走 ADR。See `docs/agents/domain.md`.
