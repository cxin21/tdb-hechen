# 插件发布检查单（dsh-plugin → 桌面，Lead 执行）

> 口径来源：m02613「最优方案 + 真实数据测试 + 完整生产落地，不能半途而废」、m02467「不许降级删减」、m00570「无半成品可上生产」。
> 红线：**AI 零 commit**；**不重启用户正在用的 GUI**（重启由用户做）；不可逆动作先请示。

## 0 门禁（缺一不放行）

| # | 检查 | 命令 | 通过判据 |
|---|---|---|---|
| G1 | 插件自测全绿 | `cd dsh-plugin && npx vitest run` | failed=0（**不接受**「失败都在别人正在改的文件」这种解释） |
| G2 | 插件类型 | `npx tsc --noEmit` | exit 0 |
| G3 | 构建 | `npm run build` | exit 0 且 `dist/index.js` mtime 晚于所有 `src/*.ts` |
| G4 | core 门禁 | `cd ../MemoryCore && npm run typecheck:gate` | 错误数 ≤ 基线 243/44（Δ≤0） |
| G5 | core 自测 | `npx vitest run`（按票范围跑受影响目录即可） | failed=0 |
| G6 | 票面收口 | 团队看板 | 本批票全部 completed，且每票有六字段回报 |
| G7 | 段证据（装后才有） | `node dsh-plugin/scripts/scan-session-evidence.mjs --session <id8> --strict` | exit 0，三段 `MISSING` 全为「无」 |
| G7b | 扫描器自检 | `node dsh-plugin/scripts/scan-session-evidence.mjs --selftest` | 打印 `SELFTEST OK` 且 exit 0（全齐 fixture 必须全 PASS、全缺 fixture 必须 exit 1） |
| G7c | 段行形态（裸文件名防线；G7 PASS 但行没前缀时这条会红） | ① `node dsh-plugin/scripts/scan-session-evidence.mjs --session <id8> --json` 取 `scene_index` 段的 `chars`；② `node dsh-plugin/scripts/verify-installed.mjs` 看 `head pack scene index` 行 | ① `scene_index` = `PASS` 且 chars **>0**（段在、非空）；② `head pack scene index` = **PASS**。两条同时成立 ⇒ 每行以 `- scene_blocks/` 开头：端点 `path` 是相对 `scene_blocks/` 的**裸文件名**（`MemoryCore/src/core/storage/types.ts:254`），裸文件名形态下 needle `- scene_blocks`（`dsh-plugin/scripts/verify-installed.mjs:113`）**不命中**（本轮实测：剥 persona 尾部后 `composeHeadPack` 4603→4102 且该串消失），故 PASS 即证明前缀已补回 |

G7c 两条命令的真跑输出形态（**示例：数字与 seq 是示意，不代表本机实测值**；形态照抄，两条都 PASS 才算过）：

```text
$ node dsh-plugin/scripts/scan-session-evidence.mjs --session 4f2a9c11
    --- head pack（ctx.systemPrompt.section，取最后一个 system/message）
    seq=812  系统提示全长 21,338 chars
    [PASS] scene_index         2,415 chars        ← ① 段在且非空
$ node dsh-plugin/scripts/verify-installed.mjs
  [PASS   ] head pack scene index     3 session(s), newest 4f2a9c11    ← ② needle "- scene_blocks" 命中
```

> 为什么不一条命令搞定：扫描器 `HEADPACK_SEGMENTS` 只按段标记「长期记忆」判有无、**不检查行前缀**（`dsh-plugin/scripts/scan-session-evidence.mjs:44-53`，打印 `:268-271`），所以前缀只能靠「裸文件名必不命中」这个反证；`verify-installed.mjs` 的 needle 恰好是 `- scene_blocks`（`:110-114`），命中即证明前缀存在。

## 1 打包与戳记

```bash
cd dsh-plugin
npm pack                    # 产物 tdb-agemem-dsh-<version>.tgz
STAMP=tdb-$(date +%Y%m%d-%H%M%S)
echo "stamp=$STAMP"; ls -l tdb-agemem-dsh-*.tgz
```
记录：git 工作树未被提交（用户红线）⇒ 发布以 **tarball 内容**为唯一事实源，必须记录 `sha256sum` 到 `.deploy/$STAMP/MANIFEST.txt`。

## 2 备份（必须先于任何写入）

```bash
B=~/.dsh/.deploy/$STAMP; mkdir -p "$B"
cp ~/.dsh/profiles/desktop/cordis.patch.yml  "$B/"
cp ~/.dsh/.credentials.yaml                  "$B/"   # 含 key，备份目录权限保持 600
```

## 3 部署

```bash
bash dsh-plugin/scripts/deploy.sh --profile desktop \
  --base-url=http://127.0.0.1:8420 \
  --identity team-2k12lgb650,agt-2m7buribzz,usr-2m7b1144d9 \
  --api-key-ref TDAI_GATEWAY_APIKEY
```
dry-run 先跑一遍（不带 `--apply`，看渲染块）；真写后立即文件级验证（desktop 是 app-managed，`dsh --dump-config` 会拒）：

```bash
grep -c 'tdb-agemem-dsh managed block' ~/.dsh/profiles/desktop/cordis.patch.yml   # =2（开+闭）
grep -c 'b8475f4b' ~/.dsh/profiles/desktop/cordis.patch.yml                        # =0（明文必须 0）
ls -l ~/.dsh/profiles/desktop/node_modules/@tdb/agemem-dsh/dist/index.js           # mtime = 本次
```

## 4 重启 + 首轮取证（重启由用户做）

用户重启后，Lead 逐项读数（全部要粘原文，不许写「正常」）：
1. ready 行：`health=ok`、`identity=resolved(user_key)` 或 `configured`、`keySource=credentials:…`、`writeback=on`、`skillFeed=on`、`tools=on`、`soul=on(600,feeling)`、`coreMemory=ok(<n>字符)`、`skills=<n>条`。
2. 注入面 + 工具面：跑扫描器（**唯一判据，不许目测**）
   ```bash
   node dsh-plugin/scripts/scan-session-evidence.mjs --session <新会话 id 前 8 位> --strict
   ```
   读法（每条都按 `PASS`/`none` 逐行粘原文）：
   - head pack 段表：`core_memory` / `cloud_skills`（或 `available_skills`）/ `knowledge_tools` / `scene_index` 必须 `PASS`，各自字符数落在预算内（见 proxy-parity-matrix.md §3）。
   - volatile 段表：`<soul-identity>` / `<relevant-memories>` 必须 `PASS`；`<team-wiki>` 视 wiki 命中（空查询/无命中时 `none` 属正常）。
   - 工具表：`memory_recall` + `skill_search`/`skill_view`/`skill_files_read` 必须出现且 `errors=0`。
   - 末尾 `MISSING:` 三组必须全为「无」，且 `--strict` 退出码必须是 0。任一非空 ⇒ 按 §5 失败矩阵处置，不算通过。
   - 扫描器判据来源（别改成搜正文）：head pack 只在 `system/message` 的 `data.message.content[].text`（`dsh-plugin/src/index.ts:551-556` 是 `ctx.systemPrompt.section`）；volatile 只在 `user/message` 且 `data.source.kind==='plugin:tdb-agemem-dsh'`、`data.id` 前缀 `agemem-volatile-`；插件工具在代码模式下只出现于 `tool/ptc-dispatch` 的 `data.name`（`request/header.tools` 恒只有 `run_code`）。
3. 写面工具（`skill_create`/`skill_update`/…/`knowledge_search`）只在设置页把 `skill.allowLlmWrite` 打开后才会注册；开之前扫描器里这几行应为 `MISSING`，开之后必须出现且 `errors=0`。这一条同时取证「配置 → 注册」链路。
4. 写回面：`l0_conversations` 里该 session 行数 > 0 且 body 无注入块、无 reasoning；`outbox.jsonl` 0 字节；`outbox.dead.jsonl` 0 字节。
5. 隔离面：换一个 team 头读同一 session，应 0 行（隔离仍成立）。
6. 设置页保存一次（**必须由 Lead 亲手点**）：Settings → Plugins → 插件卡片 → 改一个无害值（如 `volatile.maxChars` 1500→1600）→ 保存 → `dsh --dump-config` 里生效值变化 → 再重启一次仍生效。这条取证的是「表单写入 → patch override → 合成生效」整条链，`docs/ops/plugin-settings-ui-implementation.md` §8 目前只有推断。

## 5 失败与回滚

| 症状 | 判据 | 动作 |
|---|---|---|
| 插件未挂上 | ready 行缺席 | 查 `$DSH_HOME/agemem/agemem.log`（debug=true 才有）；回滚 §6 |
| 注入但内容坏 | volatile 段含 `<soul-identity>` 以外的东西 / 半截条目 | 降档：`volatile.soul.enabled=false` 先保住记忆注入 |
| 工具未注册 | tools 列表无 skill_* / memory_recall | 抓宿主日志 `registration failed`，按 UNSUPPORTED_SCHEMA 规则改 schema |
| 写回 401/403 | 死信 `reasonClass:'auth'` | 查 credentials ref 是否解析到 64 位 key |
| 卡顿 | 单轮多出 >2s | 降 `recall.timeoutMs`/`skill.timeoutMs`，看 agg 日志 |

## 6 回滚（一条命令级）

```bash
B=~/.dsh/.deploy/$STAMP
cp "$B/cordis.patch.yml" ~/.dsh/profiles/desktop/cordis.patch.yml
cp "$B/.credentials.yaml" ~/.dsh/.credentials.yaml
# 重启后确认 ready 行消失 = 已回到装前状态
```
回滚也要留档：`docs/ops/archive/rollback-$STAMP.md`（写「为什么回滚、回滚到哪个 sha/stamp、回滚后读数」）。

## 7 缺省定档（发布后 24h 内定，写进 production-profile.md）

- 只把**真实数据证明优于现状**的项设为缺省开；没读到差异的保持 parity 档并注明「未证收益」。
- 每项改档必须带：改前值 / 改后值 / 支撑读数（哪次真跑、哪个文件）/ 回滚方式。
- 禁止「因为它是新功能所以开」。
