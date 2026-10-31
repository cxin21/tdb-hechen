# 装桌面之前的一次性预飞（e2e-preflight.mjs）

一句话：一条命令建**一次性 profile**（绝不碰 desktop）→ 装真插件 → 真身份 + 真 8420 起一轮 headless 会话 → `scan-session-evidence.mjs --strict` 扫段/工具 → 出报告 → 删 profile。全绿（exit 0）才值得进发布门禁。

## 用法

```bash
cd /d/TDB/td-agemem
node dsh-plugin/scripts/e2e-preflight.mjs --identity team-xxxx,agt-xxxx,usr-xxxx
```

身份也可用 `TDB_TEAM_ID/TDB_AGENT_ID/TDB_USER_ID`。开关：`--keep`（保留一次性 profile）、`--writeback`（默认 `writeback.enabled: false`，预飞不往生产 L0 写测试数据）、`--no-logs`（不挂 console logger overlay）、`--prompt <text>`、`--core-url/--core-key`（默认 `http://127.0.0.1:8420` + credentials 的 `TDAI_GATEWAY_APIKEY`）、`--extra-patch <file>`、`--timeout <ms>`。退出码：`0` 全绿 / `1` 段证据不全（MISSING 非空）/ `2` 前置检查或会话失败。

## 七步与判据

1. 前置：dist 不旧于 `src/**/*.ts`（旧了 exit 2，**先 `cd dsh-plugin && npm run build`**）、dsh CLI、身份、两个凭据 key、核心 `/health`（**非致命**）。
2. 建 `~/.dsh/profiles/agemem-preflight-<ts>`，`FORBIDDEN_PROFILES = {desktop, web, tui}` 兜底拒绝。
3. `deploy.sh --skip-tests --no-store-key`：patch 里**只写 `apiKeyRef:`**，明文 key 只经子进程 env 传。
4. 真会话：`headless --json --patch scripts/preflight/llm-scm.yml`（+logger.yml），从 stdout 抠 `sessionId`。
5. 扫描器 `--session <id> --strict`，原始输出整段打印（报告里贴的就是它），并紧跟两行口径警告（见下）。
6. 汇总三段 MISSING。
7. `finally` 删 profile 与临时 patch，写报告。

## 读数的两端口径（别当绿灯用）

- **工具行 `[PASS]` = registered（注册成功）**：schema 被宿主接受、名字进了模型可见的工具表。**不等于 served**——核心宕机 / 身份失效 / 端点 404 时这些工具照旧 `[PASS]`，但调用必然失败。served 要另跑一轮带真调用的读数为证。
- **head 段缺失时的「系统提示全长 N chars」是降级读数**（persona/core 取不到，只剩内置段），不是 head pack 的真实长度；真机 head pack 在 4939–8437 字符区间（随技能/知识段增长还会更高）。

## PASS 行样例（形态示意，数字以实跑为准）

```
   [PASS] dist 不旧于源码（2026-10-31T19:18:42）
   [PASS] core http://127.0.0.1:8420 /health 200 {"status":"ok"}
   [PASS] sessionId=session-<uuid>（23s，exit 0）
    [PASS] core_memory         1234 chars
    [PASS] memory_recall           1 次
   [PASS] 扫描器 exit 0：三段齐全
```

证据落点：`scratch/preflight-<stamp>/` 的 `report.md`（全流程）、`run.jsonl`（子进程原始 JSONL）、`run.err`、`scan.txt`；会话归档留在 `~/.dsh/sessions`，报告里的 `session-<uuid>` 可直接重扫。

## 已知限制

- **headless 禁 credentials 工具**：脚本自己读 `~/.dsh/.credentials.yaml`（只用 `credentials-util.mjs` 取值，只打印前 6 位与后 4 位），把值塞进子进程 env；patch 里永远只有 ref 名。
- **模型端点写死在 `scripts/preflight/llm-scm.yml`**（SCM 路由），换机器/换 provider 要改它；不挂它 headless 默认 provider 要 `DEEPSEEK_API_KEY` 而失败。
- 核心不通时 head/volatile 必然全 `[none]`（脚本会打印提示）——**这种读数只证明脚本可用，不能当发布读数**；宿主层 `dsh-superpowers` 模块缺失警告是噪音，与本插件无关。

## 本次实跑（2026-11-01 03:34，8420 宕机）

EXIT=1；`session-4d50bdf5-6b36-485a-bc78-cbd452ed8b28`（headless exit 0）；`head` 3,496 chars 里只有 `scene_index 252 chars`（降级读数）；`volatile` 0 次；工具 registered=`memory_recall/skill_search/knowledge_search` 各 1 次 `[PASS]`、**served=未知（核心宕机）**；`MISSING: head=[core_memory,cloud_skills,knowledge_tools] volatile=[soul_identity,relevant_memories] tools=[skill_view,skill_files_read,skill_create,skill_update,skill_patch,skill_delete,skill_files_write,skill_files_remove,knowledge_read]`。报告 `scratch/preflight-20261031192137/report.md`。desktop patch 跑前跑后同 md5 `abf630b7…`、6011B、mtime `2026-11-01 00:29:34` 未动。
