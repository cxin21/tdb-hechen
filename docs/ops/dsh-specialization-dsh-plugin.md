# DSH 特化盘点 · dsh-plugin/ （task-49）

范围：`dsh-plugin/`（src / scripts / test / package.json）+ 部署链（`scripts/deploy.sh` → profile patch）。
方法：宿主源码从 `D:/DSH/resources/app.asar` 解出（`scratch/asar.mjs` → `scratch/asar-dump/`）。下文的 `dsh/node_modules/<pkg>:<line>` 指 asar 内解出文件的真实行号；插件自身用 `dsh-plugin/src/...:<line>`。真机读数取 task-31/44 两次 e2e 报告。
立场：**只分析**。删改下一轮、需用户点头。

## 0 四问速览

| # | 问题 | 结论 | 一句话依据 |
| --- | --- | --- | --- |
| 1 | `dsh.bundle` 该不该加 | **该加**（只加 `dsh.bundle.patch`，不做「官方 bundle」） | 有 patch 声明 → 自动进 `dsh.profile.bundles` 并自动装配（`dsh-plugin-manager/lib/index.js:311-350`） |
| 2 | 宿主能力缺口 | 现用 5 类钩子，**该补 3 个**：`credentials/*`（key 出明文）、`compaction/summary`（宿主摘要进记忆）、`session/title` | 能力表见 §2，`agent/*` 事件全集 13 个（`scratch/asar-events.mjs` 实测） |
| 3 | 预取 / atomic 回退 / tools fallback | 预取**留机制删话术**；atomic 回退**别删**；tools fallback **改成显式能力探测** | §3 三档表 |
| 4 | 做成可发布插件 | 可行，最小路径 4 步（§4） | `dsh plugin add` 对 path/registry **强制** `dsh.bundle`（`dsh-plugin-manager/lib/index.js:1866`、`:1917`） |

## 1 `declares no dsh.bundle` 是什么、该不该声明

**写法**：`dsh/node_modules/@deepseek-ai/dsh-plugin-manager/lib/index.js:336`（`reconcile()` 内，`:323-351`）。`dsh plugin add` 跑完 pnpm 后遍历新增依赖：
`bundleManifest(name)` 仅在 `manifest.dsh?.bundle?.patch !== undefined` 时返回清单（`:311-314`）⇒ **`dsh.bundle` 的全部语义就是「包内 patch 文件路径（string 或数组）」**（`dsh-app-boot/lib/index.js:517-531`）。
- 有 patch：`loadOverlayPatches` 叠层 + 包名写进 `package.json` 的 `dsh.profile.bundles`（`:339-350`）⇒ 此后每次启动自动装配，**不再需要手写 `cordis.patch.yml`**。
- 没有 patch：warning + `continue`（`:335-338`）⇒ 包只是 `dependencies` 一行，装配自己写。

**desktop 现状（真装实测）**：`~/.dsh/profiles/desktop/package.json:12` = `"@tdb/agemem-dsh": "file:D:/TDB/td-agemem/dsh-plugin/artifacts/tdb-agemem-dsh-0.1.0.tgz"`；`dsh.profile.bundles` **38 条、不含** `@tdb/agemem-dsh`；`cordis.patch.yml:221-233` 是 deploy.sh 的 managed block；`node_modules/@tdb/agemem-dsh/dist` 在。⇒ 装了、启得起来、但不是 profile layer。

**声明后的收益（均可指源码）**：

| 收益 | 证据 |
| --- | --- |
| 自动装配 + 随包升级 | `dsh-app-boot/lib/index.js:517-531`（patch 路径以包目录为基准） |
| 官方安装入口接受 | `dsh-plugin-manager/lib/index.js:1866`（path）、`:1917`（registry） |
| 兼容闸门（版本不匹配拒载） | `dsh-app-boot/lib/index.js:279-326`、`:2074-2076` |
| 行级启停 / 卸载 / protectsManager | `dsh-plugin-manager/lib/index.js:2165-2185`、`:2307-2323` |

**不声明的代价**：只能走 `file:` tarball（`:1846-1854` 对 tarball 不查 bundle ⇒ 装得进），装配靠 `scripts/deploy.sh:213-233` 的 `render_entry()` 写 patch、`scripts/patch-util.mjs` 回滚；profile 重建/换机要人工重放 patch；`dsh plugin` 的启停/更新对它是 `not-bundle`（`:2074`、文案见 `lib/types/tools.js:14`）。

**结论**：加。做法是「包内 `cordis.patch.yml` 只放**插件行**（id/name/能力开关），identity 与 key 仍然部署期注入」——原因见 §6 风险 R1（identity 硬编码进包 = 包一装就串号）。

## 2 宿主能力清单（已用 / 该用未用）

`agent/*` 事件全集 **13 个**（`scratch/asar-events.mjs` 实测，来源包一并列出）：`pre-step`(`dsh-agent-loop/lib/index.js:909`)、`turn-stopping`(`:1001`)、`assistant-stream`(`:1080`)、`request`、`request-error`(`:1136`)、`created`、`disposed`、`error`、`status`、`inbox/claimed`、`inbox/inserted`(`:206`)、`inbox/discarded`、`inbox/spliced`。

**已用（7 处）**：`agent/pre-step`（`dsh-plugin/src/volatile.ts:204`）、`agent/turn-stopping`（`src/writeback.ts:500`）、`session/event`（`src/writeback.ts:407`、`src/index.ts:761`）、`compaction/start|end`（`src/index.ts:796`）、`agent/created`（`src/index.ts:325`）、`systemPrompt.section`（`src/index.ts:351`、`:366`）、`ctx.tools.register`（`src/index.ts:746`）+ `ctx.on('dispose')`（`:860`）。

**该用未用（按价值排序）**：

| # | 能力 | 宿主证据 | 现在怎么做的 | 改成什么 / 为什么 |
| --- | --- | --- | --- | --- |
| G1 | `credentials/*`（describe/set/record-updated） | `dsh-api-settings-controller/lib/typert.host.js:154`、`dsh-api-remotes/lib/client.js:3025` | core 的 64 位 hex key **明文写在 profile patch 里**（`scripts/deploy.sh:222` 写 `apiKey: "$CORE_KEY"`；desktop 上就是那一行） | 只写 `apiKeyRef`，key 走 DSH 凭据库（插件已支持 `credentials → env → inline` 三级解析，`src/index.ts` 的 `resolveApiKey`），部署脚本改为「提示用户去设置页填」。**DSH 特化的第一收益：敏感值不进明文配置** |
| G2 | `compaction/summary` | `dsh-api-session-controller/lib/index.js:1171`（另有 `dsh-agent-preset-registry/lib/typert.host.js:745`） | 只在 `compaction/start|end` 时让 head pack 失效重取（`src/index.ts:796`） | 把宿主自产摘要**作为一条记忆写回**（L0/L2 候选）：摘要本来就是「这一段的要点」，比逐条 user/assistant 更省 L2 抽取成本。注意：现在**未使用**，payload 形状未证实 ⇒ 先做探针 |
| G3 | `session/title` | `dsh-api-session-controller/lib/client.js:173` | 无 | 会话标题（宿主 LLM 生成）当记忆的 label/场景名，成本≈0 |
| G4 | `agent/inbox/inserted` | `dsh-agent-loop/lib/index.js:206` | 用 `agent/pre-step` 往 messages 尾部追加（task-31 实测：会落盘成一条 `user/message`，`source.kind=plugin:tdb-agemem-dsh`） | 若宿主原生 inbox 插入更干净（不落盘/不进 KV 前缀），可替代 pre-step 追加；**未证实** payload 与是否落盘 ⇒ 探针优先 |
| G5 | `agent/request-error` | `dsh-agent-loop/lib/index.js:1136` | 靠 `turn/end{reason.kind==='error'}` 兜错误回合（`src/writeback.ts:18` 注释已记录该缺口） | 直接捕获 provider 失败，避免「半截回合」判断依赖 turn/end 的形状 |
| G6 | `agent/assistant-stream` | `dsh-agent-loop/lib/index.js:1080` | 从 `session/event` 的 `assistant/message` 里过滤 reasoning（`src/writeback.ts` `visibleTextOfContent`，task-31 已验证 1613→180 字符） | 流式端只拿可见增量，理论上更早、更干净；**未证实** payload ⇒ 探针优先 |

**能力我们已经拿满的部分**：系统提示词（section + order，task-44 实测 8437 字符 / 14 行进 system/message）、工具注册（`ctx.tools.register`）、会话事件、压缩生命周期、凭据 seam。⇒ DSH 特化缺口集中在 **G1（安全）** 与 **G2/G3（记忆素材质量）**。

## 3 可删 / 可简化三档

依据：`grep -rn` 调用点计数（src 0 调用 = 无入口可达）。**不删任何文件**，这里是清单。

**A. 安全删（0 个 src 调用方，只有测试在养）**

| 项 | 证据 | 说明 |
| --- | --- | --- |
| `client.deleteConversation` + `paths.conversationDelete` | `src` 调用 0、`test` 1（`test/memory-client.test.ts`） | 插件从不删会话（零删除红线本来就禁）；path 与配置项一起删 |
| `client.health` + `paths.health` | `src` 0、`test` 3 | 探活从未被调用（ready 行不打 health）；要留就改成启动自检一次，否则删 |
| `client.recalCombined` | `src` 0、`test` 0 | 纯死代码（三腿合并的旧形态），删它不影响任何路径 |

**B. 需确认（有真实通路，但可简化）**

| 项 | 证据 | 判断 |
| --- | --- | --- |
| `atomic/search` 回退 | `src` 2 处调用：`src/index.ts:413-440`（recall 失败后回退）、`src/memory-client.ts:609`（`recall()` 别名给工具用）；触发条件 404/504/422 熔断 + `volatile.recall:false`（`src/index.ts:284-290`） | **别删**：task-44 反例已证明 `volatile.recall:false` 时它就是唯一供料路；422 熔断后每轮直接走它 |
| 预取链路（`prefetchBlock` + `RecallInflight`） | `src/index.ts:455-470`、`:776`；`src/recall-cache.ts:110` | **留机制删话术**（task-43 已定）：task-31/44 全部 `prefetched:false`，它救不了本轮延迟，只对「同文本重复」有用。若再精简，可只保留 `RecallCache`（10min TTL 命中）、删 `prefetchBlock` 的调度；代价是 4 个用例要改 |
| `tools.ts` 的 lazy import fallback | `src/tools.ts:14-35`（`load('@deepseek-ai/dsh-tools')`，失败 warn 一次）；`@deepseek-ai/dsh-tools` **不在** desktop 的 node_modules 也不在 `~/.dsh/profiles/node_modules`（ls 实测） | **别删**，但改成「启动时打一行探测结果」：宿主会把安装自带包喂给解析器（`dsh-app-boot/lib/index.js:500-503`），所以运行时可能解析得到 ⇒ 现在**未证实**，靠 ready 行把结论打出来 |
| `scripts/deploy.sh` 的 `--api-key`/明文写入 | `scripts/deploy.sh:222` | 与 G1 一起改：脚本改为只写 `apiKeyRef`，key 由用户在设置页填 |

**C. 别删（隐性依赖或红线）**

| 项 | 理由 |
| --- | --- |
| `outbox` / 死信（`src/outbox.ts`，缺省 `$DSH_HOME/agemem/outbox.jsonl`） | 零删除红线；现实数据：本机 `outbox.dead.jsonl` 2 行（l0+skill，401 实验遗留），删文件=丢审计 |
| L0 + skill 双链路（`src/writeback.ts`） | L2 场景只靠 skill 链路供给（task-22 结论）；砍任一条 = 记忆质量断层 |
| `guidance.ts`（答案口径 / 工具清单镜像） | 版本号与 core 对齐（`src/guidance.ts:25`、`:28`），删了会与 core 的 `ANSWER_GUIDANCE_VERSION` 漂移 |
| `wire-limits.ts`（8192/100/500/700000） | 都是服务端实测硬限（core 400/ECONNRESET 的实证），不是我们的偏好 |

## 4 发布形态：从 file: tarball 到真插件

**现状**：`package.json` 里只有 `name/version/private/main/files/engines.node/peerDependenciesMeta`；`private: true`、无 `dsh`、无 `engines.dsh`；安装靠 `file:` tarball + 手写 patch。tarball 之所以能装进去，是因为宿主对 tarball spec **不查 bundle**（`dsh-plugin-manager/lib/index.js:1846-1854`）。

**宿主接受的三条安装路（实测源码）**：

| spec | 是否要求 `dsh.bundle` | 证据 |
| --- | --- | --- |
| `file:*.tgz` | 否（装完只 warning） | `dsh-plugin-manager/lib/index.js:1846-1854` → `:335-338` |
| 本地目录 path | **是**，否则 `not-a-bundle` 拒绝 | `:1855-1866` |
| registry 名 | **是** + 版本兼容闸门 | `:1912-1917`、`:2074-2076` |

**真实第三方模板（本机 desktop 里就在跑的两个）**：`dsh-context@0.77.0`、`dshmarket@1.70.1` 都是 **registry 版本号**安装、都在 `dsh.profile.bundles` 列表里：

```json
// dsh-context/package.json（实测）
"engines": { "node": "^22.19.0 || >=24.0.0", "dsh": ">=0.2.0-rc.2 || >=0.2.1-rc.2" },
"dsh": { "bundle": { "patch": "./cordis.patch.yml" },
         "client": { "inject": [...], "platform": "web" },
         "compatibility": { "dshReleases": { "0.2.0-rc.2": "compatible", "0.2.1-rc.2": "compatible" } } }
```

其 `cordis.patch.yml` 只有三行有效内容（`- insert: - id: dsh-context / name: dsh-context`），**不带 config** —— identity/key 由使用方覆盖。这正是我们该抄的形态：`bundle patch` 放「插件行 + 能力开关缺省」，部署期 config 用 profile 的 `- id: tdb-agemem-dsh  config: {...}` 覆盖（loader 的 config 是整块替换，不是深合并：`scripts/deploy.sh:209-212`）。

**最小可行路径（4 步，按依赖顺序）**：
1. `package.json` 加 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，包内 patch 只写 `- insert: - id: tdb-agemem-dsh / name: ./dist/index.js`（**不含 identity/key**）。
2. 加 `engines.dsh`（抄 dsh-context 的范围，或写 `>=0.2.1-rc.2`），让版本闸门替我们在不兼容宿主上拦住。
3. 去掉 `private: true`（`dsh-app-boot/lib/index.js:928` 对官方源码安装要求非 private；对 registry 安装它是 `pnpm view` 元数据，`private` 包根本发不出去），`version` 提到 `0.2.0`，发布到内部 registry（普通 npm 包即可，宿主只读 `dsh` 字段）。
4. `scripts/deploy.sh` 从「pack tarball + render_entry」降级为「`dsh plugin add @tdb/agemem-dsh@<ver>` + 写 profile 的 id-targeted config 覆盖」，rollback 只删 config 覆盖行（bundle 卸载走 `dsh plugin remove`）。

**市场/签名**：官方 on-demand 目录是**构建期生成的常量**（`dsh-app-boot/lib/index.js:2406-2412`，`pnpm gen-official-bundle-catalog` 生成，仅 `@deepseek-ai/*` 两个 subagent 包）⇒ 第三方进不了那份目录；实际分发面是 registry + 插件管理器 UI（`dshmarket` 自己就是一个这样装的 bundle）。**签名校验：未证实**（未在 `plugin-manager` 找到签名/公钥校验调用链，只看到 pnpm 的 integrity 字段）。

## 5 配置面：43 个键，谁真会改

`DEFAULT_CONFIG` 实测 **43 个叶子键**（`node -e` 遍历 dist）：server 8 / paths 8 / headPack 8 / volatile 6 / writeback 8 / tools 3 + `enabled`、`debug`。

| 处置 | 键 | 依据 |
| --- | --- | --- |
| **留配置**（用户真会改） | `enabled`、`debug`、`server.{baseUrl,apiKeyRef,teamId,agentId,userId,serviceId}`、`volatile.enabled`、`writeback.enabled`、`writeback.skillFeed` | identity 缺省为空=inert 是安全设计（`src/config.ts:187-191`）；其余是「同一身份是否已被别人喂过」的排他开关 |
| **进 DSH 设置页** | 同上 + `volatile.recall`、`volatile.maxChars`、`writeback.maxAttempts` | 这些是「部署者调参」而不是「开发者改代码」，走 profile config（设置页/凭据库）即可 |
| **硬编码成常量** | `paths.*`（8 条 v3 契约）、`wire-limits`（8192/100/500/700000 已是常量）、`headPack.{orderOffset,includeScenarioIndex,maxScenarioEntries,fallbackText}`、`tools.*`（enabled/recall/recallTopK） | 引用计数：`orderOffset` 2 处、`fallbackText` 2、`includeScenarioIndex` 3、`maxScenarioEntries` 2 —— 全是内部使用，没有「运维需要改」的场景；`paths` 改一条就是协议错误（`src/config.ts:196-205`） |
| **观察后决定** | `server.requestTimeoutMs`、`headPack.{maxChars,timeoutMs,refreshMs}`、`volatile.{timeoutMs,recallMaxResults,recallTimeoutMs}`、`writeback.{retryMs,maxMessageChars,maxMessagesPerRequest,maxRequestBytes,outboxPath}` | 都是实测定档值（`src/config.ts:192-246` 有实测注释）；`outboxPath` 空=走 `$DSH_HOME/agemem/`，DSH 特化后应固定成 `$DSH_HOME` 下的路径而不是可配 |

## 6 风险与执行顺序

**风险**
- **R1 identity 不能进包**：包内 patch 若写 teamId/agentId/userId，谁装谁串号（`src/config.ts:187-191` 的「空=inert」就是为此）。⇒ §4 第 1 步的 patch 绝不能带 config。同理会话里的 key 也一样（G1 之后连 profile patch 都不该有明文 key）。
- **R2 loader config 是整块替换**（`scripts/deploy.sh:209-212` 注释 + 实测：patch 里 `- id: X config:` 会整体替换该行 config）⇒ bundle patch 里给缺省、profile 里给部署值，两处都必须写**完整** config，漏键就回缺省（不是继承）。
- **R3 删 A 档会动测试**：`deleteConversation`/`health` 的用例在 `test/memory-client.test.ts`、`test/config.test.ts`；删完预期 223 → 约 219 条，必须重跑 `npx vitest run` 报数（不能只看 tsc）。
- **R4 数据面**：删 client 方法**不影响已落库数据**（L0 行、skill buffer、outbox.dead 都不含这些字段）；唯一牵连是旧 outbox 行里的 `reason.endpoint` 文案可能指向已删 path（`outbox.dead.jsonl` 现有 2 行是 `/v3/conversation/add` 与 skill，不涉 health/delete）。
- **R5 对外合同**：`memory_recall` 工具名、参数（`query`/`limit`）、L0/skill 两种 payload 形状都是「已落库＋已上线」的合同，本轮清单里**没有任何一条提议改它们**；改它们要单独立票 + 迁移。
- **R6 未证实项**：`@deepseek-ai/dsh-tools` 运行时能否解析（本机 node_modules 里没有，但宿主会把安装自带包喂给解析器 `dsh-app-boot/lib/index.js:500-503`）；`compaction/summary`/`agent/inbox/inserted`/`agent/assistant-stream` 的 payload 形状；第三方能否进插件市场 UI。⇒ 都要一次性 profile 探针，别按猜的改。

**执行顺序（每步都能自证没坏）**
1. 加 `dsh.bundle.patch` + 包内 patch（只 id/name）：验证 `dsh plugin add <本地目录>` 不再报 `not-a-bundle`，且 `--dump-config` 后 `dsh.profile.bundles` 出现包名；回滚 `dsh plugin remove`。
2. G1 凭据化（`deploy.sh` 只写 `apiKeyRef`）：验证重启后 ready 行 `keySource=credentials:<ref>`，且 profile patch 里 grep 不到 64 位 hex。
3. 删 A 档三件 + 对应 path 常量：`npx tsc -p tsconfig.json --noEmit`、`npx vitest run`、`grep -rn 'deleteConversation\|recalCombined\|paths.health' dsh-plugin` 应无残留。
4. 预取精简（可选，先砍 `prefetchBlock` 调度保留 `RecallCache`）：验证 4 个预取用例改写后仍绿，且 e2e debug 行仍出 `source:recall`。
5. G2/G3/G4/G5/G6 探针票：一次性 profile，1 次 headless，只加监听器打 payload 形状，不改产品路径。