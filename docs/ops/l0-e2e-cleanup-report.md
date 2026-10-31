# e2e 取证行清理报告（17 → 0）

两次一次性 e2e（profile `agemem-e2e` / `agemem-e2e2`）用真实身份（team-2k12lgb650 / agt-2m7buribzz / usr-2m7b1144d9）写进 `D:/TDB/data/vectors.db` 的 17 行取证，按 Lead 清单逐行删除。

- 方式：**只走 `POST /v3/conversation/delete`**（journal 留痕），未直连 sqlite 写；所有 sqlite 访问均为 readOnly。
- 头：`authorization: Bearer <64c gateway key>` + `x-tdai-service-id: default` + team/agent/user（另带该行 session）。首测缺 service-id 得 `401 Missing x-tdai-service-id header`，补齐后探测不存在 id 得 `200 / deleted_count:0`（端点存在、不误删）。
- 留档（删除前）：`scratch/e2e/evidence/l0-rows-2026-11-01-full.txt`（12814B，17 行完整正文+rowid/record_id/session/三轴/role/timestamp/chars）；响应原文 `l0-delete-responses.txt`、`l0-delete-preflight.txt`。
- 请求 body 均为 `{"message_ids":["<record_id>"]}`，按 record_id 精确删（非 session 级、非通配）。

| rowid | role | chars | session(前缀) | status/deleted | request_id |
|---|---|---|---|---|---|
| 13258 | user | 17 | `788f3848` | 200 / 1 | `fdb7535440df416d` |
| 13259 | assistant | 1086 | `788f3848` | 200 / 1 | `8a505b6de1db48af` |
| 13260 | user | 17 | `834ccf55` | 200 / 1 | `d1f4ca9de6b44695` |
| 13261 | assistant | 1613 | `834ccf55` | 200 / 1 | `0d170d36845b4308` |
| 13299 | user | 26 | `745d06d9` | 200 / 1 | `0ec545e4a17841df` |
| 13302 | user | 26 | `41fdc1b4` | 200 / 1 | `de3eaf97e9f0471e` |
| 13303 | assistant | 206 | `41fdc1b4` | 200 / 1 | `804e35ee1d314569` |
| 13306 | user | 15 | `156493ad` | 200 / 1 | `5e865458e547478a` |
| 13307 | assistant | 2 | `156493ad` | 200 / 1 | `dd56d7805e1d40df` |
| 13308 | user | 26 | `54968049` | 200 / 1 | `479b6a3f5e1e4bc6` |
| 13309 | assistant | 171 | `54968049` | 200 / 1 | `98e8168c813340c2` |
| 13310 | user | 21 | `54968049` | 200 / 1 | `261894abb2c942df` |
| 13311 | assistant | 74 | `54968049` | 200 / 1 | `3458d3119cc34cc5` |
| 13312 | user | 26 | `19a1c046` | 200 / 1 | `c84d2acde1694240` |
| 13313 | assistant | 153 | `19a1c046` | 200 / 1 | `f5b2742f11364145` |
| 13314 | user | 26 | `f8dc723c` | 200 / 1 | `996fa42d29a74b73` |
| 13315 | assistant | 226 | `f8dc723c` | 200 / 1 | `6fb836b34d234b2f` |

17/17 = `200 / code=0 / deleted_count=1`，fail=0。

## 删前 / 删后

- 删前：17 个 rowid 全命中（快照缺失 0）。
- 删后：`SELECT COUNT(*) FROM l0_conversations WHERE rowid IN (…17 个…)` = **0**；按 record_id 复查 l0_conversations=0、l0_fts=0、l0_vec=0（vec 用 sqlite-vec 扩展只读加载核对）。→ **删前 17 / 删后 0**，含 FTS/向量残留。
- 清单外疑似行：这 8 个 session 删后 remaining 全为 0，无清单外行；未按时间窗通配扫其他 session。

## 结论

这 17 行是插件 e2e 取证产物（headless 会话原文+模型回答），**非用户真实记忆**；已精确删除并保留删除前全文，核心库回到 e2e 前状态。8420 实例未重启。
