# dsh-plugin：soul 注入 + head pack 场景索引去重（task-61）

日期：2026-11-01　范围：`dsh-plugin/src`、`dsh-plugin/test`、`dsh-plugin/README.md`　零 commit。

## 0. 结论三行

| 问题 | 改前 | 改后 |
| --- | --- | --- |
| `/v3/recall` 的 `<soul-identity>`（实测 3343–3388 字符）/`<soul-feeling>`（36–40） | `recallBlockText` 只取 `- [` 行，soul 整段丢弃 | soul 按闭合标签切出，先进注入块首部，`soulChars`/`soulVersion` 进 debug 与 ready 行 |
| `volatile.maxChars` 1200 全给记忆行 | soul 无预算可装（即使切出来也会被 clamp 掉） | 缺省 1500 = soul ≤600 + 记忆 ~900；`soul.enabled:false` 时记忆预算逐位回到旧形态 |
| head pack 场景索引 | persona 尾部 14 条 `- path（热度 N，更新 D）` + 插件再追加 14 条裸 `- path` = 重复 334 字符 / 6.8% | persona 已列的路径不再追加；`- scene_blocks` 标记不破 |

## 1. soul 取料与预算（src/recall-source.ts、src/index.ts）

- `dsh-plugin/src/recall-source.ts:38` 起新增 `SOUL_IDENTITY_OPEN/CLOSE`、`SOUL_FEELING_OPEN/CLOSE`；`:202 extractSoul(block)` 按标签切（缺失/空/未闭合 → undefined，不猜）；`:226 renderSoulBlock(parts,{maxChars,includeFeeling})`；`:258 measureSoul(text)`（缓存命中时只量前缀长度）。
- `renderSoulBlock` 预算顺序：先给 feeling 预留 `min(feeling.length, max(12, floor(limit*0.2)))`，identity 用剩余；每段用既有 `clipEntry` 裁剪，**按 code point 切**（surrogate 不成孤字），超长补 `…`。两段都缺失时返回 `''`，绝不产出空标签对。
- **`includeFeeling` 只有显式 `false` 才丢**（`options.includeFeeling === false`）：配置缺省 true，调用方漏传不该静默掉人格情绪行。
- `dsh-plugin/src/index.ts:671`：recall 成功分支先算 `soulText`（`volatile.soul.enabled` 才渲染），`memoryBudget = max(0, volatile.maxChars - (soulChars ? soulChars+1 : 0))`，`text = soul + 换行 + memories`；`:687 soulVersion: soulVersionOf(result.meta)`（数字 1 → `'1'`，字符串去空）。atomic/search 回落分支 `soulChars: 0` 且**不编造 soul**（core 没给就没有）。
- 注入块总长仍由 `clampBlockByLines(text, volatile.maxChars)` 兜底（`volatile.ts` 不动），所以 soul 再长也压不爆一轮预算。

## 2. 配置（src/config.ts、src/config-schema.ts）

| 键 | 缺省 | 边界 | 位置 |
| --- | --- | --- | --- |
| `volatile.maxChars` | **1500**（原 1200） | 下限沿用既有 clamp | `dsh-plugin/src/config.ts:276` |
| `volatile.soul.enabled` | true | bool | `:277` |
| `volatile.soul.maxChars` | 600 | clamp [100, 3000]（`SOUL_MIN_CHARS/SOUL_MAX_CHARS`，`dsh-plugin/src/config.ts:347`，归一在 `:447`） | 同上 |
| `volatile.soul.includeFeeling` | true | bool | 同上 |

- `cloneDefaults()` 对 volatile 改成深拷贝（`dsh-plugin/src/config.ts:394`），避免测试/热重载之间共享 soul 对象。
- 表单：`dsh-plugin/src/config-schema.ts:75-77` 三个新键进 `VOLATILE_PATHS`（15 → 18），`:99-101` 补描述；`buildPluginConfigSchema` 由 DEFAULT_CONFIG 递归生成，设置页自动出现，无需手写控件。

## 3. head pack 去重（src/index.ts:80、:147-157）

- `personaListsPath(personaText, path)`：逐行 trim，要求行首 `- `、路径命中、且路径后一个字符不属于 `[A-Za-z0-9_./-]`。这条边界规则保证 `scenes/a.md` 不会被 persona 里的 `scenes/a.md.bak` 吞掉（否则真实场景会凭空消失）。
- `composeHeadPack` 在 `slice(0, maxScenarioEntries)` 之后加 `.filter((path) => !personaListsPath(personaText, path))`：persona 已带热度/更新日期的路径不再以裸行重复；persona 没列的路径照旧追加。
- `dsh-plugin/scripts/verify-installed.mjs:113` 的 `MARKERS['head pack scene index'] = '- scene_blocks'` 两种来源都成立，脚本未改。

## 4. 可观测性

- ready 行：`capabilities` 加 `soul=on(600,feeling)|on(600)|off`（`dsh-plugin/src/index.ts:1101`），`timeouts` 加 `volatileChars=<maxChars>`（`:1112`）。只报档位与字符额度，不报正文。
- 每轮 debug（`agemem: volatile block ready|cache`, 由 `installVolatile` 的 getBlock 打印）：新增 `soulChars`（缓存命中用 `measureSoul(cached)` 反推）与 `soulVersion`（仅当 core 给了才出现）。**soul 正文永不进日志**。

## 5. 验收读数（本机实测）

| 命令 | 结果 |
| --- | --- |
| `node ../MemoryCore/node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` | 退出码 0，无输出 |
| `node ../MemoryCore/node_modules/vitest/vitest.mjs run` | **21 files / 353 tests 全绿**（task-61 新增 12 条：`test/recall-source.test.ts` 7 条 soul 用例、`test/index.test.ts` 3 条注入形态 + 2 条去重） |
| `node ../MemoryCore/node_modules/typescript/bin/tsc -p tsconfig.json`（build） | 退出码 0，`dist/recall-source.js` 11498 B / `dist/index.js` 58223 B |

新增测试覆盖的判据：① soul 领先注入块且总长 ≤ `volatile.maxChars`；② `soul.enabled:false` 时块首就是 `【agemem 记忆提示】` 且不含 `<soul-`；③ core 不给 soul 时仍注入记忆、不出空标签；④ 超长 identity 按 code point 裁到 ≤ 预算且 `isWellFormed()`；⑤ persona 已列的路径只出现一次、未列的仍追加、`.bak` 不吞 `.md`。

## 6. 偏差与诚实边界

1. **未装 desktop**：本轮只做源码 + 单测 + build，`~/.dsh/profiles/desktop` 未触碰（安装由 Lead 执行）；因此「live `/v3/recall` 的 soul 正文进真实提示词」只有单测与 fixture 证据，**没有新一轮 headless/真机读数**（headless 预算早已用尽）。
2. `volatile.maxChars` 缺省从 1200 提到 1500 是**可见行为变化**：关 soul 的旧配置若显式写了 1200 保持不变，未写的人会多拿到约 300 字符记忆预算。票面已批准，README 与设置页描述同步写明「(soul and memories together)」。
3. 缓存命中路径的 `soulChars` 是**反推值**（`measureSoul` 量块首前缀），若将来块首再加前缀段，这个读数会偏小；不影响注入内容。
4. `test/client-bundle.test.ts` 曾因 task-57 的 WIP（`client/client.js`、`cordis.bundle.yml`）在本票期间红过 10 条，recall-core 01:16 落定后已复绿；本票未改该文件。

## 7. 复现

```bash
cd /d/TDB/td-agemem/dsh-plugin
node ../MemoryCore/node_modules/vitest/vitest.mjs run test/recall-source.test.ts test/index.test.ts
node ../MemoryCore/node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
```

装到 profile（Lead 执行）：`bash dsh-plugin/scripts/deploy.sh --profile desktop`，随后看 `~/.dsh/agemem/agemem.log` 里 `agemem: ready` 的 `soul=on(600,feeling)` 与每轮 debug 的 `soulChars`/`soulVersion`。