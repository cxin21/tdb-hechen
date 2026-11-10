# AGENTS.md — td-agemem（TDB 自进化记忆系统）

## Agent skills

### Issue tracker

Issues 记录在 GitHub Issues（仓库 `cxin21/tdb-hechen`，经 `gh` CLI 读写）。See `docs/agents/issue-tracker.md`.

### Triage labels

标签词汇 = triage 五角色默认名（`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`）+ wayfinder 五标签（`wayfinder:map` / `research` / `prototype` / `grilling` / `task`），已在仓库建齐。See `docs/agents/triage-labels.md`.

### Soul (人格卡注入)

自维护人格层 = 八层 persona（voice/identity/self/values/boundary/relationship/narrative/human）+ 6 轴特质状态（轴承载漂移、标签是视图）+ append-only 账本，0 人工采纳。**人格恒开**（已删除 `soulMaintenance.enabled` 总闸）；注入由 DSH 插件两段完成：稳定段 = 系统提示词里的 `<persona-card>`（`GET /v3/soul/card`），每轮尾巴 = `<soul-feeling>`（`GET /v3/soul/turn`）。改人格层、注入或情绪/心境逻辑前先读 `docs/soul-self-maintenance.md`（运行手册）与 `docs/adr/0028-persona-card-v3-declared-observed.md`（当前决策；ADR-0026/0027 已被取代）。验收：`cd MemoryCore && node scripts/typecheck-gate.mjs && npx vitest run`，`cd dsh-plugin && npm test`；生产看 `/v3/soul/card`、`/v3/soul/injection/stats` 与 `soul_snapshots`。

### Domain docs

single-context —— 一份根目录 `CONTEXT.md` + `docs/adr/`，架构决定走 ADR。See `docs/agents/domain.md`.
