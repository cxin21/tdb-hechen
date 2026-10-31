<div align="center">

# TDB · TencentDB Agent Memory（hechen 定制版）

**一套可本地直跑的四服务记忆系统 + 一个直接挂进 DeepSeek Harness 的原生记忆插件（`@tdb/agemem-dsh`）**

基于腾讯开源 [TencentCloud/TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) v2.0.1 深度定制 ·
原仓库 [English](./docs/upstream/README.en.md) · [上游原始中文文档](./README_CN.md) · [改动清单](./CHANGELOG.md)

</div>

---

## 1. 这个仓库现在是什么

三条并存的形态，按你手上有什么选一条：

| 形态 | 你得到什么 | 入口 |
|---|---|---|
| **A. DSH 原生记忆插件（推荐）** | 在 DeepSeek Harness 的会话里直接带记忆：系统段注入人格/场景/技能、每轮注入相关记忆、两条写回（L0 事实链 + L2 场景链） | [§4](#4-dsh-原生记忆插件深度集成推荐形态) · [`dsh-plugin/README.md`](./dsh-plugin/README.md) |
| **B. 本机四服务直跑（Windows）** | `:8420` 核心 / `:8096` 注入管线 / `:8421` 知识服务 / `:8123` 管控台，一套脚本拉起，数据落 SQLite | [§3](#3-快速开始windows-本机四服务) · [`INSTALL_CN.md`](./INSTALL_CN.md) |
| **C. 腾讯云部署** | systemd 四服务 + Caddy + 占位符派生生产配置 | [`deploy/tencent-cloud/DEPLOY.md`](./deploy/tencent-cloud/DEPLOY.md) |

> 形态 A 不代理 LLM：插件挂在宿主自己的钩子上，只从本机核心读写记忆。模型仍然是你配的那个模型。

## 2. 组件与端口

| 组件 | 端口 | 进程形态 | 职责 |
|---|---|---|---|
| **MemoryCore** | `8420` | `node --import tsx src/gateway/server.ts` | 记忆核心：L0–L3 记忆、召回 `/v3/recall`、写入 `/v3/conversation/add`、技能 `/v3/skill/*`、场景 `/v3/scenario/ls`、人格槽 `/v3/core-memory/read`、元数据与租户隔离 |
| **MemoryProxy** | `8096` | `node --import tsx/esm src/index.ts --config <runtime.yaml>` | 老一代注入管线：12 个注入器、多客户端适配。DSH 路径已不依赖它（插件直连核心），保留给其它客户端 |
| **MemoryKnowledge** | `8421` | `node --import tsx src/server.ts` | 知识服务：wiki / code-graph 摄取与检索、`/tools/call` |
| **MemoryPanel** | `8123` | `node --import tsx src/...` + `web/` | 管控台：用户/团队/Agent/知识源管理；**也是唯一能事后审计召回的地方**（recall journal 落在 `D:/TDB/data/logs/recall/`） |
| **dsh-plugin** | — | DSH 宿主内（Cordis 插件） | 宿主侧原生记忆：三段注入面 + 两条写回链 + 原生工具（`memory_recall` / `skill_*` / `knowledge_*`） |

四服务都提供 `/health`，就绪判据统一为 `GET /health == 200`。

## 3. 快速开始（Windows 本机四服务）

**前置**：Node **≥ 22.16**（`MemoryCore/package.json` 的 `engines`）、pnpm、PowerShell 7。

```powershell
# 1) 密钥只放这一处，永不入库、永不 echo
#    D:\TDB\etc\env.ps1  ← 模板见 config/templates/env.ps1
# 2) 拉起四服务（顺序 core → proxy → knowledge → panel，每个都等 /health）
pwsh -NoProfile -File D:\TDB\etc\start-tdb.ps1

# 3) 冒烟
curl.exe -s -o NUL -w "%{http_code}\n" http://127.0.0.1:8420/health   # 200
# 管控台
start http://127.0.0.1:8123
```

- DSH 在跑时，由 `dsh-tdb-lifecycle` bundle 改用 `D:/TDB/etc/start-tdb-supervised.ps1` 托管进程（DSH 退出时一并停）。
- 代理配置里的 `${VAR}` 由 `etc/tdb-services.common.ps1` 的 `New-TdbRuntimeConfig` 展开成**临时**运行时副本（`D:/TDB/data/run/`），健康后立即删除——密钥不会落第二份持久文件。
- 只跑核心也能满足插件形态 A：`8420` 起来即可。

## 4. DSH 原生记忆插件（深度集成，推荐形态）

`@tdb/agemem-dsh` 挂在宿主的三个点上，全部能力都能单独关：

| 注入面 | 宿主挂点 | 内容 |
|---|---|---|
| **head pack**（一次/会话，compaction 后重注） | `ctx.systemPrompt.section` | `<core_memory>` 人格与严格规则 → 场景索引（L2）→ `<available_skills>` → `<knowledge_tools>` |
| **volatile**（每轮） | 预步骤追加一条 `user/message` | `<soul-identity>` + `<soul-feeling>` + `<relevant-memories>`（来自 `/v3/recall`）+ `<team-wiki>` |
| **tools** | 宿主原生工具注册 | `memory_recall`、`skill_search`/`skill_view`/`skill_files_read`/`skill_extract`、`knowledge_search`/`knowledge_read`（写工具 6 个在 `skill.allowLlmWrite` 开启后注册） |

写回两条链，缺一条就有一半记忆不长：

| 链 | 端点 | 产物 |
|---|---|---|
| L0 | `POST /v3/conversation/add` | 逐轮原文 → L1 事实抽取 |
| L2 | `POST /v3/skill/conversation/add` | 缓冲累积到阈值 → 归档 → 场景抽取 → `scene_blocks` |

```bash
# 构建 + 装进指定 profile（身份三轴必填，否则插件挂上但 inert）
cd dsh-plugin && npm ci && npm run build
bash scripts/deploy.sh --identity <team>,<agent>,<user> --base-url http://127.0.0.1:8420

# 装完重启宿主，然后取证（读会话归档，不需要宿主内部接口）
node scripts/verify-installed.mjs
bash scripts/rollback.sh          # 回滚到上一次部署前的备份
```

一切配置都在宿主 profile 的 `cordis.patch.yml` 的 `config:` 块里——**整块替换、不深合并**，所以漏一个键就回落代码缺省。全量键见 [`config/templates/dsh-plugin.yaml`](./config/templates/dsh-plugin.yaml)。

细节（能力矩阵、已知边界、排他用法）：[`dsh-plugin/README.md`](./dsh-plugin/README.md)、[`docs/ops/all-on-capability-matrix.md`](./docs/ops/all-on-capability-matrix.md)。

## 5. 配置

**每个服务一份全量、逐键注释的模板**——这是本文档里唯一需要你照抄的东西：

| 服务 | 模板 | 机器清单 |
|---|---|---|
| MemoryCore | [`config/templates/memorycore.yaml`](./config/templates/memorycore.yaml) | `memorycore.keys.json` |
| MemoryProxy | [`config/templates/memoryproxy.yaml`](./config/templates/memoryproxy.yaml) | `memoryproxy.keys.json` |
| MemoryKnowledge | [`config/templates/memoryknowledge.yaml`](./config/templates/memoryknowledge.yaml) | `memoryknowledge.keys.json` |
| MemoryPanel | [`config/templates/memorypanel.yaml`](./config/templates/memorypanel.yaml) | `memorypanel.keys.json` |
| dsh-plugin | [`config/templates/dsh-plugin.yaml`](./config/templates/dsh-plugin.yaml) | `dsh-plugin.keys.json` |
| 密钥（本机） | [`config/templates/env.ps1`](./config/templates/env.ps1) | — |

格式契约在 [`config/SPEC.md`](./config/SPEC.md)：每个键必须带 **类型 / 源码缺省值 / 一句话作用 / 源码行号**，机器清单与模板双向对齐，改一个键不注释就会被 `node scripts/check-config-templates.mjs` 打回。

**优先级链**（四服务同构）：

```
env.ps1 / 进程环境变量  >  {dataDir}/config-override.json（管控台写入）  >  yaml  >  代码缺省
```

三个最容易配错的地方：

1. **`0` 是"关"，删键是"开"**。`graphDiscount` / `sceneBoost` / `coreRefBoost` 这类通道权重，写 `0` 才是关闭；把键删掉会回落缺省值、把通道重新打开。
2. **未知枚举会翻成最严档**。例如 `requireTeamOwnership` 拼错 → `enforce`（403），`unknownPrincipalPolicy` 拼错同理。宁可留空让它走缺省。
3. **密钥只认一处**。LLM 密钥运行时唯一可信源是 `{dataDir}/config-override.json`（管控台写入），其次 yaml，最后才是 `TDAI_LLM_*` env（deprecated）；占位符整串（`__X__` / `${X}`）视为未设置。

## 6. 测试与门禁

```bash
cd MemoryCore      && npx vitest run          # 核心：召回/写入/抽取/网关
cd MemoryProxy     && npx vitest run
cd MemoryKnowledge && npx vitest run
cd MemoryPanel     && npx vitest run
cd dsh-plugin      && npx vitest run && npx tsc --noEmit && npm run build

# 核心类型门禁：与基线逐文件逐错误码比对，多一个就红
cd MemoryCore && node scripts/typecheck-gate.mjs
# 文档索引双向校验（未索引 / 悬空链接）
node docs/ops/scripts/check-ops-index.mjs
# 配置模板 ↔ 源码双向校验
node scripts/check-config-templates.mjs
```

纪律：**任何召回/排序类改动都必须带同语料 A/B 与裁决记录**，降精度即关断（见 `CONTEXT.md` 与 `docs/adr/`）。

## 7. 文档地图

| 想去哪 | 去哪 |
|---|---|
| 域词典（价值锚 / 严格规则 / 事实行 / 软失效 / 属性基数…） | [`CONTEXT.md`](./CONTEXT.md) |
| 架构决定（ADR-0001 … 0018） | [`docs/adr/`](./docs/adr/) |
| 运维与取证台账（69 份，带索引校验） | [`docs/ops/README.md`](./docs/ops/README.md) |
| 生产配置口径与回滚 | [`docs/ops/production-profile.md`](./docs/ops/production-profile.md) |
| 插件能力矩阵 / parity 对照 | [`docs/ops/all-on-capability-matrix.md`](./docs/ops/all-on-capability-matrix.md)、[`docs/ops/proxy-parity-matrix.md`](./docs/ops/proxy-parity-matrix.md) |
| 插件发布与验收 checklist | [`docs/ops/dsh-plugin-release-checklist.md`](./docs/ops/dsh-plugin-release-checklist.md) |
| 跨机部署（HTTP 直连 + userkey 身份流） | [`docs/ops/cross-host-deployment.md`](./docs/ops/cross-host-deployment.md) |
| 改动清单 | [`CHANGELOG.md`](./CHANGELOG.md) |

## 8. 与上游的关系

- 基线：上游 tag `v2.0.1`。本仓库的定制全部登记在 `CHANGELOG.md` 的 `[Unreleased]` 段，每项带设计文档编号。
- 同步边界见 [ADR-0018](./docs/adr/0018-上游同步边界.md)：召回/排序语义一旦变更必须重锚 golden 语料，不允许直接 merge 上游。
- 不入库清单：含真实密钥的运行时配置（`tdai-gateway*.yaml`、`MemoryPanel/config/metadata-instances.json`）、本地取证产物（`scratch/`）、评估产物 `runs/` 均已在 `.gitignore` 排除；模板从 `config/templates/` 派生。

## License

跟随原仓库 [MIT License](./LICENSE)。上游版权与商标归腾讯 / TencentCloud 所有；本 fork 的定制部分同样以 MIT 提供。
