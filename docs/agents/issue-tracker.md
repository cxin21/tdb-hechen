# Issue tracker — GitHub Issues

- **后端**：GitHub Issues（2026-10-05 初始化拍板，用户确认）
- **仓库**：`cxin21/tdb-hechen`（git remote `origin` = `git@github.com:cxin21/tdb-hechen.git`）
- **CLI**：`gh`（已以 `cxin21` 登录）：`gh issue create / list / view / close`、`gh label list / create`
- **消费方技能**：`to-tickets`、`to-spec`、deck 插件（`deck_issue_*` / `deck_map_*`）——建整张地图骨架用 `deck_map_plan_create`，补父子/blocked-by 边用 `deck_map_link`，单票走 `deck_issue_create / patch / get / list`
- **PRs as a request surface**：`false`（默认关；若要把外部 PR 纳入 triage 队列，把此开关改为 `true`）

## 约定

- 票号即唯一标识；标题一行，正文写清验收标准与证据要求
- 标签词汇见 [triage-labels.md](./triage-labels.md)；打标签严格遵循各技能自身规则，不额外强制任何标签
