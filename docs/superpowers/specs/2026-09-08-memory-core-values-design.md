# 核心价值锚 + Core Memory · 设计

> 触底：spec 支柱「身份(F)」+「感受(§5)」里的 `coreValues / coreRef`。原则（承前讨论）：**价值锚是感受的参照系**，core 是"这个 agent/用户真正在意什么"的小块常驻，agent 可维护。

## 1. 目标
- 一小撮 `core_memory`（身份 / 关键偏好 / 严格规则）稳定锚进 session_init 稳定区（cache 友好、不毁缓存）。
- `core_values` 值表：让"感受"有参照（valence/significance 都对着它算）。
- **agent 可维护**（Letta 式）：agent 能按约定读/改自己的 core（受信任边界约束）。

## 2. 数据模型
```
core_memory { id, slot: identity|core_value|strict_rule, content, source, version, updated_at(agent-editable) }
core_values  { value_id, label, weight 0..1, created_by }   -- 价值锚
```
- L1 的 `coreRef: valueId[]` 引用 `core_values`，形成"这条触动哪个价值"。

## 3. 注入（利用层）
- core_memory 逐会话注入（进 `tdai-profile-memory-injector` 的稳定块，`session_init`）。
- 稳定（identity/严格规则）常驻；core_value 作为 L（当前感受）的参照。

## 4. agent 可维护接口
- 提供读/改 core 的工具（需身份认证 + 写入长度/来源约束）。
- **信任边界**：core 只能被可信来源写、改动留痕（version/updated_at/source）——防投毒覆盖身份层（红线）。

## 5. 安全
- core 是"自我"所在，写入必须来源可信 + 消毒 + 上限；非 naturally 可信的对话内容不得直接写 core。
- 恢复：core 每版本可回滚。

## 6. 非目标
- 不做全部 L1 进 core（只身份/严格规则/价值锚）。
- 不做自动生成价值锚（先人工/团队定义，M 再谈演化）。

## 7. 待评审
- core 预设长度与预算；agent 改 core 的权限边界（要不要人工 approve）。

---

## 实现状态（2026-09-08 P1）
- ✅ `core_memory`(identity/core_value/strict_rule 槽) + `core_values` 表 + CRUD（upsertCore/readCore/upsertValue/listValues，version 留痕）+ `/v3/core-memory/read|write`（`9711de2`）。
- ⏳ 待办：core 稳定块注入到 session_init、写 core 的鉴权/长度上限/信任边界、L1 `coreRef` 写入、M 演化同步 core。