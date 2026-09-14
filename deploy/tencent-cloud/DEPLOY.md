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

## 4. 配置落盘（/opt/tdai/etc/）

```bash
sudo cp deploy/tencent-cloud/config/core/tdai-gateway.cloud.yaml /opt/tdai/td-agemem/MemoryCore/tdai-gateway.yaml
sudo cp deploy/tencent-cloud/systemd/*.service /etc/systemd/system/
```

- **密钥文件** `/opt/tdai/etc/env`（systemd EnvironmentFile，chmod 600）：

```bash
TDAI_GATEWAY_API_KEY=<openssl rand -hex 32>     # core/proxy/panel 三处同源
TDAI_LLM_API_KEY=<ark key>
PROXY_ADMIN_API_KEY=<openssl rand -hex 32>
```

- **core**：`tdai-gateway.cloud.yaml` 已含 `${TDAI_GATEWAY_API_KEY}`/`${TDAI_LLM_API_KEY}` 占位（本地生产 yaml 派生，全部增值配置随行：场景治理/合并召回/字典序开关）。
- **proxy**：`cp 本地 MemoryProxy/config.yaml → /opt/tdai/etc/proxy-config.yaml`，按同目录 `CLOUD-DIFF.md` 改 6 处（endpoint 指向 core、密钥替换、admin key）。
- **knowledge**：`cp deploy/tencent-cloud/config/knowledge/.env.cloud.template /opt/tdai/td-agemem/MemoryKnowledge/.env`（LLM_MODE=custom 直连 ark）。
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
```

空库 bootstrap 自动完成（SQLite 建表 / scene_blocks / persona 空骨架）——首次对话后 L0→L1 流水线开始积累。

## 8. wiki 注册（Knowledge 上有内容的前提）

Panel（SSH 隧道 `ssh -L 8123:127.0.0.1:8123 <server>`）→ 知识源管理 → 注册 wiki 的 **git 源**（服务器需可达该 git 仓库，配只读 deploy key）→ 触发 ingest。不注册 = wiki 召回空转（降级安全，不报错）。

## 9. 异地 agent 接入

- dsh 型会话代理：skill-bridge / memory-bridge / knowledge 地址指向 `https://<域名>`，鉴权头按租户 auth 配置发放；
- Hermes v2 插件 / SDK 型：`TDAI_MEMORY_ENDPOINT=https://<域名>` + `TDAI_MEMORY_API_KEY`（README.deployment §v2 插件）。

## 10. 备份与升级

- **备份**（数据全在 `/opt/tdai/data` + 各 dataDir）：cron `tar` 打包 /opt/tdai/data → 腾讯云 COS 或异地；SQLite 建议停写快照（`systemctl stop tdai-core` → 打包 → start，秒级）。
- **升级**：`git pull` → 变更目录 `pnpm install` → `systemctl restart <受影响服务>`；排序/召回语义变更后按漂移协议重锚（README ×4 节）。
- **回滚**：git checkout 上一 tag + restart；数据卷不受代码回滚影响（schema 兼容以 CHANGELOG 升级须知为准）。

---

## 附：Docker 备选

`docker-compose.yml`（四容器 + Caddy，官方生产镜像构建链）保留在同目录，作为需要容器隔离/镜像化交付时的备选——操作见其文件头注释，配置模板与本手册通用。
