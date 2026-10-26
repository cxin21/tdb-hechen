# MemoryProxy proxy-config · 云端配置派生说明

> 权威起点：`deploy/tencent-cloud/config/proxy/proxy-config.cloud.example.yaml`——由腾讯云生产文件 `/opt/tdai/etc/proxy-config.yaml`（2026-10-06 乱码修复版，820 行）脱敏派生，密钥全部替换为 `${VAR}` 占位符。

## 用法

1. 复制 example → `/opt/tdai/etc/proxy-config.yaml`；
2. 按下表把 `${VAR}` 占位符换成真值（真值只存 `/opt/tdai/etc/env`，chmod 600，绝不入库）；
3. `chown tdai:tdai` + `chmod 600` 落位，重启 tdai-proxy 生效（配置仅启动时读取）。

| 占位符 | 来源（/opt/tdai/etc/env） | 说明 |
|---|---|---|
| `REPLACE_WITH_LLM_API_KEY`（字面量替换） | `TDAI_LLM_API_KEY`（deprecated，ADR-0006） | ark LLM key（`upstream.apiKey` 兜底；SoT=admin settings config-override.json） |
| `${TDAI_GATEWAY_API_KEY}` | `TDAI_GATEWAY_API_KEY` | core 网关 key（`tdai.apiKey` = `skill.serviceToken` 同源） |
| `${PROXY_ADMIN_API_KEY}` | `PROXY_ADMIN_API_KEY` | 运维口 `admin.apiKey`（公网部署必须设置） |
| `${PROXY_EXTERNAL_GATEWAY_URL}` | 手填 | 公网访问 core 的地址；proxy 与 core 同机部署时用 `http://127.0.0.1:8420` |
| `<LAN_IP_1>` / `<LAN_IP_2>` | 手填 | `trustedProxies` 内网网段示例，按实际 VPC 网段修改 |

`${VAR}` 展开由 proxy 配置加载器支持（`MemoryProxy/src/config.ts`，含 `${VAR:-default}` 默认值语法）。

## 防漂移：开发机有、云端可能没有的键

`MemoryProxy/config.yaml` 被 `MemoryProxy/.gitignore` 忽略（从未入库），所以**只在开发机 `config.yaml` 里加过的键，生产不会自动获得**——代码上线了、行为没变，启动日志也不告警。

已踩过的实例（2026-10-26）：`recallQuerySource: intent` / `l0CaptureMode: classified` 只存在于开发机，生产 `/opt/tdai/etc/proxy-config.yaml` 无这两个键 → 全程 legacy，一个用户消息按模型步数重复打 `/v3/recall`（实测同一 intent 在 21:19–21:23 连打 4 次，历史最高单意图 23 次）。

规则：**改 `MemoryProxy/src/config.ts` 的解析 = 同一提交内改本目录 example**。下列"闸门/口径"类开关在 example 里显式声明，不吃缺省：

| 键 | 缺省（=老行为） | 生产值 | 漏配的后果 |
|---|---|---|---|
| `tdai.memory.recallQuerySource` | `legacy` | `intent` | 每步一次召回；#87/#88 去重闸完全不生效 |
| `tdai.memory.l0CaptureMode` | `legacy` | `classified` | L0 只写单条提取结果，无 turnContext 全量与 classification 标签 |
| `tdai.memory.recallIntentDedup` | `true` | `true` | 去重闸关闭（同意图反复召回） |
| `tdai.memory.recallIntentDedupTtlMs` | `3600000` | 缺省即可 | 窗口过短会出现"聊着聊着又召回一次" |
| `injection.soulTiming.*`（7 键） | 各键见注释（=旧注入形态） | 全显式开启 | **错层陷阱**：写在顶层 `tdai.soulTiming` 解析器从不读取 → 静默回旧形态。生产已显式落盘 `redline: action_proximate` / `driftTrigger: auto` / `reanchor.intervalTurns: 20` / `redlineDedup.enabled` / `redlineCadence{mode: turn_head, depthOverflow: 8}` |
| `wikiRecall.jit` | `false` | `true` | #4/#63 JIT 转正没生效，wiki 召回留在 legacy 路由 |
| `wikiRecall.minStructuralTailNormScore` | 未启用 | `0.3` | #85 Q2 结构页附尾次门失效，结构页噪音进注入块 |
| `wikiRecall.querySource` | `message` | `intent` | #85 Q3 读不到 `turnContext.turnIntent`，wiki 召回按整段消息检索（含脚手架噪声） |
| `wikiRecall.maxTotalChars` | `0`（不限） | `1200` | issue #2 P0-3 的注入体积上限失效，wiki 片段可把上下文撑爆 |
| `tdai.memory.timeoutMs` | `5000` | `8000` | 必须 ≥ core `memory.recall.v3Recall.timeoutMs`（云端 8000），否则 proxy 先断、内核白跑 |
| `memCommand.enabled` | `false` | `true` | `/tdai` 命令面不可用 |

> 2026-10-26 审计（A+B+C 一轮）：生产 `injection.soulTiming` 一直有值、模板却是「整段注释 + 误放在 `tdai` 段」，重装即回退；`wikiRecall` 三个 #85 键同病。现已按生产现值写进 example，开发机 `MemoryProxy/config.yaml` 同步补齐（终态 diff 仅剩 5 处刻意环境差异：externalGatewayUrl / memCommand.enabled / server.host / storage.sqlite.dbPath / tdai.memory.timeoutMs）。

## 历史注

旧版本说明写「从本地 `MemoryProxy/config.yaml` 复制改 6 处」——该文件从未入库（git 历史只有 `config.example.yaml`），此派生路径作废。现 `MemoryProxy/config.example.yaml`（838 行）已与生产文件同步：补齐 creditPricing 的 scm-flash / ark-code-latest 计价行、appraisal 六值块、wikiRecall 块；通用部署仍以 `config.example.yaml` 为起点，云端部署用本目录 example。
