# 腾讯云部署配置示例（deploy/tencent-cloud/config/）

本目录是腾讯云服务器 `/opt/tdai` 生产配置的**脱敏示例**：结构、键名、注释与生产文件同构，
密钥一律以占位符表达，绝不提交真实值。

## 服务器路径 ↔ 示例文件对照

| 服务器真实文件（权限） | 示例文件 | 说明 |
| --- | --- | --- |
| `/opt/tdai/etc/env` (600) | [`env.example`](./env.example) | systemd EnvironmentFile，四服务共用（gateway/LLM/admin 三把 key + 日志级别） |
| `/opt/tdai/etc/proxy-config.yaml` (600) | [`proxy/proxy-config.cloud.example.yaml`](./proxy/proxy-config.cloud.example.yaml) | Context Proxy 全量配置（820 行生产同构），派生法见 [`proxy/CLOUD-DIFF.md`](./proxy/CLOUD-DIFF.md) |
| `/opt/tdai/td-agemem/MemoryCore/tdai-gateway.yaml` (640) | [`core/tdai-gateway.cloud.yaml`](./core/tdai-gateway.cloud.yaml) | 内核 gateway 配置（269 行生产同构，`${VAR}` 占位） |
| `/opt/tdai/td-agemem/MemoryKnowledge/.env` (644) | [`knowledge/env.cloud.template`](./knowledge/env.cloud.template) | Knowledge 服务环境变量 |
| `/data/tdai-memory/config-override.json` (644) | [`config-override.example.json`](./config-override.example.json) | LLM/Embedding 运行时覆盖（仅 llm/embedding 两段） |
| `/opt/tdai/td-agemem/MemoryPanel/config/metadata-instances.json` (644) | [`../../../MemoryPanel/config/metadata-instances.example.json`](../../../MemoryPanel/config/metadata-instances.example.json) | Panel 实例注册表（复用组件内示例） |

## 占位符约定

- `${VAR}`：**功能性占位符**。MemoryCore（`MemoryCore/src/gateway/config.ts` `expandEnvVars`）
  加载时由同名环境变量展开（proxy 已退场，ADR-0020），部署时只需把真实值写进 `/opt/tdai/etc/env`。
- `<REPLACE_WITH_*>` / `<your-server-ip>` / `<LAN_IP_*>`：**部署时手工替换**的文本占位
  （env、Knowledge、config-override 等不做 `${VAR}` 展开的文件）。

## 密钥纪律

- 真实密钥只存在于服务器 `/opt/tdai/etc/env` 与各服务本地配置（600/640 权限）。
- 本目录任何文件不得出现真实 key、公网 IP、内网 IP；推送前跑密钥扫描
  （`git diff origin/main..HEAD` 扫 `sk-`、`key=`、`BEGIN`、`43.143`、`10.4.`、`10.6.`）。

## 派生与修复记录

- `proxy/proxy-config.cloud.example.yaml` 及其所在 `config/proxy/` 目录已于 2026-11-01 随 MemoryProxy 整包退场删除
  （ADR-0020）。历史派生/编码修复记录保留在 git 历史与 `deploy/tencent-cloud/CLOUD-DIFF.md` 的替代票中。
- `core/tdai-gateway.cloud.yaml` 为 2026-10-06 重写的生产同构版（旧 213 行模板中文注释已损坏且落后于生产 269 行）。
