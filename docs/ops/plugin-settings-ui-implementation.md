# 插件设置页实现记录（tdb-agemem-dsh，档 2：宿主设置页可改配置）

回答一件事：`@tdb/agemem-dsh` 的配置能不能在 DeepSeek Harness 设置页里改、写回落到哪、重跑部署会不会被抹掉。结论都带可复跑命令与读数原文；没验的见 §8。前置分析见 `docs/ops/plugin-config-ui-feasibility.md`。

## 1. 结论
1. **能**：插件 `export { Config }`（Schemastery 图），宿主 `dsh-settings` 投影成表单，写回 profile 的 patch 文件。
2. **写回 = 追加一行 override，整块替换、后行胜**；deploy 写在 `insert:` 里的 config 只是基线。
3. **deploy 重跑曾会静默抹掉用户 override**（真 bug，已修）：旧 `upsertManaged` 把管理块 strip 后追加到 EOF，越过了 override 行。
4. **`@deepseek-ai/schemastery` 必须声明成 dependency**，否则非 desktop profile 里 `ERR_MODULE_NOT_FOUND`（已加，实装 3.18.5）。
5. 打包缺 `client/`、`cordis.bundle.yml` 会被判 partial 并整包回滚（已改成按 `files[]` 打包）。

## 2. 落地的四个面
| 面 | 位置 | 作用 |
|---|---|---|
| 配置形状（纯逻辑，可单测） | `dsh-plugin/src/config-schema.ts` | `VOLATILE_PATHS`(18) / `SECRET_PATHS`(2) / `DESCRIPTIONS` / `buildPluginConfigSchema()` |
| Schemastery 绑定（唯一 import 点） | `dsh-plugin/src/config-schema.host.ts:15-19` | `import z from '@deepseek-ai/schemastery'` + `export const Config` |
| 宿主入口导出 | `dsh-plugin/src/index.ts`（apply 之后） | `export { Config } from './config-schema.host.js';` |
| 浏览器半包 | `dsh-plugin/client/client.js` | `ctx.configForms.get(ENTRY_ID)` + `plugins.item` 槽 + `ctx.remote.credentials` 写 secret 引用 |

宿主契约：`dsh-settings/lib/index.js:539-540` 的 `schema(entry)` 读 `entry.fiber.runtime.Config`；无 volatile 字段时 `:506` 抛 `has no volatile fields`、`:418` 跳过该 entry（设置页就没有这一项）。

## 3. ① 配置面（实测 58 叶子 / 18 volatile / 2 secret）
```bash
node --input-type=module -e "
const m = await import('file:///C:/Users/Administrator/.dsh/profiles/settingsprobe/node_modules/@tdb/agemem-dsh/dist/index.js');
const S=Symbol.for('schemastery'); const out=[];
(function walk(n,p){if(n&&n.dict){for(const[k,v]of Object.entries(n.dict))walk(v,p?p+'.'+k:k);return;}out.push({p,v:!!n.meta?.volatile,r:n.meta?.role??null});})(m.Config,'');
console.log('type='+m.Config.type,'native='+(m.Config[S]===true),'leaves='+out.length,'volatile='+out.filter(x=>x.v).length);"
```
读数原文：`type=object native=true leaves=58 volatile=18 secret=2`。

- **58 = `DEFAULT_CONFIG` 的 58**（两棵树同规则 walk，差集为空）⇒ 代码读的每个键都在图里。
- **表单只投影 18 条 volatile**（`dsh-settings/lib/index.js:123`：`if (schema.meta.volatile) return plainSchema(schema)`，非 volatile 叶子不进表单）：`enabled, server.baseUrl, server.serviceId, server.teamId, server.agentId, server.userId, server.apiKeyRef, server.userKeyRef, writeback.enabled, writeback.skillFeed, volatile.enabled, volatile.maxChars, volatile.soul.{enabled,maxChars,includeFeeling}, tools.enabled, tools.recall, debug`。
- 对照可行性 §4「必须暴露 16」：**15/16 在表单里**；缺的那条是 `server.userKey`（secret，只走 credentials store，表单里给的是 `server.userKeyRef`）。多出 3 条 `volatile.soul.*`。
- **40 条非 volatile 不进表单**：`server.apiKey`/`server.userKey`（secret）、`server.requestTimeoutMs`、`paths.*`×11、`headPack.*`×9、`volatile.{timeoutMs,recall,recallMaxResults}`、`writeback.{outboxPath,maxAttempts,retryMs,maxMessageChars,maxMessagesPerRequest,maxRequestBytes,maxOutboxEntries,maxOutboxBytes}`、`tools.recallTopK`、`assetReflection.{enabled,triggerToken,alwaysOn,maxChars}`、`debugLogFile`。与可行性 B/C 档一致，**例外是 `assetReflection.*` 4 条**（改的是喂模型的输入，属可调），task-82 曾把它加进 volatile（当时 20 条）后一小时内回退，本文件按回退后的 18 条记。
- 叶子一律 `z.any().default(v)`：类型不校验，写错不抛，由 `resolvePluginConfig` 归一——这也是宿主 projector 不因我们 schema 报错的原因。
- 宿主硬约束：volatile 必须在固定对象路径、且不能嵌套在 volatile 里（`scratch/probe-ui/host/dsh-app-boot/lib/index.js:2611`）⇒ `volatile.soul.*` 各自标 volatile，`volatile` 对象本身不标。原生图判据同文件 `:2447-2451`：`Symbol.for('schemastery')===true && typeof type==='string' && meta 是对象`。

## 4. ② 设置页写回与 deploy 的共存（实测，含一个已修真 bug）
profile 的 patch 文件 = `~/.dsh/profiles/<name>/cordis.patch.yml`（`dsh-config-editor/lib/index.js:24-26`）。实测长这样：
```text
4:# >>> tdb-agemem-dsh managed block (scripts/deploy.sh) — do not edit by hand
5:- insert:
6:    - id: tdb-agemem-dsh
16:# <<< tdb-agemem-dsh managed block
17:- id: tdb-agemem-dsh
20:    debug: true
```
4-16 是 deploy 写的 insert 管理块（带 `server.baseUrl` 与三元组身份），17-20 是设置页写的 override 行。

**查找目标行**（`dsh-config-editor/lib/index.js:98`）：
```js
document.contents.items.findLastIndex((item, index) => isMap(item) && document.getIn([index, "id"]) === entry.options.id && !item.has("insert") && (!item.has("name") || document.getIn([index, "name"]) === entry.options.name))
```
我们的行在 `insert:` 里 ⇒ `!item.has("insert")` 永不成立 ⇒ `index<0` ⇒ `:105-109` `document.add({id,name,config:next})` **追加到 EOF**。保存时 `current = structuredClone(entry.options.config ?? {})`（`:77`）后写整份 config。

**实测语义**：追加 override（`debug: true` + `volatile.maxChars: 1600`）后 `--dump-config` 生效值 = override 行，insert 块 config 不参与合并；两行**合成一个 entry**（`--dump-config | grep -c 'id: tdb-agemem-dsh'` = `1`），无重复 id 告警。危险的是 `cordis.bundle.yml` 里写同 id 的 insert（`dsh-app-boot` 追加 insert 不去重，`dsh-config-editor` 只列 id 唯一出现的 entry）⇒ 该文件**保持空数组**只作声明。

**已修真 bug**：旧 `upsertManaged()` 把管理块 strip 后追加到 EOF ⇒ deploy2 后管理块从第 4 行跑到第 17 行（越过 override），生效值回到部署基线；且下一次设置页保存会撞 `:122` `is overridden by a home patch or command-line overlay`。修复（`dsh-plugin/scripts/patch-util.mjs`）：已有 BEGIN/END 就**原地替换该区间**，没有再 strip 后追加。复验：patch 重置 `[]` → deploy1 → 追加设置行 → dump `debug: true`/`maxChars: 1600` → deploy2 → 管理块**仍在第 4 行**、设置行仍在 17 行 → dump 生效值**仍是** override。单测 `test/patch-util.test.ts` 新增 `re-deploy keeps the managed region in place so later patch rows still win`。

**三方案与选型**：① override 优先 + deploy 只保证不越过它（**选中**）：改动面在 `patch-util.mjs` 一处，语义由 loader「后者胜」天然给出，identity 基线仍在 insert 块里可读；② 把 `server.*` 全迁到 override（设置页首次保存前插件是 inert 的，必须再引入一个「首次写入」步骤，反而多一条失败路径）；③ 设置页只写专用文件（要 fork `dsh-config-editor`，超出本票范围）。选①的理由：现状只差「deploy 别越过 override」这一条，而这一条已实测能修。

**schemastery 必须声明依赖**：CLI 建的 profile（`web`/`settingsprobe`）的 `node_modules/@deepseek-ai` 是空的，只有 `desktop` 有 `cosmokit`+`schemastery` ⇒ 静态 import 在非 desktop profile 直接 `ERR_MODULE_NOT_FOUND`。照官方范本 `dsh-free-search` 的 `dependencies:{"@deepseek-ai/schemastery":"^3.18.4"}` 已加；重跑 deploy 后 pnpm 装上 `cosmokit`+`schemastery`（实装 **3.18.5**，与 desktop 一致）。

## 5. ③ 浏览器半包（`dsh-plugin/client/client.js`，619 行）
- `const card = new AgememFormController(ctx.configForms.get(ENTRY_ID), ctx)`（`:598`），`inject` = `["slots","locale","remote","remote.credentials","configForms"]`（`:588`）；
- 注册：`ctx.effect(() => ctx.configForms.whileServed([ENTRY_ID], () => ctx.slots.inject("plugins.item", …)))`（`:603-604`）；
- 保存：`save: () => this.save()`（`:425`，返回 promise 供宿主 await；`:337` 先写 dirty 字段再写暂存 secret）；
- **secret 只写引用**：`await this.ctx.remote.credentials.set(this.refOf(secret), text)`（`:376`），表单只有 `apiKeyRef`/`userKeyRef`，明文既不回读也不入 patch。
- 单测：`test/client-bundle.test.ts`（22 例，含 7 个开关的 id/Switch 断言）、`test/config-schema.test.ts`（12 例）。

## 6. ⑤ 真装真跑（隔离 profile；没碰 desktop，没重启用户 GUI）
```bash
dsh.cmd settingsprobe --from-default-profile web --dump-config     # 建 profile，不启服务
cd dsh-plugin && DSH_PROFILE=settingsprobe bash scripts/deploy.sh --skip-tests --no-store-key \
  --identity team-probe,agt-probe,usr-probe
# == dump-config contains tdb-agemem-dsh — composition resolved (upgraded)
dsh.cmd --profile settingsprobe --port 0 --no-open                 # dsh web: http://127.0.0.1:60395/?token=…
```
真宿主启动后 stderr **唯一**失败条目是共享层的 `superpowers`（`C:\Users\Administrator\.dsh\profiles\node_modules\dsh-superpowers\lib\index.mjs` 不存在），与本插件无关；我们条目正常激活（进程随后已 kill）。

宿主自己的 schema 投影（`--dump-config-schema`）里我们的 entry 是 `x-cordis.entries[191]` → `$defs.entry.allOf[190]` → `$defs.config100`（7344 字节），含描述、默认值、`x-cordis.volatile:true`、`x-cordis.role:"secret"`：
```json
{"default":{},"anyOf":[{"type":["object","null"],"properties":{
  "enabled":{"description":"Master switch for the whole memory plugin …","default":true,"x-cordis":{"volatile":true}},
  "server":{…"apiKey":{"default":"","x-cordis":{"role":"secret"}}…}}}]}
```
即宿主**真代码**（`dsh-app-boot` projector）接受并投影了我们的 Config，不是单测 stub。

## 7. 改了哪些文件
- `dsh-plugin/package.json`：加 `dependencies.@deepseek-ai/schemastery`（`files[]` 已含 `client`、`cordis.bundle.yml`、`README.md`）。
- `dsh-plugin/scripts/deploy.sh`：打包段按 `files[]` 逐项 `cp -R`，缺项 `refusing to pack a partial plugin` 退出 1（此前硬编码三件 ⇒ 宿主 `Cannot validate installed package … ENOENT cordis.bundle.yml` 整包回滚）。
- `dsh-plugin/scripts/patch-util.mjs`：`upsertManaged` 原地替换。
- `dsh-plugin/client/client.js`：`save()` 返回 promise；每个开关行带 `id="tdb-agemem-<key>"`。
- `dsh-plugin/src/index.ts`：导出 `Config`；`src/config-schema.ts` + `config-schema.host.ts`：配置面声明。
- `dsh-plugin/vitest.config.ts` + `test/fixtures/schemastery.stub.ts`：仓库内解析不到 schemastery，用结构性 stub 让单测可跑（只 stub 形状；真行为用 §3 装成品内省验）。

## 8. 未验证 / 已知风险（诚实边界）
1. **没在真宿主里点过一次保存**。约束是「绝不重启用户 GUI」，desktop 里跑的是旧构建（`file:D:/TDB/td-agemem/dsh-plugin/artifacts/tdb-agemem-dsh-0.1.0.tgz`）。「`edit()` 的 overridden 守卫修好后能过」是从 `:98/:105-109/:122` + patch 行序推出的**推断**，非点击实测。
2. `--dump-config-schema` **退出码 1**，但报错与我们无关：`[/187]-[/190] unrecognized Loader tree carrier`、`[/192] Cannot find module …dsh-superpowers`，另 3 条 transform 警告属别的插件；我们的 `[/191]` 无任何告警。这些历史条目成因未查（不在本票范围）。
3. 拉 `http://127.0.0.1:60395/?token=…` 曾得 `401 dsh web authentication required`。**口径已明确**（Lead）：宿主 web 的认证 token 就是启动时打印 URL 里的 `?token=`，必须原样带（含 URL 编码）；`dsh --profile <p> --port 0 --no-open` 后 `curl -sS "$URL"` 应 200。我未复跑这条 ⇒「浏览器真渲染出表单」目前仍靠 §6 schema 投影 + §5 单测，不是截图；真正的闭环是发布门禁里的那一次点击保存（`docs/ops/dsh-plugin-release-checklist.md` §4）。
4. 双份 config 仍在（insert 基线 + override 行）。语义已实测正确（后行胜、合成单 entry、deploy 重跑不抹），但没删 insert 里的 config：身份（`teamId/agentId/userId/baseUrl`）需要归处，而 override 行只在第一次保存后才存在。副作用：设置页保存过之后再手改 insert 块身份**不生效**（被整块盖住）——排障先看第 17 行之后有没有 override 行。
5. live 生效面未验：`dsh-settings/lib/index.js:446` 把 volatile 标 `applies:'live'`，但本 profile 无 hmr ⇒ 改完是否需要重启宿主**未实测**。
6. `assetReflection.*` 4 条可调却没进表单（§3）：**已拍板进表单（=20）**，理由是它改的是「模型被告知什么」。落地按 §9 三步，执行者 `dsh-plugin`（`src/config-schema.ts` 与 `src/index.ts` 现归其独占），我不改这两处以免撞车。

## 9. 加键三步（交接口径，给 `dsh-plugin` 照抄）

目标：让一个已有配置键出现在宿主设置页。以 `assetReflection.enabled` / `assetReflection.alwaysOn` 为例。

1. **`src/config-schema.ts` 的 `VOLATILE_PATHS`（:62-87）加路径**：`'assetReflection.enabled'`、`'assetReflection.alwaysOn'`。
   只有 `.volatile()` 的叶子进表单（宿主 `dsh-settings/lib/index.js:103-131` `volatileForm` 会对非 volatile 子树整棵剪掉），所以这一步是「进不进表单」的唯一开关。
2. **同文件 `DESCRIPTIONS`（:90-108）加一行人话**：`'assetReflection.enabled': '…'`、`'assetReflection.alwaysOn': '…'`。宿主把 description 直接渲染成表单说明（§6 的投影证据里 `"description"` 来自这里）。
3. **不用手工加叶子 default**：`buildPluginConfigSchema`（:126-149）是顺着 `DEFAULT_CONFIG` 递归 walk 建的，`z.any().default(value)` 的默认值来自 `DEFAULT_CONFIG` 本身——键已存在就自动带上。所以第三步是**验证**不是编辑：
   ```bash
   npx tsc -p tsconfig.json && cd dsh-plugin && DSH_PROFILE=settingsprobe bash scripts/deploy.sh --skip-tests --no-store-key
   node -e "…内省 entry.fiber.runtime.Config…"   # 期望 volatile 从 18 变 20，secret 恒 2
   ```
   注意 `deploy.sh --skip-tests` **不重建 dist**（`scripts/deploy.sh:219` 才 build），所以先 `tsc` 再 deploy，否则内省读到旧图。
   禁区：不要给 `server.apiKey`/`server.userKey` 加 volatile（宿主禁止 secret 进表单，只写 `SECRET_PATHS` 走 `remote.credentials`）；不要加「父路径 volatile 又包 volatile 子路径」（宿主报 `volatile fields require a fixed object path without an enclosing volatile field`）。
