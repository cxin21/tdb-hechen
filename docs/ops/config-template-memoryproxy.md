# MemoryProxy 配置模板（task-110）

## 交付物（未 commit、未改源码）

| 文件 | 规模 | 说明 |
|---|---|---|
| `config/templates/memoryproxy.yaml` | 233 行 / 27 段 / 170 键 | 每键 `key: value   # <类型> default=<缺省> [src:file:line] · 说明`；数组示例全部注释掉 |
| `config/templates/memoryproxy.keys.json` | 170 keys + 2 ignored + coverage | 按 `config/SPEC.md` §3；3 个 `list<map>` 用自定义字段 `elementFields` 记元素字段（见下「数组口径」） |
| `scratch/task-110/render3.mjs` | 生成器 | 读 keys-a/keys-b.json，从 `DEFAULT_CONFIG`/`DEFAULT_SOUL_TIMING`/`DEFAULT_WIKI_RECALL_CONFIG` 解析缺省后渲染 |
| `scratch/task-110/proxy-tpl-load.mts` | 加载器差分 | 对 `buildConfig()` 跑纯缺省 vs 模板，逐叶子比（lead 的 `scratch/lead/proxy-tpl-load2.mts` 同构，仅换输出路径） |

## 读数 1：checker（`node scripts/check-config-templates.mjs`，2026-11-01 07:1x）

```
OK MemoryCore 483/12 | OK MemoryProxy 170/2（行号命中 170）| OK MemoryKnowledge 48/2
OK MemoryPanel 22/4 | OK dsh-plugin 76/0 | OK env.ps1 183/6
结论：PASS（5 份模板 / 982 个键全部通过行号命中校验）—— WARN 0
```

## 读数 2：加载器差分（`scratch/task-110/proxy-tpl-load.mts`，同一 buildConfig 双跑）

`pure-default leaves 128 | template leaves 161`；**onlyTpl 35 | conflicts 0 | onlyBase 2**。

- `conflicts 0`：模板里每个「生效值」都与源码缺省逐字相同，不再有占位符被当密钥、示例数据被当生效行。
- `onlyTpl 35` 全部是**条件材料化**：不写该段时整块 `undefined`，写了才出现（值取自源码兜底，逐键 `defaultNote` 已标 consumer 行号）。分布：`wikiRecall.*` 24（含 `typeWeights.` 7、`domainRouter.` 2）、`injection.soulTiming.reanchor.intervalTurns` / `redlineCadence.mode` / `.depthOverflow` / `.riskToolPatterns`、`injection.toolCapabilities.enabled`、`memCommand.taskDraft.*` 5、`injection.soulOverlapJournal.*` 2。
- `onlyBase 2` = `injection.soulOverlapJournal`、`wikiRecall` **整块**在纯缺省下是 `undefined`，属于对象形状差异，不是键丢失。

## 读数 3：真实配置漂移（`scratch/task-110/stats.mjs`）

live `D:/TDB/etc/proxy-config.yaml` 128 键、`MemoryProxy/config.example.yaml` 118 键、`deploy/tencent-cloud/config/proxy/proxy-config.cloud.example.yaml` 129 键：三份的 **yamlOnly 全为 0**（没有模板未登记的未知键）；模板多出的 42/41 键是「源码有解析、现网未配」的缺省位。

## 本轮修掉的 4 类真问题（lead 加载器实测）

1. **占位符误用（最重）**：11 个敏感键不再写 `${ENV}` 生效值。`config.ts:760-769` 的 `expandEnv` 只作用于 `systemUsers.*` 与 `tdai.apiKey`，其余字段直接 `--config` 加载时**保留字面量**。现在：10 个键值留空串（=源码缺省）+ 注释写明「留空=未配置；走部署链可在本行写 ${VAR}，由 ps1 渲染」；`tdai.apiKey` 写源码缺省 `local-proxy`（它会被 expandEnv 展开，注释说明连远端时改 `${TDAI_GATEWAY_API_KEY}`）。
   - 我实测补一条边界：部署链 `D:/TDB/etc/tdb-services.common.ps1:33-58` `New-TdbRuntimeConfig` 是对**整份 yaml 文本**做变量替换后写运行时副本，所以「yaml 里写 ${TDAI_LLM_API_KEY}」在 ps1 路径下确实会被替换（现网 live 配置正是这么写的）。两条路径行为不同，模板按「直接加载也安全」取空值，注释两头都写明。
2. **admin.apiKey 空值的真实后果**：`MemoryProxy/src/routes/admin-auth.ts:8` `if (!expected) return "ok"` ⇒ 该键为空 = **管理面无鉴权**。模板留空（=源码缺省）但注释改成告警式：生产必须设环境变量 `TDAI_PROXY_ADMIN_API_KEY`（`config.ts:713-718` 的 env 兜底，优先级高于本键）；勿写 `${PROXY_ADMIN_API_KEY}`（直接加载不展开，会成公开字面量密钥）。
3. **示例数据不再生效**：`creditPricing.models` / `appraisal.values` / `systemUsers` 一律渲染成 `[]`，示例元素改为 `#` 注释块（避免照抄后每条计费为 0、往评价口径塞伪造项、或生成假服务账号）。`systemUsers.userId` 空串会被 `config.ts:711` 过滤；元素字段说明在 keys.json 的 `elementFields`。
4. **`injection.soulOverlapJournal.file` 不再是裸空值**：给示例路径 `D:/TDB/data/proxy/soul-overlap.jsonl`，注释写明「源码要求非空字符串（`config.ts:546-550`），空串会被解析成 undefined；enabled=false 时不写文件」。

## 数组口径（与 checker 对齐）

checker 的 `flattenKeys` 把数组整体当叶子 ⇒ `creditPricing.models[].name` 这类元素路径永远匹配不上。模板只登记父键（`creditPricing.models` / `appraisal.values` / `systemUsers`，type `list<map>`），元素字段放 keys.json 的自定义 `elementFields`（checker 不校验未知字段）。

## 条件材料化键的 defaultNote 台账（消费者行号）

- `wikiRecall.*`：整段存在才材料化（`config.ts:652`）；数值兜底在 `config.ts:653-682`，缺省表 `DEFAULT_WIKI_RECALL_CONFIG` 在 `MemoryProxy/src/injection/injectors/wiki-recall-injector.ts:39-52`（`typeWeights` 在 :43、`domainRouter` :50-52）。
- `injection.soulTiming.reanchor.intervalTurns`（20，clamp [1,200]）与 `redlineCadence.*`（mode / depthOverflow 8 / riskToolPatterns []）：`config.ts:281-304` 分支内兜底。
- `injection.toolCapabilities.enabled`：解析层仅显式布尔采纳（`config.ts:337`），生效缺省 true 在 `MemoryProxy/src/injection/index.ts:466` 与 `injection/injectors/tdai-l1-recall-injector.ts:78-82`。
- `memCommand.taskDraft.*`：段存在才材料化（`config.ts:730-733`，timeoutMs 兜底 20000 在 :738）。
- `redis.injectionTtlSeconds` / `storage.cos.endpointDomain` / `costGuard.anthropicUpstream.url` / `injection.externalGatewayUrl` / `wikiRecall` 的 6 个可选门：源码无缺省（`?? undefined`），模板留空 + note 说明「留空=undefined（不配）」。

## 诚实边界

- 实测：checker 读数、加载器差分三数（同一 buildConfig 双跑）、live/两份 example 的 yamlOnly=0、`admin-auth.ts` 空 expected 即 ok、`expandEnv` 的作用域、ps1 的整文本替换。
- 读码未实测：`wikiRecall` 各兜底值是否与 `defaultWikiRecallConfig` 完全等价（只逐值比对文本，未跑注入器）；`creditPricing`/`appraisal` 示例改为 `[]` 后对现网计费的影响（现网 live 未配这两段）。
- 未做：真渲染 `proxy-config.runtime.yaml` 后与 live 机器比对（`D:/TDB/data/run/` 当前无该文件）；未启动 proxy 验证。
- 看板无 task-110（claim 不到该号），产物按 lead m02613/m02964 交付。
