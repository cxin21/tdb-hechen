# MemoryProxy config.yaml · 云端差异清单

> 用法：`cp 本地 MemoryProxy/config.yaml → /opt/tdai/etc/proxy-config.yaml`，按下表改 **6 处**。其余 753 行原样（host 0.0.0.0 / port 8096 本就正确）。

| # | 位置（行号参考本地） | 原值 | 云端值 |
|---|---|---|---|
| 1 | `auth.url` (:367) | `http://127.0.0.1:8420` | `http://127.0.0.1:8420` **不变**（proxy 与 core 同机 systemd 部署，localhost 直达） |
| 2 | `tdai.apiKey` (:599) | `sk-mem-jVC4…`（本地网关 key） | **云端新 key**（/opt/tdai/etc/env 的 TDAI_GATEWAY_API_KEY 同值） |
| 3 | `tdai.endpoint` (:598) | `http://127.0.0.1:8420` | 不变（同机） |
| 4 | `skill.endpoint` (:651) | `http://127.0.0.1:8420` | 不变（同机） |
| 5 | `knowledge.endpoint`/`serviceToken` (:671-672) | endpoint 不变；`serviceToken: "local"` | serviceToken 改为云端网关 key（与 #2 同值——knowledge 链路走 core 转发） |
| 6 | `upstream.apiKey` (:35) | ark LLM key | ark LLM key 不变（LLM 出网转发放行）；确认 `admin.apiKey`（:390 注释/env `TDAI_PROXY_ADMIN_API_KEY`）**必须设置**（本地默认关，公网运维口不能裸奔） |

## 密钥纪律

- `/opt/tdai/etc/env`（chmod 600）是唯一密钥真源：`TDAI_GATEWAY_API_KEY`（core server.apiKey = proxy tdai.apiKey = panel api_key 三处同源）、`TDAI_LLM_API_KEY`（ark）、`PROXY_ADMIN_API_KEY`。
- 本地生产的三把旧 key（sk-mem-jVC4… / 42224dcd… / "local"）**不要带上云**——全部换新。
- `wikiRecall` 段（:683 起）默认值可直接用；wiki 绑定在 Panel 里按 §8 重新注册，不迁配置。
