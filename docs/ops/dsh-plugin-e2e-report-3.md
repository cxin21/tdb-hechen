# dsh 原生记忆插件 · 轻量真机 smoke（task-44）

目的：只验 task-43 改动的两处真机行为（ready 行 ms 原值、head pack 不再误报），顺带记一次 2500ms 预算下的 recall 读数；`writeback.enabled: false` 保证**零写入**，不需要清库。

## 1 环境

| 项 | 值 |
| --- | --- |
| 隔离 profile | `agemem-e2e3`，现建（`dsh.cmd agemem-e2e3 --from-default-profile headless --dump-config`），测后整目录删除 |
| 部署 | `cd dsh-plugin && DSH_PROFILE=agemem-e2e3 bash scripts/deploy.sh --skip-tests --identity <team-id>,<agent-id>,<user-id> --config-extra D:/TDB/td-agemem/scratch/e2e2/cfg-no-writeback.yml`（stamp `20261031-224206`，`dump-config` 含 `- id: tdb-agemem-dsh`） |
| 关写回 | config-extra 只有两键：`writeback.enabled: false`、`debug: true`；volatile / headPack 全走缺省 |
| 运行 | `E2E_PROFILE=agemem-e2e3 bash scratch/e2e2/run.sh scratch/e2e2/run9.json scratch/e2e2/run9.err --json '用一句话说明你知道我的项目在做什么'`（**1 次** headless，exit 0） |
| 会话 | `session-31dcfc15-fff1-4f3b-8203-91b43d829649`，证据 `scratch/e2e2/run9.{json,err}` |

## 2 四条证据

| # | 断言 | 实测 | 结论 |
| --- | --- | --- | --- |
| ① | ready 行四个时间预算都是 ms 原值，不得出现 `recallTimeout=2s` | `recallTimeout=2500ms,volatileTimeout=3000ms,headPackTimeout=10000ms,requestTimeout=10000ms`；同一行 `identity=configured, keySource=config, headPack=on,volatile=recall,writeback=off,skillFeed=off,tools=on, debug=on`；`recallTimeout=2s` 命中 0 | **PASS** |
| ② | head pack 仍 14 行且无截断，stderr 不再出现 `no parseable scene index` | system/message **8437 字符 / 14 行** `- \S+（热度 N，更新 YYYY-MM-DD）`：首 `- scene_blocks/AI-工程纪律-TDD与交付规范.md（热度 356，更新 2026-10-29）`，末 `- scene_blocks/TDB-灵魂注入呈现层翻修.md（热度 10，更新 2026-10-29）`；无 `truncated`、无 `Summary:`；stderr 该 warn 命中 **0** | **PASS** |
| ③ | volatile 由 `/v3/recall` 供料，2500 预算下不降级 | debug `<T> volatile block ready {"recallMs":2026,"cacheHit":false,"prefetched":false,"source":"recall","injectedChars":863,"entriesKept":4}`；注入块 1 条消息（id `agemem-volatile-1`、`source.kind=plugin:tdb-agemem-dsh`），4 条全以 `- [` 开头，长度 135 / 182 / 229 / 261（均 ≤360，无半条） | **PASS** |
| ④ | 零写入：L0 该 session 0 行、skill buffer 无该 session 目录、outbox 无新死信 | `query-l0.mjs 31dcfc15` → `rows: 0`、`injection leakage rows: 0`；`find /d/TDB/data/skill_buffer -name '*31dcfc15*'` 0 命中；`~/.dsh/agemem/outbox.jsonl` **0 字节**，`outbox.dead.jsonl` 仍 **2 行**且 mtime `22:24:23`（早于本轮 22:43） | **PASS** |

四条全 PASS，无 FAIL，未改任何代码。

## 3 读数与观察

- `recallMs: 2026` 落在 task-43 定档的常态区间（1250–2255ms），2500ms 预算下既没超时也没降级，`source` 仍是 `recall` 而非 `atomic` —— 「砍到 1500 会更慢」的判断在真机再次成立。
- 反例（`prefetched:false`）与 task-31 一致：本宿主 user/message 派发在 pre-step 之后，本轮必然 miss，属正常现象，未计入预算。
- 误导日志（每次 mount 都报 `no parseable scene index; falling back to bare truncation`）本轮 0 次，而 head pack 仍是完整 14 行 —— task-43 的 C 项修复在真机成立。
- 环境事实（非缺陷）：① headless 组合没有 tools 服务 ⇒ 每次运行 warn `agemem: tools service unavailable; memory_recall not registered`；② `superpowers (…profiles/node_modules/dsh-superpowers/lib/index.mjs): failed to import ERR_MODULE_NOT_FOUND` 来自 `~/.dsh/cordis.patch.yml` 里更早的 insert，与本插件无关。
- 死信文件里的 2 条是 22:24 那次 401 实验遗留（`l0` + `skill`，`reasonClass: auth`），本轮未新增，也未清理（零删除红线）。
- 附带读数（不属本票验证范围）：本轮 usage `inputTokens=75 / outputTokens=331 / totalTokens=10646（cacheRead 10240）`。

## 4 清理核验

- `cd dsh-plugin && DSH_PROFILE=agemem-e2e3 bash scripts/rollback.sh` → `verified: composition no longer contains tdb-agemem-dsh`；对应 patch 文件恢复为「注释 + `[]`」（`patch-util.mjs` 的 `restoreArraySeed` 在新 profile 上再次生效）。
- `rm -rf ~/.dsh/profiles/agemem-e2e3` → `ls -d ~/.dsh/profiles/*agemem*` 无输出。
- 删除 `dsh-plugin/.deploy/20261031-224206`（含**明文 core key** 的 `dump-config.yml`）与 `.deploy/last`。
- `scratch/e2e2/` 全目录扫 64 位十六进制串：0 命中（`run.sh` 仍在脚本内部从 `~/.dsh/.credentials.yaml` 读 SCM key，不进命令行）。
- **desktop 三处断言**：`~/.dsh/profiles/desktop/package.json` 对 `tdb-agemem-dsh` 命中 0、`cordis.patch.yml` 命中 0、`node_modules/@tdb` 不存在。desktop 全程未重启、未改动。

## 5 复现命令

    dsh.cmd agemem-e2e3 --from-default-profile headless --dump-config
    cd dsh-plugin && DSH_PROFILE=agemem-e2e3 bash scripts/deploy.sh --skip-tests --identity <team-id>,<agent-id>,<user-id> \
      --config-extra D:/TDB/td-agemem/scratch/e2e2/cfg-no-writeback.yml
    E2E_PROFILE=agemem-e3 …  # 见下：run.sh 已参数化
    E2E_PROFILE=agemem-e2e3 bash scratch/e2e2/run.sh scratch/e2e2/run9.json scratch/e2e2/run9.err --json '用一句话说明你知道我的项目在做什么'
    node scratch/e2e/decode-session.mjs ~/.dsh/sessions/--D-TDB-td-agemem--/<sid>/session.v4.jsonl.zstd /tmp/<sid>.jsonl
    node scratch/e2e2/inspect-headpack.mjs /tmp/<sid>.jsonl      # head pack 行数与截断
    node scratch/e2e2/dump-volatile.mjs /tmp/<sid>.jsonl         # 注入块条目与长度
    node scratch/e2e/query-l0.mjs <sid-frag>                     # L0 行数 / 注入泄漏
    cd dsh-plugin && DSH_PROFILE=agemem-e2e3 bash scripts/rollback.sh && rm -rf ~/.dsh/profiles/agemem-e2e3

脚本改动：`scratch/e2e2/run.sh` 的 profile 改为 `E2E_PROFILE`（缺省仍是 `agemem-e2e2`，报告-2 的命令不受影响）；新增 `cfg-no-writeback.yml`、`inspect-headpack.mjs`、`show-answer.mjs` 三个取证文件。未 `git commit`。
