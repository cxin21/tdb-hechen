# ADR-0006 LLM 凭据 SoT 收敛：admin settings（config-override.json）为唯一运行时来源（#70）

日期：2026-10-19　状态：已采纳　派生：issue #70（TDAI_LLM_API_KEY 全景排查，方案 A）

## 背景与定位

`TDAI_LLM_API_KEY` 是早期「一把 key 三服务同源」设计的环境变量（`env.example` 同源注释、cloud 部署校验 `PROXY_UPSTREAM_API_KEY == MEMORY_LLM_API_KEY`）。实际演化出三类问题：

1. **优先级混乱**：MemoryCore `llm.apiKey` 通道序为 env > yaml > override（override 反而垫底）；而 admin settings（`config-override.json`）才是运维实际改配置的入口——env 一旦设置（哪怕是 `__ARK_KEY__` 占位）就永久压住真实配置，曾导致 persona-eval CLI「env 压过 --config yaml」类陷阱。
2. **占位符穿透**：`__ARK_KEY__` 占位符曾长期滞留生产 `env.ps1`，被视为「已配置」参与解析，掩盖真实凭据缺口。
3. **双 SoT 漂移**：config-override.json（admin settings）与 env 两处都要维护，实际只有 override 被运维触碰，env 沦为幽灵通道。

## 决策

1. **LLM 凭据（baseUrl/apiKey/model 的秘密字段 apiKey）运行时唯一 SoT = admin settings**，即各服务 `{dataDir}/config-override.json`（MemoryCore `readSettingsOverride` / wiki `admin-settings` 路由均已内建）。
2. **通道序统一为 override > yaml > env(deprecated)**：
   - MemoryCore `llm.apiKey`（`config.ts` `resolveLlmApiKey`）：yaml 已设 → 用 yaml；否则 env 回退并 **console.error 一次性弃用告警**（含「ADR-0006」「弃用」「config-override.json」字样）；占位符（整串 `__X__` 或 `${X}` 形态，`utils/credential.ts` `isPlaceholderCredential`）一律视为未设置。
   - 脚本域单一读取器 `MemoryCore/scripts/lib/read-llm-credential.ts`：逐字段 override > yaml > env，返回 `apiKeySource` 溯源标记；repair-scene-blocks / backfill-theme-aliases / backfill-core-refs / e2e-memory-prompt-vdb-cos 四个 ops 脚本换用。
   - persona-eval CLI：`--config` yaml 的 llm 段缺字段时按同通道序回退补齐，不再被 env 静默压过。
3. **非秘密字段不受影响**：`baseUrl`/`model`/`provider`/`maxTokens` 等 env 优先通道保留（不是秘密，且是行为开关而非凭据）；`embedding` 的 env 优先同样保留——本 ADR 只收敛 `llm.apiKey` 这一秘密字段。
4. **env 变量本身保留读取作为回退**（灰度安全），但在文档中标注 deprecated；生产机 `env.ps1` 的 `TDAI_LLM_API_KEY` 行删除。
5. **部署面同步**：proxy cloud example 的 upstream key 占位符改字面量替换标记；wiki custom 模式改用自身 admin settings（env 仅回退）；九份部署文档同步口径。

## 后果

- 单一 SoT：改 key 只碰 admin settings（config-override.json），env/yaml 不再需要同步维护。
- 占位符不再穿透：`__ARK_KEY__` 类值被守卫拦截，不再冒充真实凭据。
- 兼容期：env 回退 + 弃用告警保留，存量部署不炸；观察期后可移除 env 通道。
- 测试锚点：`settings-override.test.ts`（5 测解析链）+ `read-llm-credential.test.ts`（6 测读取器）+ `assertions-orchestration.test.ts` / `drift-baseline.test.ts`（帽透传）。
