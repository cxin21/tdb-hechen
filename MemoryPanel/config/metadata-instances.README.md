# metadata-instances.json 字段说明（新面板 stateless）

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | 是 | = `instance_id` = 内核 `x-tdai-service-id`；本地常用 `default`，线上 `mem-{slug}` |
| `name` | 是 | 登录页展示名；**仅**通过 `GET /api/v1/meta/instances` 公开 |
| `gateway_endpoint` | 是 | 记忆 Gateway 根 URL；本地 `http://127.0.0.1:8420`。**Panel 后端 → Kernel 的转发地址，也是 DSH 插件等客户端的接入地址**（历史字段 `proxy_endpoint` 已随 MemoryProxy 退役删除） |
| `api_key` | 是 | Gateway Bearer；**仅服务端**转发用，**不**出现在 instances API |

## 本地文件（含密钥，不入库）

```bash
cp config/metadata-instances.example.json config/metadata-instances.json
# 再按本机 Gateway 填写 gateway_endpoint / api_key
```

`config/metadata-instances.json` 已加入 `.gitignore`；仓库只保留 `metadata-instances.example.json`。

> **更新提示**：首次 pull 到「该文件出库」的提交前，请先备份本地 `metadata-instances.json`；pull 后若文件被删，从备份恢复，或按上面从 example 重新拷贝再填 key。
