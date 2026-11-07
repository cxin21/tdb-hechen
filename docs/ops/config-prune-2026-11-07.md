# 配置项裁剪记录（2026-11-07）

一次「该删的删掉、删掉的在代码写死」的收口。判定沿用 [配置项裁决四问](../ops/config-default-ledger.md) 的同一条思路：
**该不该有**看四问（两种环境都要跑吗 / 数值必须实测反推吗 / 关掉能否退回旧行为 / 是不是凭据），
**能不能删**只认一件事 —— 删掉之后**行为必须逐位等价**，证据是「零消费点」或「消费点只有一个常量来源」。

> 结论先行：两轮共删 **8 个配置键 + 2 个死模板键**（代码面 6 处），并顺手修好了**模板校验门禁本身的长期失准**（修复前 FAIL 106/688，修复后 PASS 725/725，见 §7）。没有做「弱证据键（占比约 45%）」和「131 条双口径」的全量清理 —— 那两类需要逐键点开复核，见 §5。

## §1 删除并在代码写死（行为等价）

| # | 键 | 消费点真相 | 处理 |
|---|---|---|---|
| 1 | `report`（整组：`enabled`/`outputPath` 等） | `initReporter()` 全仓库零调用点（定义 `MemoryCore/src/core/report/reporter.ts:19`，`report()` 恒 no-op）；`cfg.report`、`.report.enabled` grep = 0 | 删 `ReportConfig` 接口（原 `MemoryCore/src/config.ts:1313-1318`）、`MemoryConfig.report` 字段（原 `:1457`）、解析块（原 `:2992-2995`）；就地留墓碑 |
| 2 | `skill.storeBackend` | `MemoryCore/src/core/skill/skill-config.ts:76` 早已 `const storeBackend: "sqlite" = "sqlite"`，输入恒被覆盖；`SkillConfigInput` 由 `MemoryCore/src/gateway/config.ts:438` 直接 cast yaml | 删 `MemoryCore/src/core/skill/types.ts:19-20` 的输入字段；三套 yaml 的 skill 段删该行并注明「已写死」 |
| 3 | `writeback.maxMessagesPerRequest`（dsh-plugin） | 真孤儿（见 [config-key-consumption-audit.md](./config-key-consumption-audit.md) §1.3）。实际分片在 `dsh-plugin/src/wire-limits.ts:208 chunkMessages()`，用它自己的 `CORE_MAX_MESSAGES_PER_REQUEST = 100`（`wire-limits.ts:30`）；`memory-client.ts:979` 的 `maxCount` 也传同一常量 | 删类型（`dsh-plugin/src/config.ts:258-263`）、`DEFAULT`（`:562`）、clamp（`:897-902`）与随之无用的 import（`:30`） |
| 4 | `headPack.maxScenarioEntries`（dsh-plugin） | 唯一调用方 `dsh-plugin/src/segments/persona.ts:30-35` 从不传该选项 ⇒ 生效值恒 `?? 20` | 删类型（`dsh-plugin/src/config.ts:129-134`）与 `DEFAULT`（`:489`）；在 `dsh-plugin/src/head-pack-compose.ts` 加 `HEAD_PACK_MAX_SCENARIO_ENTRIES = 20` 顶替原 `:57`，并从 `ComposeHeadPackOptions` 摘掉该字段 |
| 5 | `capture.enabled` | `grep capture\.enabled` = 0；capture 组唯一消费点是 `MemoryCore/src/gateway/server.ts:520` 的 `memory.capture.excludeAgents`。该键默认 true 但**没有任何地方拿它做判断** | 删 `CaptureConfig.enabled`（`MemoryCore/src/config.ts:38-39`）与解析（`:2264`）。墓碑写清：采集是写侧主链路，当前**没有关掉它的路径**；将来要做开关，先接 `auto-capture` 入口再恢复键 |

`capture` 组其余四键全部保留，均证实有消费：`excludeAgents`（`gateway/server.ts:520` → `SessionFilter`）、`l0l1RetentionDays`（`:1538` 归一化后经 `memoryCleanup.retentionDays` 进 `utils/memory-cleaner.ts`）、`allowAggressiveCleanup`（`:1539` 放开 <3 天的保留期）、`cleanTime`（`:1633` → `memory-cleaner.ts:191 nextRunAt`）。

## §2 判定保留（看着像死键，其实不能删）

- **`storeBackend`（主配置）** —— 取值域只有 `"sqlite"`（`MemoryCore/src/config.ts:1310`），但 `MemoryCore/src/core/store/factory.ts:77 assertStoreBackendSupported` 是**退场守卫**：写成别的值会在启动时抛错，而不是静默退化成某种存储。删键会把「明确拒绝」变成「无从表达」。保留，并在模板里注明唯一取值与守卫位置。
- **`llm.provider`** —— `MemoryCore/src/config.ts:2998-2999` 已是 `const provider: "openai" = "openai"`，键实际已写死，不需要再动一次（再删只会让文档与代码多点漂移）。
- **`assetReflection.*` 4 键** —— `registerAssetReflection`（`dsh-plugin/src/asset-reflection.ts:310-318`）在 `src/` 零调用点，属「待接线」而非「废弃」；删键会断掉未来接线路径，保留并在审计文档 §1.4 标注。
- **`prompts.mode`** —— `MemoryCore/src/config.ts:1532` 是顶层 `promptMode` 的 fallback alias，仍生效。
- **`memory.capture.allowAggressiveCleanup`** —— 在 inventory 里被标为「仅解析点」，但解析结果 `retentionDays` 会被消费（`:1541-1550` → `memoryCleanup` → `memory-cleaner`），是 loader 内部键，不是死键。

## §3 配置模板与注释同步

- 三套 yaml（`deploy/tencent-cloud/config/core/tdai-gateway.cloud.yaml`、`deploy/global-images/tdai-gateway.base.yaml`、本地 `MemoryCore/tdai-gateway.yaml`）：删 skill 段 `storeBackend`；主 `storeBackend` 行补注释「唯一取值 sqlite，消费/守卫在 core/store/factory.ts:77」；订正本地 yaml 里「云端生产选项为 TCVDB」的过期说法。
- `deploy/tencent-cloud/config/config-override.example.json`：`_comment` 重写 —— 优先级（Admin override > yaml > `TDAI_LLM_*` env）、加载点 `MemoryCore/src/gateway/settings-override.ts:132`、**支持段清单 11 段**（`:115-127`：llm / embedding / rerank / importancePenalty / worthiness / extraction / layerRuler / injection / recall / persona / lifecycle），原文「仅支持 llm/embedding 两段」是过期说法。
- `dsh-plugin/README.md`：`:93-94` 去掉 `maxMessagesPerRequest` 并注明写死位置；`:120` 段改写为「分批条数写死 `CORE_MAX_MESSAGES_PER_REQUEST`（`src/wire-limits.ts:30`）」。
- 测试同步：`dsh-plugin/test/config.test.ts:238-260` 去掉批次断言、新增 `expect('maxMessagesPerRequest' in config.writeback).toBe(false)`；`dsh-plugin/test/index.test.ts:730` 去参数、`:1528-1536` 改为喂 25 条验证 20 上限（s19 在、s20 不在）。

## §4 门禁（本机实测）

| 门禁 | 命令（工作目录） | 结果 |
|---|---|---|
| typecheck 基线 | `npm run typecheck:gate`（MemoryCore） | **PASS**，148 errors / 28 files，基线 149/28，**Δ=-1** |
| 配置单测 | `npx vitest run src/config`（MemoryCore） | 23 文件 / 152 用例 **全过** |
| 插件类型 | `npx tsc -p tsconfig.json --noEmit`（dsh-plugin） | EXIT=0 |
| 插件全量 | `npx vitest run`（dsh-plugin） | 45 文件 / 748 用例 **全过** |
| 三套配置一致性 | `node deploy/global-images/check-config-consistency.mjs` | **PASS**：白名单外零差异、9 个防漂移钉同值、238 决策叶键中 229 依赖行内注释 |
| 模板校验（第二轮修复后） | `node scripts/check-config-templates.mjs` | **PASS**：4 份模板 / 725 个键行号全命中（修复前 FAIL，106/688） |
| 配置 + skill 单测（第二轮删除后复跑） | `npx vitest run src/config src/core/skill`（MemoryCore） | 27 文件 / 182 用例 **全过** |

基线里那 `Δ=-1` 是删 `capture.enabled`/`report` 带来的**减少**，未执行 `--update` 收紧基线 —— 收紧是独立决定，需人工确认。

## §5 未处理面（本轮明确不做）

1. **459 条「弱」证据键**（占清单 45%）：证据只到「叶子名在文件里出现过」，同名键会串。逐键复核需要按行打开消费点，本轮只处理了证据链完整的那几处。
2. **131 条同一件事双口径**（yaml + 环境变量）：不是死键，是**优先级问题**（env 覆盖 yaml 会静默改行为，典型如 `TDAI_GATEWAY_PORT`）。这类要的是口径收敛与告警，不是删除。
3. **149 条代码内写死常量**：清单只覆盖 `_scan-files.txt` 的 3399 个文件，且混入 `.eval-data/`，不是全仓库穷尽。
4. **`assetReflection.*` 接线**：属功能未完成，不在配置裁剪范围。

## §6 复跑方式

```bash
cd MemoryCore && npm run typecheck:gate && npx vitest run src/config
cd ../dsh-plugin && npx tsc -p tsconfig.json --noEmit && npx vitest run
cd .. && node deploy/global-images/check-config-consistency.mjs
node scripts/check-config-templates.mjs
```

> 改过 `MemoryCore/src/config.ts`、`gateway/config.ts`、`core/skill/skill-config.ts` 或 `dsh-plugin/src/config.ts` 的任何行之后，模板行号会整体位移 ⇒ 先跑 `check-config-templates.mjs`，红则用 `D:/TDB/.scratch/prune2/reanchor.mjs`（dry-run 默认，`--apply` 才写）重锚。

清单与证据来源（Excel）见 `D:/TDB/.scratch/cfg-inventory/td-agemem-配置项.xlsx`（1030 行，4 sheet）。

## §7 第二轮：再删一处 + 模板门禁的长期失准（2026-11-07 下午）

### 7.1 删除 `scanner.instancesSharkUrl`

| 键 | 消费点真相 | 处理 |
|---|---|---|
| `scanner.instancesSharkUrl`（env `SCANNER_INSTANCES_SHARK_URL`） | `MemoryCore/src/gateway/config.ts:51` 只有类型声明、`:491` 只有解析，**全仓库零消费点**（含 dsh-plugin / panel / knowledge） | 删声明与解析两行，就地留墓碑；`config/templates/memorycore.yaml:82`、`memorycore.keys.json`、`env.ps1:74`、`env.keys.json:377` 同步删除 |

同日更正一条早前误述：三套部署 yaml **从未包含该键**，它只存在于 `config/templates/`；「yaml 注释说配了会覆盖 instances」是模板里的假文档，随删除一并消失。`scanner.nodeId` 保留 —— `services/timer-scanner.ts:79/89/102` 真实消费。

### 7.2 模板里 3 个死键（源码已删、模板还教人配）

- `memory.recall.sensitivityPenalty`、`memory.lifecycle.forgetting.sensitivityBias`：源码 2026-11-04 已删两个 0 值死乘子（`core/store/soul-columns.ts:17`、`core/recall/sensitivity-policy.ts:5-6`、`core/lifecycle/forgetting/scorer.ts:187`），`core/sensitivity-d3.test.ts:58` 明确「遗留 sensitivityBias 配置键不再有任何效果」。配置里写了不降分、也不报错。
- `dsh-plugin paths.conversationDelete`：src 零读取点（`docs/ops/dsh-specialization-dsh-plugin.md:65` 记录 sre 调用 0、test 1）。
- 另在模板里发现 **`report` 整组仍在**（第一轮只删了源码）：`report.enabled` 锚到 `config.ts:2534`（实为 `selfNarration.enabled`）、`report.type` 锚到 `:2617`（`typeof` 子串命中）——两条都是**假锚点靠子串校验蒙过去**。
- 处理：全部从模板 YAML 删除，移入 `keys.json.ignored[]` 并写 ≥8 字理由（含 `removedFromTemplateAt`）。

### 7.3 模板校验器为什么一直是红的

`scripts/check-config-templates.mjs` 是 `config/SPEC.md` 的执行体，断言：模板键集 === `keys.json`、每键 `[src:File:line]` 的该行**必须包含键名末段**、`sourceKeys = keys + ignored` 算术自洽、疑似密钥扫描。模板是**手工维护 + 硬编码行号**，源码一改就整体漂移。

| 修复前 | 命中 |
|---|---|
| MemoryCore | 7/403 |
| MemoryKnowledge | 9/46 |
| MemoryPanel | 18/18 |
| dsh-plugin | 0/98 |
| env.ps1 | 51/123 |
| 合计 | **106/688，另有 37 个模板键未登记** |

### 7.4 重锚方法与实测

脚本 `D:/TDB/.scratch/prune2/reanchor.mjs`（node，默认 dry-run，`--apply` 才写）：

1. `pickLine` 在源文件内按 leaf 打分（带引号=3、`key:`/`key=` 开头=2、子串=1、注释行 −2），取最高分且离旧行号最近者；
2. `mapTemplateKeys` 按缩进建 `path → 行号` 映射，支持数组项（`父path[].key`）；
3. 模板头缺「行号：[src:NN] 指 X」时，用 `keys.json` 多数 source 文件兜底；
4. 模板有、`keys.json` 无的键按行内注释 `# <type> default=<v>` 解析后补登。

实测（MemoryCore）：unique 命中 297 / nearest 265 / unresolved 15；行号位移直方图 d0=199、d10=32、**d90=263**（证实漂移量级约 90 行）。环境变量侧重锚 61 个消费点、`env.ps1` 120 行「消费:」注释同步；`coverage.sourceKeys` 130→129、`templatedKeys` 124→123 改回算术自洽。

最终：**PASS 725/725**（MemoryCore 441+8、Knowledge 46+2、Panel 18+4、dsh-plugin 97+1、env 123+6）。

### 7.5 锚点可信度的诚实边界

校验器只认「该行包含键名末段」，所以**行号命中等 ≠ 锚点语义正确**（`report.type` 就是被 `typeof` 蒙过的）。另跑了一条更严的自检：末段必须是独立标识符，且（行内含引号键名 或 ±10 行内出现父组名/父组变量）。结果 MemoryCore 441 条里 17 条被标记，全部是 `soulMaintenance.budget|maxItems|maxItemChars` 的分层键 —— 父组名 `maxItems` 不在窗口内，但锚点落在 `core/soul/types.ts:311-330` 的 `layerMaxItems/layerItemChars` 对象字面量内，按缩进归属可证正确（已逐条人工确认）。**除这 17 条外，其余锚点通过严格自检。**

### 7.6 自伤事故记录（改模板 YAML 的教训）

删行时 `old_string` 缩进写少 2 空格，匹配到**行中间**，把后一行前缀吞并：`importancePenalty` 变 6 空格、`lowThreshold` 变 10 空格，YAML 报 `All mapping items must start at the same column at line 200/509`。已按 HEAD 原始缩进修复。教训：**改 YAML 必须用完整行（含真实缩进）匹配**，改完立刻 `yaml.parse` 一次。

## §8 本轮之后的配置面口径

| 口径 | 数量 |
|---|---|
| 盘点清单（跨来源并集，非可达去重数） | 1024 条 |
| MemoryCore 模板键（去重后仍在用） | 441 |
| MemoryCore 模板 ignored（写了不生效/已删） | 8 |
| env.ps1 环境变量 | 123 |
| dsh-plugin 配置面 | 74（设置页可见 25+2 secret） |
| 生产 yaml 决策叶键 | 云模板/base 各 254、本地 305 |
| 已删配置键（两轮） | 8（report.enabled、report.type、capture.enabled、skill.storeBackend、writeback.maxMessagesPerRequest、headPack.maxScenarioEntries、scanner.instancesSharkUrl + 模板侧 paths.conversationDelete） |

`§5` 的三类未处理面不变。本轮没有碰 `assetReflection.*`、没有收敛 env/yaml 双口径、没有动凭据类键。
