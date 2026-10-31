# DSH 与本机 TDB（MemoryCore）分机部署：改造清单与配置口径

快照：2026-11-01（基于当前工作树，未提交）。适用对象：`dsh-plugin`（DSH 原生记忆插件）与 `MemoryCore`（TDB 记忆服务，gateway 8420）。

## 0. 结论（先看这五条）

1. **架构上已经能跨机**：插件对 TDB 的依赖只有 HTTP；没有任何本地进程、本地文件依赖。跨机真正要动的是「绑定 + 传输安全 + 身份分发 + 延迟预算 + 断网队列」。
2. **TDB 侧只有 core:8420 是必需的**。Knowledge(8421)/Panel(8123)/MemoryProxy(8096) 都不是 DSH 原生插件的依赖（插件只调 /v3/* 与 /health）。
3. **插件缺省配置是「同机假设」**：server.baseUrl 缺省 http://127.0.0.1:8420，且**运行期没有任何 env 覆盖 baseUrl 的能力**（config.ts 只对 apiKeyRef、debug 读 env）⇒ 跨机必须把 baseUrl 写进 profile patch（deploy.sh 已支持 --base-url）。
4. **最快的零改造路径是 SSH 隧道**：ssh -N -L 8420:127.0.0.1:8420 tdb-host，插件继续用 127.0.0.1:8420，core 不改绑、不暴露端口、不用配 TLS。适合个人两台机器。
5. **不能多活**：core 的存储是 sqlite 单库（memory.storeBackend 为 sqlite，技能索引同为 sqlite），两台 core 同时写同一个库会撕裂。跨机 = 一台 core（唯一主库）+ 多台 DSH 客户端。

## 1. 拓扑与端口

| 端口 | 服务 | 跨机是否必需 | 备注 |
|---|---|---|---|
| 8420 | MemoryCore gateway | 必需 | 静态 64 位 apiKey（tdai-gateway.yaml:24），缺省只监听 127.0.0.1（:19） |
| 8421 | MemoryKnowledge | 可选 | KNOWLEDGE_SERVICE_KEY 为空时自己会 warn「all /v3 endpoints are open」 |
| 8123 | MemoryPanel | 可选 | HOST 缺省 0.0.0.0，**没有内置鉴权** ⇒ 远端暴露必须套反代认证 |
| 8096 | MemoryProxy | DSH 原生插件不需要 | 同身份双喂的风险源，见 README 排他表 |

core 主机还需要**出网**：embedding 打 https://ark.cn-beijing.volces.com（tdai-gateway.yaml:366）、LLM 打 https://api.minimax.cn/v1（:33）。这两条与 DSH 在哪台机器无关，留在 core 侧。

## 2. 插件侧：需要哪些配置（逐个键）

| 键 | 同机缺省 | 跨机建议 | 为什么 |
|---|---|---|---|
| server.baseUrl | http://127.0.0.1:8420 | https://tdb.internal（反代）或 http://10.0.0.5:8420（内网直连） | 唯一决定「TDB 在哪」的键；只能写进 patch，无 env 覆盖 |
| server.apiKey / apiKeyRef | 空 / TDAI_GATEWAY_APIKEY | 跨机机器通常没有 MemoryCore/tdai-gateway.yaml，deploy.sh 自动读取会落空 ⇒ 用 --api-key 或 TDB_CORE_API_KEY 显式给，或运行期用同名 env | 读不到 key = 全线 401，且插件 fail-open（无记忆但不报错） |
| server.serviceId | default | 与 core 期望一致（x-tdai-service-id） | 缺这个头直接 401（实测原文 Missing x-tdai-service-id header） |
| server.teamId / agentId / userId | 空（inert） | 与远端库的隔离三元组一致 | 三项不全 = 插件 inert，不读不写 |
| server.requestTimeoutMs | 10000 | 跨地域 15000 | 只影响写回，不影响注入 |
| volatile.recallTimeoutMs | 2500 | 同城/VPC 保持 2500；跨地域 4000–5000 | 实测本机 recall 1250–2255ms（perfMs.l1 占 97%+，冷态 5067ms）；跨地域再加 RTT |
| volatile.timeoutMs | 3000 | 比 recallTimeout 多至少 1000 | 给 atomic 回退留时间，否则回退也被砍 |
| headPack.timeoutMs | 10000 | 15000 | 冷启动一次 5s 级 |
| writeback.maxRequestBytes | 700000 | 不变 | core 硬限 1048576；反代 client_max_body_size 必须至少 2m（nginx 缺省 1m 正好卡边界） |
| writeback.outboxPath | ~/.dsh/agemem/outbox.jsonl | 不变（留在 DSH 主机） | 断网时的本地队列，跨机后更重要 |
| paths.* | /v3/... | 仅当反代带路径前缀时改（如 /tdb/v3/recall） | 拼接是字符串拼接，前缀可行；但 core 路由是绝对路径，反代必须 rewrite 剥掉前缀，/health 同理 |

### 2.1 一份跨机 patch 样例

```yaml
- insert:
    - id: tdb-agemem-dsh
      name: ./node_modules/@tdb/agemem-dsh/dist/index.js
      config:
        server:
          baseUrl: https://tdb.internal
          serviceId: default
          teamId: team-xxxx
          agentId: agt-xxxx
          userId: usr-xxxx
          requestTimeoutMs: 15000
        volatile:
          recallTimeoutMs: 4000
          timeoutMs: 6000
        headPack:
          timeoutMs: 15000
        debug: true
```

部署命令（apiKey 显式给，脚本不再依赖本地 yaml）：

```bash
cd dsh-plugin
bash scripts/deploy.sh --profile desktop \
  --base-url=https://tdb.internal \
  --api-key=REPLACE_WITH_64_CHAR_CORE_KEY \
  --identity team-xxxx,agt-xxxx,usr-xxxx
```

## 3. 插件侧需要改的代码（按优先级）

**P0：无。** 现版本能连远端 http://，也能连 https://（走 Node 全局信任链）。

**P1**

1. server.tlsCaFile：自签/私有 CA 现在只能靠宿主进程的 NODE_EXTRA_CA_CERTS，桌面 GUI 用户设不到进程环境 ⇒ 要么拒绝该证书，要么让人关校验。建议加一个键，内部用 undici Agent({ connect: { ca } }) 注入。
2. writeback.maxOutboxEntries / maxOutboxBytes + 超限策略：Outbox 现在没有条目/字节上限（maxAttempts、retryMs、maxBackoffMs 有），长期断网会无界增长，写满盘后连死信都写不进去。
3. mount 时一次 health 探测：MemoryClient.health() 已存在但没有调用点（index.ts grep 不到 health）。跨机排障第一步就是通不通，建议 ready 行带 health=ok 或 fail(原因)，超时 3s、不阻塞、不进注入路径。
4. apiKey 凭据化（与 task-49 的 G1 同一件事）：现在 deploy.sh 把 64 位 key 明文写进 profile patch，跨机时 patch 常被复制/共享 ⇒ 改为 patch 只写 apiKeyRef，值从 DSH 凭据库解析，ready 行报 keySource=credentials。

**P2**

5. deploy.sh 跨机分支：apiKey 缺省从 ../MemoryCore/tdai-gateway.yaml 读，跨机机器上没有这个文件 ⇒ 现在会静默回落到空 key（插件 inert）。应在远端 baseUrl 加本地无 yaml 时直接报错并提示用 --api-key 或 TDB_CORE_API_KEY。
6. server.baseUrl 支持 env 覆盖（如 TDB_CORE_BASE_URL）：一机多 profile / 容器化时比改 patch 方便。deploy.sh 已读这个 env，但运行期不读。

## 4. TDB 侧需要改的

**P0**

1. 改绑：tdai-gateway.yaml:19 的 host 从 127.0.0.1 改为内网 IP（或 0.0.0.0 加防火墙只放行 DSH 主机）。该行注释自己写明了「跨机部署才需改绑+强化鉴权」。
2. 传输加密：apiKey 是静态 bearer，L0 里是用户原文 ⇒ 明文 LAN/WAN 不可接受。两种做法：nginx/caddy TLS 终止；或 SSH/WireGuard 隧道（连 TLS 都省）。
3. 反代要点：client_max_body_size 至少 2m（core 硬限 1048576）；proxy_read_timeout 至少 60s；透传 Authorization 与 x-tdai-service/team/agent/user/session 五个头；路径前缀必须 rewrite 剥离（core 路由是绝对路径）；/health 单独放行便于探测。
4. 时钟：幂等判定用服务端时钟（MemoryCore/src/core/store/sqlite.ts hasRecentL0Duplicate 用 Date.now() 比 recorded_at）⇒ 客户端时钟漂移不影响 L0 去重；L1 idle/warmup 一类窗口仍建议 NTP 对齐。
5. 数据面：vectors.db、skill buffer、reranker 模型目录、embedding 缓存在 core 本机磁盘 ⇒ 分机部署时随 core 一起备份/迁移；两台 core 不能同时写同一 sqlite。

**P1**

6. 观测：core 侧 access log 带 request_id（响应里已有）；插件侧 ready 行与首错 warn 已具备（auth/recall/write/dead-letter 各一次）。
7. 可选读面：Panel 8123 缺省 HOST=0.0.0.0 且无内置鉴权 ⇒ 远端必须套 Basic/OIDC；Knowledge 8421 必须设 KNOWLEDGE_SERVICE_KEY。
8. 多机共享 identity 的口径：同一三元组 = 共享同一份记忆与同一个 head pack（换机器接着聊，个人多机推荐）；按机分 agentId = 各自成长、互不可见（团队多设备/多租户）。

**P2**

9. 跨地域（RTT > 100ms）：关 volatile、只留 head pack；或把 core 部署到用户近侧。记忆跟着库走，不能双活，只能选一个主库。

## 5. 三种落地方案对比

| 方案 | core 改动 | 插件改动 | 安全性 | 适用 |
|---|---|---|---|---|
| A. SSH 隧道 | 无 | 无（baseUrl 仍 127.0.0.1） | 高（走 SSH） | 个人两台机器、临时联调 |
| B. 内网直连 + TLS 反代 | 改绑 host | baseUrl 改 https | 中高（需管证书） | 团队、同 VPC |
| C. 公网暴露 | 改绑 + 反代 | baseUrl 改 https | 低（静态 key + 公网） | 不推荐；若必须，上 mTLS 或 VPN |

A 的可持续性要点：autossh 或 systemd 保活；断线重连后 outbox 会继续投递（退避上限 5 分钟）。

## 6. nginx 参考片段（方案 B）

```nginx
server {
  listen 443 ssl;
  server_name tdb.internal;
  ssl_certificate     /etc/ssl/tdb.crt;
  ssl_certificate_key /etc/ssl/tdb.key;
  client_max_body_size 8m;
  location / {
    proxy_pass http://127.0.0.1:8420;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Authorization $http_authorization;
    proxy_set_header x-tdai-service-id $http_x_tdai_service_id;
    proxy_set_header x-tdai-team-id    $http_x_tdai_team_id;
    proxy_set_header x-tdai-agent-id   $http_x_tdai_agent_id;
    proxy_set_header x-tdai-user-id    $http_x_tdai_user_id;
    proxy_set_header x-tdai-session-id $http_x_tdai_session_id;
    proxy_read_timeout 60s;
    proxy_send_timeout 60s;
  }
}
```

若必须带路径前缀（https://tdb.internal/tdb/），加 location /tdb/ 且 proxy_pass 写成 http://127.0.0.1:8420/（尾部斜杠剥前缀），插件 server.baseUrl 写 https://tdb.internal/tdb。

## 7. 验收清单（跨机装完照这个跑）

1. curl -H 认证头 https://tdb.internal/health 返回 200（健康端点不需要三轴头）。
2. node dsh-plugin/scripts/verify-installed.mjs --profile desktop 返回 PASS（或 PENDING 等一轮会话）。
3. 一轮真实会话后：插件 ready 行 endpoint= 是远端地址；volatile debug 里 source=recall（不是 atomic）。
4. 远端库里出现该 session 的 L0 行（session_id 是本机宿主 UUID，用 /v3/core/read 或 sqlite 只读确认）。
5. 断网演练：断网说一轮 ⇒ ~/.dsh/agemem/outbox.jsonl 增长；恢复后 1–5 分钟内投递成功、outbox.dead.jsonl 不新增。
6. 时延：volatile debug 的 recallMs 至少看 5 轮；跨地域若 p95 超过 recallTimeout，按第 2 节调预算，别调低超时。

## 8. 落地票（待执行）

- task-50（dsh-plugin）：server.tlsCaFile、writeback 队列上限、mount health 探测进 ready 行、deploy.sh 跨机缺 key 直接报错、apiKey 凭据化（与 task-49 的 G1 合并）、README 跨机章节。
- core 侧改绑与反代属运维动作，不进代码票；若决定长期跨机，另开「core 部署配置化（host 从 env 或 override 读）」票。

## 9. 注

- 所有代码断言基于 2026-11-01 工作树；引用一律 path:line 且只引用本轮亲自读过的位置。
- 反例记录：桌面上已装的插件当前 server.baseUrl=http://127.0.0.1:8420（stamp 20261031-224941），跨机必须重新 deploy 覆盖该值，加一行 env 改不了。
- 与 task-49 结论的交集：跨机时 profile patch 更容易被复制，明文 64 位 key 的风险被放大 ⇒ apiKey 凭据化从「优化项」升为「跨机前置项」。

## 10. 追加口径（2026-11-01 用户拍板方向）

### 10.1 传输：HTTP 直连即可，TLS 从「P0」降为「可选加固」

用户判断正确：插件本来就是纯 HTTP 客户端，跨机**不需要**改协议。落地的必要动作只有两条：

1. core 改绑：`tdai-gateway.yaml:19` `host` 从 `127.0.0.1` 改为内网 IP（或 `0.0.0.0`）。
2. 防火墙只放行 DSH 主机所在网段。

插件侧只改 `server.baseUrl` 为 `http://<内网IP>:8420`，其余键不动，`paths` 不变，头不变。

TLS 什么时候还是必须的：跨公网 / 不可信 Wi-Fi / 多人共用同一台 TDB 且互相不信任。理由是链路上有两把明文凭据——`Authorization: Bearer <64 位 core key>` 与 `x-tdai-user-key: <短 user key>`，以及 L0 里的用户原文。同机或可信内网可以接受明文。

### 10.2 身份：userkey → 用户 → 选 team/agent（不走静态三元组）

数据面已经具备，不用新造：

| 能力 | 端点 / 事实 | 证据 |
|---|---|---|
| userkey 反查用户 | `POST /v3/meta/auth/verify` body `{user_key}`（公开路由，仍需 `Authorization` + `x-tdai-service-id`） | `MemoryCore/src/metadata/router/v3-meta-router.ts:301`、`auth.ts:32-37` |
| 该用户所属团队 | `POST /v3/meta/team/list`（`userIdOrKeyFields`，可传 `user_id` 或 `user_key`） | `v3-meta-router.ts:143` → `listTeamsByUser`、schema `:112-115` |
| 团队内 agent | `POST /v3/meta/agent/list`（按 `team_id` 或 owner） | `v3-meta-router.ts:173-188` |
| 真实数据 | default 实例 metadata 库：`meta_users` 3 / `meta_user_keys` 3 / `meta_teams` 1 / `meta_agents` 3 / `meta_team_members` 3 | 只读盘点 `scratch/lead/meta-dump.mjs`（2026-11-01） |
| 现有实现参照 | Panel 已经这么用：`user_key → auth/verify → caller`，team/agent 有自己的管理页 | `MemoryPanel/src/panel/http/middleware/validate-panel-headers.ts:9-59`、`chat-memory.ts:3375-3385` |

实测值（default 实例，仅作形状参考，key 不外泄）：用户 `hechen` / `usr-2m7b1144d9`，团队 `team-2k12lgb650`（default-team），该用户名下 agent 之一 `agt-2m7buribzz`（default-agent-hechen）。`meta_user_keys.key_value` 存的是短 key（就 6 字符量级），与 64 位 core key 是**两层不同的凭据**：前者是身份层（`x-tdai-user-key`），后者是网关层（`Authorization`）。

### 10.3 插件侧的形态（v1 + v2 已落地，v3 后置）

| 形态 | 状态 | 做法 |
|---|---|---|
| v1 一次性 CLI | **已落地** | `node scripts/agemem-identity.mjs [--profile <p>] [--base-url <url>] [--userkey <k>] [--team <id>] [--agent <id>] [--dry-run] [--json]`：verify → team/list → agent/list → 交互选择或参数直给 → **只改** managed 块里 `config.server` 的 `teamId/agentId/userId` 三行。userkey 从不写进 patch；非 TTY 且存在多个候选时打印清单后 exit 2（不按顺序猜）。实现在 `dsh-plugin/scripts/agemem-identity.mjs`，纯函数（`chooseCandidate` / `updatePatchText`）与 CLI 均有单测。 |
| v2 启动自动解析 | **已落地** | 挂载时若三元组不齐：`server.userKey` → `credentials.resolve(userKeyRef)` → `env[userKeyRef]` 取 key，verify → team/list（owner 过滤）→ agent/list，唯一命中就地生效并 ready 报 `identity=resolved(user_key)`；0 个 / 多个 / key 无效 / 超 4s 各 warn **一次**并保持 inert（文案指向 CLI）。解析只在内存，**从不写 patch**。 |
| v3 GUI 弹窗 | 后置 | 真弹窗需要写 dsh.client 客户端插件（设置页 React），再由主进程调 meta 端点；等 v1/v2 稳定、确认用户真想每次装都点。 |

落地点：`server.userKey` / `server.userKeyRef`（缺省 `TDAI_USER_KEY`，值进 DSH 凭据库或 env）；三元组保留为「缓存/覆盖」，由 v1/v2 写入；ready 行报 `identity=resolved(user_key) | configured | missing(...)`，未解析时额外带 `userKeySource=config|credentials:<ref>|env:<ref>|none`（只报来源，不报值）。

两层凭据别混：core 网关 key（`server.apiKeyRef`，64 hex，进 `Authorization`）与 user key（`server.userKeyRef`，短 key，进 `x-tdai-user-key`）。用错层不会报「用错了」，只会 401 或「解析不到身份」。

### 10.4 迁移注意

- 三元组决定记忆池：换 agent = 换一份记忆。选完就别轻易改（无迁移工具）。
- 多机时同一 userkey 可解析出同一用户，但每台机器仍各自选 team/agent；要「换机接着聊」就选同一 agent。
