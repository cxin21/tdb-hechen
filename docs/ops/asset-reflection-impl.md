# task-82 asset-reflection 接入（模块交付版）

> 交付边界按 lead 2026-11-01 指示收窄：`src/asset-reflection.ts` 由我完整实现并自测；
> `src/index.ts` / `src/config-schema.ts` 归 dsh-plugin 独占，我**已把自己先前写进去的改动原样撤回**（现在两文件回到 task-82 之前的状态）；
> `src/writeback.ts` 的剥离段同理交回（下面的补丁是逐行可照抄的）。`src/config.ts` 的四项配置留在我这侧。

## 1. 模块（已完成，319 行）

| 导出 | 位置 | 作用 |
| --- | --- | --- |
| `ASSET_REFLECTION_SECTION_NAME` | src/asset-reflection.ts:33 | section 名 `tdb-agemem:asset-reflection` |
| `REFLECTION_OPEN` / `REFLECTION_CLOSE` | src/asset-reflection.ts:41,43 | 写回剥离的判定标记 `【资产反思】` / `</asset_reflection>`（**writeback.ts 引用这两个**） |
| `ASSET_REFLECTION_MARKER` | src/asset-reflection.ts:44 | 旧名 alias，= REFLECTION_OPEN |
| `hasTriggerToken(text, token)` | src/asset-reflection.ts:57 | 独立 token 判定：前后是词字符/`/`/`-` 不算（`/analysed`、`a/analyse` 不命中） |
| `renderAssetReflectionBlock(maxChars)` | src/asset-reflection.ts:78 | 渲染块；只点 DSH 真实资产（宿主 `skill` 工具 + 插件 `memory_recall`），无 `<skill_tools>`/`<tdai_memory_tools>`；超预算按整行裁且补闭合标签 |
| `stripAssetReflection(text)` | src/asset-reflection.ts:113 | 从 REFLECTION_OPEN 截断 + 去掉尾部 `---`/`***`/空白；只剩反思段时返回 `''` |
| `registerAssetReflectionSection(ctx, deps)` | src/asset-reflection.ts:158 | 只注册 section（`order = 10200 + 102`，`interpolate:false`，`text` 为函数，未触发时返回 `''`）；fail-open |
| `installAssetReflectionTrigger(ctx, handle, deps)` | src/asset-reflection.ts:197 | **append** 挂 `agent/pre-step`：读本 step 认领的用户原文 → `handle.set(alwaysOn \|\| hasTriggerToken(...))`；claim 为空保留上一步决定 |
| `resolveAssetReflectionPolicy(config?)` | src/asset-reflection.ts:282 | 容错解析 `config.assetReflection`（缺段/脏值/空 token/越界都不抛，maxChars 夹到 120–4000） |
| `registerAssetReflection(ctx, config?, log?)` | src/asset-reflection.ts:310 | 一行接线入口：解析 → 注册 section → 挂 trigger；`enabled:false` 时返回空 disposer |

时序契约（实测踩出来的，已写进代码注释）：
1. pre-step hook **必须 append 且在 `installVolatile` 之后**。先前用 `{prepend:true}` 让本 hook 成链头，测试 harness 只驱动第一个 listener ⇒ volatile 注入直接丢，26 个既有用例红。
2. section **必须在 head pack 之前注册**，否则「head pack 是最后注册的 section」这条既有约定（`test/helpers/fake-ctx.ts:96` 的 `sectionText()` 取最后一个；`test/guidance.test.ts:157` 有断言）被破坏。

## 2. 接线（dsh-plugin 侧，两种，推荐 A）

A. 两步（不动任何既有测试；section 保持 head pack 之后）：
```ts
// src/index.ts:578 之前（"// 1. Answer-guidance section" 上方）：
const reflection = registerAssetReflectionSection(ctx, { ...resolveAssetReflectionPolicy(config), log });
disposers.push(() => reflection.dispose());

// src/index.ts:786 之后（volatile 的 if 块结束、">// 4. Turn writeback" 之前）：
disposers.push(installAssetReflectionTrigger(ctx, reflection, { ...resolveAssetReflectionPolicy(config), log }));
```
B. 一行（幂等、更省事，但 section 变成最后注册）：`src/index.ts:786` 后 `disposers.push(registerAssetReflection(ctx, config, log));` —— 需同步把 `test/guidance.test.ts:157` 的「最后一段是 head-pack」断言改成按 name 取，并复核 `test/index.test.ts:403/414/466/499` 的 `sections` 计数（2→3）。

## 3. 写回剥离（dsh-plugin 侧，逐行补丁）

`src/writeback.ts`：
1. 第 1 行加 `import { REFLECTION_OPEN, stripAssetReflection } from './asset-reflection.js';`
2. `INJECTION_TEXT_MARKERS`（src/writeback.ts:202-209）末尾加一项 `REFLECTION_OPEN,` —— 兜底：反思文本万一以 user 消息形态出现也不落 L0
3. src/writeback.ts:430 改成
```ts
const messages = (state?.messages ?? [])
  .map((message) => ({ ...message, content: stripAssetReflection(message.content) }))
  .filter((message) => message.content !== '');
```
清洗必须在 `messages.length === 0` 早退**之前**：只有反思段的 assistant 回合要整条丢弃，不能落一条空壳。

## 4. 配置（我这侧留在 src/config.ts）

- `AssetReflectionConfig`（src/config.ts:207）、字段（:226）、缺省（:332）：`enabled:true / triggerToken:'/analyse' / alwaysOn:false / maxChars:600`；`cloneDefaults`（:424）、`mergeSection`（:466）、空 token 回落（:490）、maxChars 夹取（:494）、字面量（:543）。
- `src/config-schema.ts` 归 dsh-plugin：要露在界面上就加两行 `'assetReflection.enabled'` / `'assetReflection.alwaysOn'` 到 `VOLATILE_PATHS`（原 :81 附近）+ `DESCRIPTIONS` 各一句。不加也能跑，只是界面看不到这两个开关。
- 缺省断言的测试在 `test/config.test.ts:12`（我加的它：缺省四键 + 空 token 回落 + maxChars 夹到 4000）。

## 5. 自测（独立 harness，未依赖 index.ts）

- 新增 `test/asset-reflection.test.ts`（187 行 / 13 例）：块内容与闭合、maxChars 裁剪、token 正负例、policy 容错、section 惰性/order=10302/interpolate=false、token 轮注入→下轮消失、alwaysOn、同一轮后续 step 保留决定、禁用时零注册、disposer 清理、section 注册抛错 fail-open、strip 三段。
- `test/config.test.ts` +1 例（配置缺省/归一化）。
- 读数：`npx tsc -p tsconfig.json --noEmit` = **0 errors**；`npx vitest run` = **22 files / 372 tests 全绿**（基线 21/358，+1 文件 +14 例）；`npm run build` 退出 0。
- 注入/消失的证据是 harness 断言（fake ctx 的 section `text()` 读数），**不是**真宿主 L0 查库 —— 那一步要等写回补丁落地后跑一次真会话。

## 6. 未做 / 风险

1. **L0 剥离未在真库验证**：`stripAssetReflection` 只测了纯函数；真会话「assistant 行不含【资产反思】」要 writeback 补丁合入后查库确认（我改的写回代码已按 lead 指示撤回了）。
2. 反射段与本轮其它注入（volatile/head pack）无协同：若同一轮 volatile 也注入，块里会出现两段「资产」提示，未做去重。
3. `alwaysOn` 只适合评测会话；生产误开会让每轮提示词多 435 字符（`renderAssetReflectionBlock(600)` 实测 435，未触顶），且诱发模型每轮都写复盘。
4. 反思段由模型自述，**不可作为效果证据**（模型会附和）；真评估仍要看工具调用日志。
