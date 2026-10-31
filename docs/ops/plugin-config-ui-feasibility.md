# 插件配置能不能 UI 配（tdb-agemem-dsh 视角，2026-11-01）

> 事实来源：`D:/DSH/resources/app.asar`（DSH 0.2.1-rc.5）解包到 `scratch/probe-ui/host/`（只读探针，未装插件、未重启宿主、零 commit）。行号为该版本产物行号，随版本漂移。下文 `dsh-xxx/…` 一律指 `scratch/probe-ui/host/dsh-xxx/…`；repo 内文件给完整相对路径。

## 1. 结论（先给答案）

- **能做，但今天做不到「零开发」**：DSH 有完整的「schema → 表单 → 写回 profile patch」三段机制，缺的只有**通用渲染器**——上游自己写明「`autoGenerate` 默认开，供按 schema 生成页面的客户端使用；**目前没有已发布的客户端这样做**」（`dsh-settings/README.md:39`）。官方每个配置页都是自己写的一个 client 包。
- **写回落点**：不是新文件，就是用户现在手写的那个 `~/.dsh/profiles/desktop/cordis.patch.yml`（`dsh-settings/lib/index.js:401` `documentPath` 取 `configEditor.documentPath`；写动作 `:508` `configEditor.edit(entry, …)`；`dsh-config-editor/README.md:41` 原子替换并**保留 YAML 注释与 `!!js` 表达式**）。
- **要不要重启**：被标成 `volatile` 的字段按设计「改完即活」（`dsh-settings/lib/index.js:446` `applies: "live"`，README:「editable without remounting」）；但落地到 YAML 的应用面还取决于 composition 有没有 HMR——`dsh-plugin-manager/README.md:14` 原话「With HMR enabled in YAML, configuration changes apply immediately; without HMR, the running composition remains until restart」。本 profile 的 `cordis.yml`/`cordis.patch.yml` 里 grep 不到 `hmr` ⇒ **本机是否即时生效，未实测，按「保存后可能需重载」写**。
- **一个前置硬条件**：settings 只认插件 `Config`（Schemastery schema）上带 `.volatile()` 的字段（`dsh-settings/lib/index.js:539-540` 读 `entry.fiber.runtime.Config`，`:506` 无 volatile 字段直接抛 `has no volatile fields`）。**本插件目前没有 `Config` schema**（`dsh-plugin/src/config.ts` 是手写 `DEFAULT_CONFIG` + `normalizeConfig`），所以第 2 步之前，UI 上连字段列表都拿不到。

## 2. 机制事实（可复核）

| 环节 | 证据 |
| --- | --- |
| 表单描述由 Host 生成 | `dsh-settings/lib/index.js:409-463` `describe()` → `{autoGenerate, ns, schema, revision, applies, value, base, user, secrets}`；`:426` `autoGenerate ?? true` |
| 只投影 volatile 字段 | `:122` `volatileForm(schema)`；`:418` 无 volatile 直接跳过该 entry |
| 写入只允许 volatile 路径 | `:507` `Config field "…" is not volatile`；`:514-530` 逐路径校验 |
| 持久化 + 应用 | `:508` `configEditor.edit(entry, …)`；`dsh-config-editor/README.md:12`「保存到 active profile 的 patch 并立即应用」 |
| 浏览器怎么拿到 | `dsh-api-settings-controller/README.md:11` 暴露 `ctx.remote.settings` / `ctx.remote.credentials`（redacted 读、写不回声 secret） |
| 客户端表单 API | `dsh-client-ui-settings/lib/client.js:1270` `super(ctx, "configForms")`；官方页用法 `dsh-client-ui-settings-web-search/lib/client.js:500-511`（`ctx.configForms.get(ns)` + `whileServed` + `slots.inject("plugins.item")`） |
| 设置页槽位开放 | `dsh-client-ui-settings-plugins/lib/client.js:201-208` 声明 `settings.section` / `settings.plugins.tab`；任何包都能注册 |
| 第三方包能不能带浏览器半 | 能：`package.json` 写 `dsh.client` + `platform: 'web'` + 导出 `./client`，Host 扫 enabled Loader 条目并在 `/plugins` 下伺服（`dsh-client-modules/README.md:34`；`lib/index.js:732-755` 按祖先 manifest 认包根 ⇒ 我们 `name: ./node_modules/@tdb/agemem-dsh/dist/index.js` 这种 file 路径条目也认） |
| schema 约束 | 一个 `.volatile()` 节点内部的嵌套不能又是 volatile 且路径必须固定（`dsh-app-boot/lib/index.js:2611` `volatile fields require a fixed object path without an enclosing volatile field`）⇒ 标顶层子对象最省事 |

## 3. 三条路与工作量分档

| 档 | 做法 | 工作量 | 验收形态 |
| --- | --- | --- | --- |
| 0（今天） | 不写代码：`--config-extra` + `agemem-identity.mjs`（见 §5） | 0 | `deploy.sh --dry-run` 打印出正确缩进的 config 块 |
| 1 | Host 侧给插件加 Schemastery `Config` + 对 A 档键 `.volatile()` | 半天～1 天 | `ctx.remote.settings.describe()` 里出现 `ns=tdb-agemem-dsh`、schema 只含 A 档字段、`applies:"live"`。**用户仍看不到表单**（无渲染器） |
| 2 | 再加一个 client 半包（`dsh.client` + `./client` + 浏览器 bundle），用 `ctx.configForms.get("tdb-agemem-dsh")` + 官方 `SettingsFormModel` 渲染，注册进 Plugins 页 `plugins.item` | 2–3 天 | 侧栏 Plugins → 本插件卡片出表单；保存后 `cordis.patch.yml` 的 `config:` 变化、注释保留、不重启生效（HMR 待测） |
| 3 | 写一个**通用** schema→表单渲染器（补上游那个「没有已发布客户端」的洞） | 一周+ | 所有第三方插件免费获得 UI；这属于 DSH 上游功能，应当反馈而不是我们私造 |

**建议**：先做档 0 解决当下的手写痛点；档 1 单独有独立价值（等于把 50 键变成「有 schema 的正式配置面」，也为将来通用渲染器铺路）；档 2 值得做但**必须先拍板**两件事：`deploy.sh` 的 `insert:` 块与 settings 按 id 写的 override 会不会打架、secret（`server.apiKey`/`userKey`）走 credentials 而非 YAML。

## 4. 50 键分档（实测 `DEFAULT_CONFIG` 叶子 **50** 条，票面写 43，差异已登记；按实测走）

- **必须暴露（16）**：`enabled`、`server.baseUrl`、`server.serviceId`、`server.teamId`、`server.agentId`、`server.userId`、`server.apiKeyRef`、`server.userKey`、`server.userKeyRef`、`writeback.enabled`、`writeback.skillFeed`、`volatile.enabled`、`volatile.maxChars`、`tools.enabled`、`tools.recall`、`debug`。理由：这 16 条决定「读谁的记忆、写不写、写多少、开不开调试」，是**部署者身份的输入**；默认值全是空串/本地地址（`config.ts:205-290`），不给用户填就等于装了个 inert 插件。
- **应隐藏（16）**：`server.apiKey`（secret，走 credentials store，UI 只给「设置密钥」按钮）、`server.requestTimeoutMs`、`headPack.*` 全部 8 条、`volatile.recall`、`volatile.recallMaxResults`、`volatile.timeoutMs`、`writeback.maxAttempts`、`writeback.retryMs`、`writeback.outboxPath`。理由：要么是 secret（不该出现在能被 grep 的 patch 里），要么是**有实测依据的调参值**（如 `volatile.maxChars:1200` 来自 450/1214 字符实测），暴露给用户只会让「默认最优档」变成噪音。
- **该硬编码（18）**：`paths.*` 全部 11 条（服务端路由，跟核心版本绑定）、`writeback.maxMessageChars`、`maxMessagesPerRequest`、`maxRequestBytes`、`maxOutboxEntries`、`maxOutboxBytes`（wire/outbox 上限，来自核心硬限）、`volatile.recallTimeoutMs`、`tools.recallTopK`。理由：改了只会坏（路由写错=404、上限写超=400 全量死信），属实现契约不是偏好。

## 5. 今天就能用（已实跑验证，零代码）

```bash
# 1) 身份：从一个 user key 解析出 team/agent/user，只写三元组（key 永不入 patch）
cd dsh-plugin && node scripts/agemem-identity.mjs --dry-run    # 实测输出 team/agent/user 并 'dry run: nothing written'

# 2) 其余任何键：写一个「顶级键 + 两空格」的 YAML 片段（脚本自己再缩进，别再手动加前导空格）
printf 'writeback:\n  skillFeed: true\nvolatile:\n  maxChars: 1600\ndebug: false\n' > /tmp/extra.yml
bash dsh-plugin/scripts/deploy.sh --dry-run --skip-tests \
  --identity team-xxx,agt-xxx,usr-xxx --config-extra /tmp/extra.yml
# 实测打印：config: → server(...) → writeback.skillFeed: true / volatile.maxChars: 1600 / debug: false（缩进正确）
```

覆盖度：`--config-extra` 的定位就是「脚本没建模的键」（`dsh-plugin/scripts/deploy.sh:81-83` 注释列了 `writeback.skillFeed`、`volatile.maxChars`、`paths.*`、`debug`），加上 identity 脚本能覆盖 §4-A 档 16 条 + 大部分 B 档 ⇒ **约 90% 的日常场景**，代价是「还是要碰一次命令行」，且**每次 deploy 都会重写 managed 块**（手改 YAML 会被覆盖）。

## 6. 未验证 / 需拍板

1. **两份 config 打架**：我们的 entry 在 `deploy.sh` 管理的 `insert:` 块里（`cordis.patch.yml:221-234`（`# >>> tdb-agemem-dsh managed block` 到 `# <<<` 结束）），settings 按 entry id 写 override ⇒ 可能出现「insert 块 + override」双份，且 `deploy.sh` 重跑会整块重写。**档 2 之前必须先实测**（这一步决定它是不是伪需求）。
2. **HMR 是否生效**：本 profile 无 `hmr` 条目，`applies:"live"` 说的是 volatile 字段读取层面，落地 patch 的应用面未测。
3. **secret 边界**：`server.apiKey`/`userKey` 必须走 `remote.credentials`（官方 web-search 页就是这么做的），不能进表单值。
4. **构建链**：本仓 `dsh-plugin` 目前只有 `tsc`（无浏览器 bundle），档 2 要引入 client 构建（官方用 tsdown，`dsh-client-ui-settings/lib/client.js:1248-1250` 提到 client bundle purity gate 禁止跨插件值导入，只能走 cordis service）。
5. 票面 43 vs 实测 50 键，已按实测写；若要严格对齐票面请指出哪 7 条不计。

## 7. 一句话回答用户

「能，DSH 本来就设计成『插件声明哪些字段可改 → Settings 投影成表单 → 写回 cordis.patch.yml 并即时生效』，只是**没有现成的通用表单客户端**，所以要么我们给这个插件写一个小页面（2–3 天），要么继续用命令行。今天不写代码的最优解是一条 `deploy.sh --config-extra` 命令；身份已经可以用 `agemem-identity.mjs` 从 user key 自动解析。」