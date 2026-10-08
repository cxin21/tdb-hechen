# MemoryProxy proxy-config · 云端配置派生说明

> 权威起点：`deploy/tencent-cloud/config/proxy/proxy-config.cloud.example.yaml`——由腾讯云生产文件 `/opt/tdai/etc/proxy-config.yaml`（2026-10-06 乱码修复版，820 行）脱敏派生，密钥全部替换为 `${VAR}` 占位符。

## 用法

1. 复制 example → `/opt/tdai/etc/proxy-config.yaml`；
2. 按下表把 `${VAR}` 占位符换成真值（真值只存 `/opt/tdai/etc/env`，chmod 600，绝不入库）；
3. `chown tdai:tdai` + `chmod 600` 落位，重启 tdai-proxy 生效（配置仅启动时读取）。

| 占位符 | 来源（/opt/tdai/etc/env） | 说明 |
|---|---|---|
| `${TDAI_LLM_API_KEY}` | `TDAI_LLM_API_KEY` | ark LLM key（`upstream.apiKey`） |
| `${TDAI_GATEWAY_API_KEY}` | `TDAI_GATEWAY_API_KEY` | core 网关 key（`tdai.apiKey` = `skill.serviceToken` 同源） |
| `${PROXY_ADMIN_API_KEY}` | `PROXY_ADMIN_API_KEY` | 运维口 `admin.apiKey`（公网部署必须设置） |
| `${PROXY_EXTERNAL_GATEWAY_URL}` | 手填 | 公网访问 core 的地址；proxy 与 core 同机部署时用 `http://127.0.0.1:8420` |
| `<LAN_IP_1>` / `<LAN_IP_2>` | 手填 | `trustedProxies` 内网网段示例，按实际 VPC 网段修改 |

`${VAR}` 展开由 proxy 配置加载器支持（`MemoryProxy/src/config.ts`，含 `${VAR:-default}` 默认值语法）。

## 历史注

旧版本说明写「从本地 `MemoryProxy/config.yaml` 复制改 6 处」——该文件从未入库（git 历史只有 `config.example.yaml`），此派生路径作废。现 `MemoryProxy/config.example.yaml`（838 行）已与生产文件同步：补齐 creditPricing 的 scm-flash / ark-code-latest 计价行、appraisal 六值块、wikiRecall 块；通用部署仍以 `config.example.yaml` 为起点，云端部署用本目录 example。
