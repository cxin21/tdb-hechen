# 腾讯云部署手册 · td-agemem 全模块原生直跑版

> 形态：源码上服务器 → systemd 四服务直跑（与本地开发形态一致，改码重启即生效）。
> 数据：云端全新空库，**不与本地同步**（用户拍板）。
> Docker Compose 版保留在同目录 `docker-compose.yml` 作为备选（本手册不含其操作）。

---

## 0. 前提与安全边界

| 项 | 值/要求 |
|---|---|
| 服务器 | Linux x86_64（Ubuntu 22.04/24.04 实测路径），1C2G 起步（建议 2C4G，LLM 提取吃内存） |
| 腾讯云安全组 | 只放行 **22 (SSH) + 80 + 443**；8420/8096/8421/8123 一律不放行 |
| 公网入口 | Caddy 反代 443 → Proxy 8096（agent 唯一入口）；Panel 只走 SSH 隧道 |
| 鉴权 | 租户级 auth（x-tdai-user-key → core 校验）已启用 + 网关 Bearer 必填 + 运维口 admin key 强制开启 |
| 出网 | ark embedding/LLM API（volces.com 公网可达 ✓） |

四服务职责：core 8420 记忆核心 ｜ proxy 8096 注入管线（fork 增值主战场）｜ knowledge 8421 wiki/code-graph ｜ panel 8123 TMC 管控台（wiki 注册入口）。

---

## 1. 系统初始化（一次性）

```bash
sudo bash deploy/tencent-cloud/native/init-server.sh
```

装齐：编译工具链（better-sqlite3/node-pty 需要）+ Node 22 + pnpm + Caddy + `tdai` 运行用户 + /opt/tdai 目录骨架。

## 2. 拉代码

```bash
# 服务器生成 deploy key → git.yyrd.com 添加只读 deploy key（私有仓库）
sudo -u tdai ssh-keygen -t ed25519 -f /opt/tdai/.ssh/id_ed25519 -N ''
sudo -u tdai cat /opt/tdai/.ssh/id_ed25519.pub
sudo -u tdai git clone git@git.yyrd.com:hechenk/tdb-hechen.git /opt/tdai/td-agemem
```

> 服务器构建用 fork 源码 = 全部增值能力（字典序 / R7 分层 / 场景治理 / 合并召回 / 塌方线）随码上线。

## 3. 依赖安装（四目录）

```bash
cd /opt/tdai/td-agemem
for d in MemoryCore MemoryProxy MemoryKnowledge MemoryPanel; do
  sudo -u tdai bash -c "cd /opt/tdai/td-agemem/$d && pnpm install --no-frozen-lockfile"
done
```

### 3.1 Panel 前端构建（不能跳过）

`MemoryPanel/web/dist` 是前端静态产物，且**不进 git**（见 `MemoryPanel/web/.gitignore`）。tdai-panel 的后端是 `node --import tsx src/index.ts` 直跑 TS 源码（pull + 重启即生效），但**页面来自 dist**：只 pull 不构建，UI 就停在上一次构建的版本。

> 2026-10 事故：dist 停在 10-02，10-16 的「Rerank 拆独立页签」(af95dac) 在线上完全看不到，被误判成"admin 设置里的 rerank 配置项消失了"。排查手段：`ls -l MemoryPanel/web/dist/assets` 的时间戳 vs `git log -1 --format=%ad -- MemoryPanel/web/src`。

```bash
sudo bash deploy/tencent-cloud/native/rebuild-panel-web.sh
# 等价于：cd MemoryPanel/web && pnpm install --no-frozen-lockfile && pnpm build（tsc && vite build）
```

构建产物经脚本自检（dist/index.html 存在 + 其引用的 main-*.js 存在）。前端改动后：重跑本脚本 → 浏览器 **Ctrl+Shift+R**（旧 index.html/main-*.js 有缓存）；tdai-panel 无需重启。

## 4. 配置落盘（/opt/tdai/etc/）

```bash
sudo cp deploy/tencent-cloud/config/core/tdai-gateway.cloud.yaml /opt/tdai/td-agemem/MemoryCore/tdai-gateway.yaml
sudo cp deploy/tencent-cloud/systemd/*.service /etc/systemd/system/
```

- **密钥文件** `/opt/tdai/etc/env`（systemd EnvironmentFile，chmod 600）：

```bash
TDAI_GATEWAY_API_KEY=<openssl rand -hex 32>      # core/proxy/panel 三处同源
TDAI_GATEWAY_APIKEY=<同上>                       # 主用名（无下划线）；_KEY 为兼容别名，建议两者都写
TDAI_DATA_DIR=/data/tdai-memory                  # 必填：core dataDir 单一真源 + Panel 召回日志读面的锚点
TDAI_LLM_API_KEY=<ark key>   # deprecated（ADR-0006）：LLM 凭据 SoT = 各服务 {dataDir}/config-override.json（admin settings）；env 仅回退
TDAI_PROXY_ADMIN_API_KEY=<openssl rand -hex 32>  # proxy 运维口实际读取的名字（env > yaml admin.apiKey）
PROXY_ADMIN_API_KEY=<同上>                       # docker-compose 别名；原生 systemd 不读，写上只为对齐模板
KNOWLEDGE_SERVICE_KEY=<openssl rand -hex 24>     # KS 校验侧；tdai-knowledge 与 tdai-panel 都读本文件
KNOWLEDGE_AUTH_TOKEN=<同上>                      # Panel 调用侧，必须与上一行同值，否则 Panel 调 KS 401
```

> 两个易踩的坑：
>
> 1. **TDAI_DATA_DIR 缺了不会静默**——Panel「召回日志」页直接 503 `RECALL_JOURNAL_DIR_UNRESOLVED`（解析序：`TDAI_RECALL_JOURNAL_DIR` > `TDAI_DATA_DIR` + `/logs/recall`，见 `MemoryPanel/src/panel/http/routes/chat-memory.ts:54-68`）。
> 2. **PROXY_ADMIN_API_KEY 不是 proxy 读的变量名**——`MemoryProxy/src/config.ts:716` 只读 `TDAI_PROXY_ADMIN_API_KEY`；只写前者会让运维口 key 落成空串＝公开可访问，且启动日志不告警，只能靠 curl 验 401 发现。

- **core**：`tdai-gateway.cloud.yaml` 已含 `${TDAI_GATEWAY_API_KEY}`/`${TDAI_LLM_API_KEY}` 占位（本地生产 yaml 派生，全部增值配置随行：场景治理/合并召回/字典序开关）。

  > **解析层级铁律**（2026-10-26 审计，两条死配置踩过）：`MemoryCore/src/gateway/config.ts:488` 先取 `obj(fileConfig,"memory")` 再送 `parseMemoryConfig`，所以内核类键**相对 `memory` 段**写；灵魂/锚相关在 `memory.coreMemory.*`（不是 `memory.soulRender`）；skill 提取在**顶层** `skill.extraction.*`（与 `memory` 平级）。逐条（已对三份配置实测确认载体一致）：
  > - 场景治理 → `memory.sceneGovernance.*`（读点 `MemoryCore/src/config.ts:1701`）；写成 `memory.recall.sceneGovernance.*` 解析器从不读取 → 守卫静默全关（生产曾如此）。
  > - 场景毒化切分/批量上限 → `memory.extraction.scenePoisonSplit` / `sceneBatchMaxChars`（读点 `MemoryCore/src/config.ts:1750-1751`）；`memory.skill.extraction.*` 无解析。
  > - 召回精排 → `memory.recall.conclusionLayer.*`；其中 `textHitMaxTokenRatio` 已随 #99 F1 退役，写了被静默忽略。
  > - 灵魂渲染预算/去重/锚选择 → `memory.coreMemory.soulRender.*`（`budgetAnchorChars`、`strictRuleDedup`、`anchorDedup`、`anchorSelect.scorer`）；锚发现三门 → `memory.coreMemory.anchorDiscovery.*`。
  > - skill 提取 → `skill.extraction.{enabled,maxIterations,archiveBytes,timeoutMs,maxTokens}`（装配点 `MemoryCore/src/gateway/server.ts:2673-2688`；缺省 maxIterations 16 在 `src/core/skill/skill-config.ts:240`）。
  >
  > 改完务必用 `loadGatewayConfig()` 打生效面核对（见 §7），不要只看 YAML 文本。LLM key 的运行时唯一 SoT = 服务器 `{dataDir}/config-override.json`（ADR-0006）；env 占位展开为空不影响 override 生效。
- **proxy**：以 `deploy/tencent-cloud/config/proxy/proxy-config.cloud.example.yaml` 为起点（**不是**本地 `MemoryProxy/config.yaml`——它被 `.gitignore` 忽略、从未入库），按同目录 `CLOUD-DIFF.md` 替换 `${VAR}` 占位符（endpoint 指向 core、网关 key、admin key）。**闸门类键**（`recallQuerySource` / `l0CaptureMode` / `recallIntentDedup`）缺省会退回 legacy：落盘后必须 `sudo grep -nE 'recallQuerySource|l0CaptureMode' /opt/tdai/etc/proxy-config.yaml` 确认 2 行都在，否则一个用户消息会按模型步数重复召回。同一条命令顺带核对 `injection.soulTiming` 与 `wikiRecall.jit/querySource`（见 §7）。
- **knowledge**：`cp deploy/tencent-cloud/config/knowledge/env.cloud.template /opt/tdai/td-agemem/MemoryKnowledge/.env`（LLM_MODE=custom 直连 ark）。服务间鉴权 key 建议只写 `/opt/tdai/etc/env`（systemd env 优先于 dotenv，且 Panel 侧 `KNOWLEDGE_AUTH_TOKEN` 只能来自那里）；只填 dotenv 不填 env 文件时，KS 侧生效而 Panel 侧无 Bearer → Panel 调 KS 一律 401。
- **panel**：Panel 的 core 地址/api_key 配置按其 `config/metadata-instances.json` 格式落盘（指向 http://127.0.0.1:8420 + 同一把 gateway key）。

## 5. 启动与自启

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now tdai-core tdai-proxy tdai-knowledge tdai-panel
systemctl status tdai-* --no-pager
```

## 6. Caddy 反代（agent 公网唯一入口）

```bash
sudo cp deploy/tencent-cloud/Caddyfile.template /etc/caddy/Caddyfile
# 编辑：填 CADDY_DOMAIN（Let's Encrypt 自动签）；无域名 → 启用文件内 IP 变体 + 安全组白名单
sudo systemctl enable --now caddy
```

## 7. 验证清单

```bash
# 服务器本机
curl -s http://127.0.0.1:8420/health | grep -o '"status":"ok"'
curl -s http://127.0.0.1:8096/health
# 外部（带鉴权三元组）
curl -sX POST https://<域名>/v3/recall \
  -H 'Content-Type: application/json' -H 'x-tdai-service-id: default' \
  -H 'x-tdai-team-id: ...' -H 'x-tdai-agent-id: ...' -H 'x-tdai-user-id: ...' \
  -H 'Authorization: Bearer <TDAI_GATEWAY_API_KEY>' \
  -d '{"query":"冒烟测试","maxResults":3,"session_id":"smoke-001"}'

# 召回入口闸门生效（#83/#87）：应各有 1 行输出；缺任一行 = 每步一次召回（见 CLOUD-DIFF.md「防漂移」）
sudo grep -nE 'recallQuerySource|l0CaptureMode' /opt/tdai/etc/proxy-config.yaml
# 注入形态闸门（2026-10-26 审计）：soulTiming 必须挂在 injection 段（顶层 tdai.soulTiming 不生效）
sudo grep -nE '^  soulTiming:|^    redline:|^  jit:|^  querySource:|minStructuralTailNormScore|maxTotalChars' \
  /opt/tdai/etc/proxy-config.yaml
# core 生效面（不是 YAML 文本）：应打印 sceneGovernance / conclusionLayer / queryExpansion / budgets / selfIdentityGate
sudo -u tdai bash -lc 'set -a; . /opt/tdai/etc/env; set +a; cd /opt/tdai/td-agemem/MemoryCore && \
  TDAI_GATEWAY_CONFIG=/opt/tdai/td-agemem/MemoryCore/tdai-gateway.yaml node --import tsx /tmp/dumpcfg.ts'

# Panel 前端产物时间戳应为本次构建（不是几周前，见 §3.1）
ls -l /opt/tdai/td-agemem/MemoryPanel/web/dist/assets/main-*.js
```

空库 bootstrap 自动完成（SQLite 建表 / scene_blocks / persona 空骨架）——首次对话后 L0→L1 流水线开始积累。

## 8. wiki 注册（Knowledge 上有内容的前提）

Panel（SSH 隧道 `ssh -L 8123:127.0.0.1:8123 <server>`）→ 知识源管理 → 注册 wiki 的 **git 源**（服务器需可达该 git 仓库，配只读 deploy key）→ 触发 ingest。不注册 = wiki 召回空转（降级安全，不报错）。

## 9. 异地 agent 接入

- dsh 型会话代理：skill-bridge / memory-bridge / knowledge 地址指向 `https://<域名>`，鉴权头按租户 auth 配置发放；
- Hermes v2 插件 / SDK 型：`TDAI_MEMORY_ENDPOINT=https://<域名>` + `TDAI_MEMORY_API_KEY`（README.deployment §v2 插件）。

## 10. 备份与升级

- **备份**（数据全在 `/opt/tdai/data` + 各 dataDir）：cron `tar` 打包 /opt/tdai/data → 腾讯云 COS 或异地；SQLite 建议停写快照（`systemctl stop tdai-core` → 打包 → start，秒级）。
- **升级**：`git pull` → 变更目录 `pnpm install` → **MemoryPanel/web 有改动则必须重建前端**（`sudo bash deploy/tencent-cloud/native/rebuild-panel-web.sh`，否则页面还是旧包 + 浏览器 Ctrl+Shift+R）→ `systemctl restart <受影响服务>`；排序/召回语义变更后按漂移协议重锚（README ×4 节）。
- **回滚**：git checkout 上一 tag + restart；数据卷不受代码回滚影响（schema 兼容以 CHANGELOG 升级须知为准）。

---

## 附：Docker 备选

`docker-compose.yml`（四容器 + Caddy，官方生产镜像构建链）保留在同目录，作为需要容器隔离/镜像化交付时的备选——操作见其文件头注释，配置模板与本手册通用。
