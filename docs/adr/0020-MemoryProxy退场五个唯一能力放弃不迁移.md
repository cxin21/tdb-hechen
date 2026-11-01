# ADR-0020 MemoryProxy 退场：五个"唯一能力"全部放弃，不迁移

- **状态**：已接受（2026-11-01，来源：用户令「仅支持 dsh、通过 dsh 插件连接、不需要代理，该放弃的就放弃，不用的都放弃，你自己选最优方案」；取证见 `docs/research/2026-11-01-dsh-specialization-pruning.md` 与 ADR-0018）
- **关联**：ADR-0018（上游同步边界，本条**取代**其中「不接受删掉这五个 handler」的约束）、ADR-0019（召回耗时与人格注入预算）、ADR-0003（灵魂规约）；实现面 `MemoryProxy/**`（整包删除）、`.github/workflows/**`、`deploy/**`
- **域词典**：[CONTEXT.md](../../CONTEXT.md) → 三服务拓扑 / legacy 网关

## 背景

仓库在代理时代是三跳拓扑：DSH → dsh-plugin → **MemoryProxy(8096)** → MemoryCore(8420)，旁挂 MemoryKnowledge(8421) 与 MemoryPanel。DSH 特化后插件直接打 8420，MemoryProxy 只剩一个"可选网关"的身份，却仍占 272 文件 / 62,926 行，并把 CI、deploy、配置模板、Panel 的四处配置默认值绑在 8096 上。

它存在的理由原本是五件 core 不做的事，逐条核对后**在 DSH 单用户单租户直连形态下全部失去前提**：

| 能力 | 原前提 | 直连后 |
|---|---|---|
| 计费链（`credit-reporter`/`pricing`/`credit-pricing` 691 行） | proxy 转发 LLM 且 URL 带 spaceId 才计数 | 没有转发环节，计费是空壳（取证：`connectivity.check` 报 `creditReport: FAIL: fetch failed`） |
| DSAT / 升级判定（`judge-client` 189 行 + `guard-adapter`） | 多成员、可升级套餐 | 单用户，无升级动作 |
| 限流（`rate-limit/{guard,redis-store,usage}` 496 行） | 多客户端并发入口 | 本机单用户，无并发压力；core 全仓无对等实现，也没有需要它的场景 |
| `mem:` 命令 + session-task（2,285 行） | 宿主侧命令层 | dsh-plugin 没有 `mem:` 命令面 |
| 成员 LLM Provider（`member-llm` + `routes/llm-providers` 895 行） | 多成员各配各的 provider | Panel 的 LlmProviderPage 同步删除（多 agent 编排退场） |

## 决定

1. **MemoryProxy 整包退场**（`git rm -r MemoryProxy/`），五个能力**不做迁移**。理由：迁移任何一项都是在没有该场景的情况下重建一层补偿，与 Wave 1 已确立的"不在 core 内部再造补偿层"（见 ADR 内的 `requireLlmRunner`）同一原则。
2. **删包前先解两处跨包 import**：`MemoryCore/scripts/backfill-l0-classification.ts:19`（`classifyInbound`）与 `MemoryCore/scripts/verify-c2.ts:46`（`renderCurrentFeeling`）。运行时语义（若真被生产链路使用）vendor 进 `MemoryCore/src/core/` 并配最小测试；只在一次性迁移脚本里用的，删脚本。
3. **CI 与 deploy 同批清**：`.github/workflows/ci.yml:102-119`、`probes-nightly.yml:31-45` 的 proxy job；`deploy/dockerhub/publish.sh:162`、`deploy/tencent-cloud/docker-compose.yml:31` 等 29 处。
4. **本条取代 ADR-0018 §37-39**「上游同步边界里不接受删掉这五个 handler」那一句。ADR-0018 关于"上游画像/关联只读、不写回上游"的边界仍然有效。
5. **Panel 与 Knowledge 不允许保留指向 8096 的运行时默认值**（`panel-config.ts` 的 `knowledgeLlmBinding.proxyBaseUrl` / `llmProvider.proxyBaseUrl`、`MemoryKnowledge/src/config.ts:220` 的 `LLM_MODE=proxy` 缺省），必须改向 core 8420 或显式报"未配置"。

## 后果

- 立即：仓库少 272 文件 / 62,926 行；三跳拓扑变两跳（DSH → core），排障面从"看两段日志"降到一段。
- 需要接受的代价：**计费/配额上报面消失**。如果将来要恢复按量计费，正确位置是 core 的 LLM 出口（`StandaloneLLMRunner` 的调用点），不是恢复 proxy。
- 需要接受的代价：`mem:` 命令面消失。将来若要做运维命令，落点是 dsh-plugin 的命令/工具面。
- 观测锚：全仓 `grep -rn "MemoryProxy\|memoryproxy\|8096"`（排除 node_modules/.git）应为 0；`check-config-templates.mjs` 不再出现"源文件不存在 memoryproxy.*"。

## 诚实边界

- 计费链的删除是**放弃能力**，不是"迁移到 core"。若你有按量计费的真实需求，本条需要被推翻重开。
- `admin/` 下的代理管理端点随包删除，未做逐端点取证；若你曾用浏览器直连 proxy 管理页，删除后该页 404 属预期。
