# 配置模板交付台账（6 份模板 / 982 键）

> 回答「配置模板交付了什么、靠什么脚本自证、哪些地方模板与真实代码走到了岔路上」。规格真源 `config/SPEC.md`（82 行）；执行体 `scripts/check-config-templates.mjs`（312 行）。本文件只登记**可核事实**：每条给 path:line 或脚本读数，不抄标题。

## 1. 交付物与今日读数（2026-11-01，本票自己实跑）

| 交付物 | 内容 | checker 读数（键 / ignored / 行号命中） |
|---|---|---|
| `config/SPEC.md` | 模板格式契约 + coverage 判据 + 红线 | — |
| `scripts/check-config-templates.mjs` | 6 份模板 ↔ 源码双向校验，FAIL 即 exit 1 | — |
| `config/templates/memorycore.yaml` + `config/templates/memorycore.keys.json` | core（8420）全部解析键 | 483 / 12 / 483 |
| `config/templates/memoryproxy.yaml` + `config/templates/memoryproxy.keys.json` | proxy（8096） | 170 / 2 / 170 |
| `config/templates/memoryknowledge.yaml` + `config/templates/memoryknowledge.keys.json` | knowledge（8421） | 48 / 2 / 48 |
| `config/templates/memorypanel.yaml` + `config/templates/memorypanel.keys.json` | panel（8123） | 22 / 4 / 22 |
| `config/templates/dsh-plugin.yaml` + `config/templates/dsh-plugin.keys.json` | 插件（宿主内，无端口） | 76 / 0 / 76 |
| `config/templates/env.ps1` + `config/templates/env.keys.json` | 本机环境变量（PowerShell dot-source） | 183 / 6 / 183 |

结论行原文：`结论：PASS（5 份模板 / 982 个键全部通过行号命中校验）`（982 = 483+170+48+22+76+183；env 单独一套断言，计入同一次 exit code）。

## 2. checker 的七组断言（`scripts/check-config-templates.mjs`）

1. **文件存在**（:101-102 YAML 侧、:257-258 env 侧）。
2. **keys.json 结构**：`service` 必须等于服务名、`sources` 非空、`keys`/`ignored` 必须是数组（:118-121）；每键必须带 `type`、`source` 形如 `File:line`、`consumed` 是布尔（:151-153）。
3. **键集双向相等**：模板扁平化键集 === keys.json 的 `path` 集合，两侧任一多出即 FAIL（:123-145）；数组下标归一（`instances[0].id` ≡ `instances[].id`，:133），并查重复 path（:141-145）。
4. **`[src:File:line]` 真实命中**：读该行原文，必须包含键名末段（去 `[]`/`()` 后比较），行号越界或源文件不存在都 FAIL（:72-85 判定、:154-157 调用）。
5. **疑似密钥**：64 位 hex / `sk-` / `AKID` / `ark-` 四种模式扫模板原文（:48-53，YAML 侧 :105-108、env 侧 :261-264）。
6. **coverage 算术 + ignored 自证**：`sourceKeys === keys.length + ignored.length`（:206-213），`templatedKeys`/`ignoredKeys` 写了就必须对（:215-219）；每条 ignored 理由 ≥8 字符（:188-193）；`keys` 与 `ignored` 不相交（:196-199），`consumed:false` 必须带 `orphan:true` 或 reason（:200-204）。
7. **`default=` 字面量可查**：在 `[src:]` 行 ±5 行内归一化比对（去引号/下划线/千分位/大小写），找不到且无 `defaultNote` 只 WARN 不 FAIL（:158-185）；`default: "undefined"` 直接 FAIL（:163-166），`required:true`/`default:"unset"`/`default:""` 豁免。

**外加一条「模板可搬运性」（:223-246，本目录最容易漏的一条）**：`list<…>`/`map<…>` 类型的键，模板里必须写成真数组/真对象；任何标量值以 `[`/`{` 开头也判 FAIL（:230-232）。依据 `MemoryCore/src/config.ts:2848-2852` 的 `strArray`——`if (!Array.isArray(v)) return undefined;`，即把 JSON 写进 YAML 标量（`'["a","b"]'`）会被**静默判为未配置并回落缺省**。这类假配置最难查：模板看着配了、运行时等于没配，故必须由脚本拦住。

## 3. 真 loader 差分（checker 覆盖不到的部分）

checker 只验形状与行号，不验「模板喂进真 loader 后得到的对象是否与现状逐位相同」。这部分由 Lead 跑差分得到读数（**本票未复跑**，差分脚本未入库，只复核了支撑锚点）：

- MemoryKnowledge **DIFFS 0**；MemoryPanel **DIFFS 0**；dsh-plugin 配置块 **1748 字节逐位相等**。
- MemoryProxy：pure-default **128** 叶子 → 模板 **161** 叶子，**conflicts 0**、`onlyTpl 35`（全为条件材料化：`wikiRecall.*` 24 / `memCommand.taskDraft.*` 5 等）、`onlyBase 2`（`injection.soulOverlapJournal`、`wikiRecall` 整块在纯缺省下是 `undefined`，属对象形状差异而非键丢失）——读数来自 task-110 的加载器差分，详见 [config-template-memoryproxy.md](config-template-memoryproxy.md) §读数 2。
- MemoryCore：叶子 `374 → 447`，**真冲突 0**；`onlyTpl 73`（模板有、当前生产 yaml 无）、`onlyBase 0`。
- 删键差分：模板去掉键后与现状回落**逐位相同 32/73**；其余 41 个属「条件材料化」——`MemoryCore/src/config.ts:2035-2090` 只在 yaml 显式写了该键时才把对象带出来（整键未写 = undefined = 消费侧缺省），因此由消费者兜底而不会造成差异。
- 抽查两组条件材料化键全一致：skill 组（`MemoryCore/src/core/skill/skill-config.ts:16-29` 注释、:232-237 解析）与反思门组（`MemoryCore/src/core/lifecycle/reflection.ts:276-283`、`MemoryCore/src/core/lifecycle/auto-adopt-gate.ts:63-66`）。

## 4. 已查实的漂移（只登记，本票不修）

| # | 位置 | 事实 | 影响 / 处置 |
|---|---|---|---|
| D1 | `MemoryCore/tdai-gateway.yaml:32`（顶层 `llm:`）+ :40 `maxTokensLimit: 131072` | 该键只被 `memory.llm` 组解析（`MemoryCore/src/config.ts:2739` `const llmGroup = obj(c,"llm")` → :2752 `maxTokensLimit: num(llmGroup,"maxTokensLimit") ?? 131072`，钳制在 llm-runner.ts），gateway 顶层组装只透传 `maxTokens`（`MemoryCore/src/gateway/config.ts:472`） | 配在顶层**不生效**；所幸值 131072 与代码缺省同值 ⇒ 无害。yaml :37-39 已有就地警告注释 |
| D2 | `MemoryCore/tdai-gateway.yaml:84-85` `write.factKey.enabled: true` | 与同块注释 :73-77「全开档 cov −4.6pp（ns）→ **保持关**（生产最优 = 只开 W3）」矛盾 | **待用户拍板**，未改（谁对以 bench 读数为准，#149 记 −2.2pp） |
| D3 | `MemoryProxy/src/config.ts:760-769` | `${VAR}` 展开只对 credential-ish 字段生效（注释原文：only `systemUsers.*` and `tdai.apiKey`），其余字段保留字面量；`admin.apiKey` 不在展开面内 | 模板 11 个占位键里只有 `tdai.apiKey` 会被展开 |
| D4 | `MemoryProxy/src/routes/admin-auth.ts:8` `if (!expected) return "ok";` | 管理口令为空即**全放行** | 模板因此必须把 `admin.apiKey` 保持注释行，禁止写生效值（否则等于发一份公开弱口令模板） |
| D5 | `MemoryKnowledge/.env.example:86`「clamp 1~60」 | 源码 `MemoryKnowledge/src/store/auto-sync-scheduler.ts:54` 实为 `clamp(..., 1, 1440)` | 文档口径落后，只登记 |
| D6 | `MemoryKnowledge/.env.example:38` `LLM_MODEL=Memory-Model` | 与 `MemoryKnowledge/src/config.ts:224` 一致，但 `MemoryKnowledge/docker-compose.yml:41` 写的是 `--llm-model=${LLM_MODEL:-gpt-4o-mini}`（缺省不同厂商不同模型） | 容器路与直跑路缺省不一致，只登记 |
| D7 | `MemoryKnowledge/.env.example` 覆盖面 | 代码侧 46 个 env 名（keys.json 的 `env` 字段去重），.env.example 只列 27 个 ⇒ **19 个未列出**（含 6 个 rerank/llm/embedding 密钥类与 `KNOWLEDGE_SSRF_CHECK`/`KNOWLEDGE_API_TOKEN` 等） | 只登记（票面写「缺 14 键」，实测 19，见 §6） |
| D8 | `config/templates/env.ps1:3-4` 头注 | PowerShell 5.1 **无 BOM 时按 ANSI 解码**中文注释，实测把 `config/templates/env.ps1:66` 的 `\$env:TDAI_MEMORY_SYSTEM_USER_ID` 赋值静默跳过（dot-source 后读到空串） | 文件必须存 UTF-8 with BOM；已写进模板头注 |

## 5. 口径更正记录

- **183 取代 73**：五包环境变量「去重总数」早期粗扫报 73（只数 `process.env.X` 直写），现行口径 **183 = 69 直读 + 117 非直读 − 3 交集**。非直读 117 的来源：MemoryCore 包装函数首参 42、MemoryCore `ENV` 表 21（`(process as any)['e'+'nv']` 静态扫描规避写法）、MemoryKnowledge 包装 33 + `env.` 前缀 5、MemoryPanel 包装 12、MemoryProxy yaml `${VAR}` 渲染名 4。**判据不是「扫到几个」，而是「每条都能命中 consumer path:line」**——checker 的 183/183 命中即该判据的可执行形式。
- `TDAI_DSH_USER_KEY` 属 `config/templates/env.keys.json` 的 `ignored`（liveNow: true）：仓库内 0 字面读点，插件身份走 `~/.dsh/.credentials.yaml` 的 credentials ref，不经 env.ps1。

## 6. 复跑命令与诚实边界

```bash
node scripts/check-config-templates.mjs          # 6 份模板全量：PASS → RC=0，任一键漂移 → RC=1
node docs/ops/scripts/check-ops-index.mjs        # docs/ops 索引双向自检（本文件已入索引）
node scratch/lead/readme-links.cjs               # README 链接校验（Lead 本地脚本；不在仓内则改人工复校 30 条链接）
```

- **§3 的差分读数是 Lead 的运行结果，本票未复跑**；差分脚本未入库，要长期复用需先入库，否则无法回归。
- 漂移里只有 D1/D2 会影响线上行为（D1 无害、D2 待拍板），D3–D8 是文档/模板口径问题。
- 键数随代码漂移：本文件所有数字是 2026-11-01 快照，以 `node scripts/check-config-templates.mjs` 的当次输出为准。
