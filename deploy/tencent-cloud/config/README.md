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

- `${VAR}`：**功能性占位符**。proxy（`MemoryProxy/src/config.ts` 支持 `${VAR}` / `${VAR:-default}`）
  与 MemoryCore（`MemoryCore/src/gateway/config.ts` `expandEnvVars`）加载时由同名环境变量展开，
  部署时只需把真实值写进 `/opt/tdai/etc/env`。
- `<REPLACE_WITH_*>` / `<your-server-ip>` / `<LAN_IP_*>`：**部署时手工替换**的文本占位
  （env、Knowledge、config-override 等不做 `${VAR}` 展开的文件）。

## 密钥纪律

- 真实密钥只存在于服务器 `/opt/tdai/etc/env` 与各服务本地配置（600/640 权限）。
- 本目录任何文件不得出现真实 key、公网 IP、内网 IP；推送前跑密钥扫描
  （`git diff origin/main..HEAD` 扫 `sk-`、`key=`、`BEGIN`、`43.143`、`10.4.`、`10.6.`）。

## 派生与修复记录

- `proxy/proxy-config.cloud.example.yaml` 派生自生产 `proxy-config.yaml`。该生产文件中文注释曾因
  UTF-8/GBK 双重编码损坏，2026-10-06 两轮修复收口（值部零语义变更、15 处密钥行经备份逐字节对拍原样保留；
  残留 14 行注释/label 全部恢复：7 行 gb18030 严格往返零损失可证、5 行与 `MemoryProxy/config.example.yaml`
  同键注释逐字互证、2 行原生字节物理丢失按残片语义最小拟写），示例取自修复后版本。
- `core/tdai-gateway.cloud.yaml` 为 2026-10-06 重写的生产同构版（旧 213 行模板中文注释已损坏且落后于生产 269 行）。
