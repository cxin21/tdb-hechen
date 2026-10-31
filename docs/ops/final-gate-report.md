# 全量收尾门禁报告（2026-11-01）

> 执行：bench-metrics（task-41）｜脚本：`scratch/lead/final-gate.sh`｜原始日志：`scratch/lead/final-gate.log`
> 基线提交：`17c0582`（2026-10-31 18:42:10 +0800）｜本轮执行：2026-10-31 22:39–22:44 (+08:00)
> 未 install 依赖、未 commit、未重启 8420、未触碰 desktop profile。除本文件外无任何写入。

## 结论

**12 项命令全部 rc=0，0 项 FAIL；其中 1 项（core-format）读数为「跳过」，不构成格式合规证据**，其余 11 项读数有效。

工作树状态：171 个未提交改动叠加在 `17c0582` 之上（MemoryCore 108、MemoryPanel 24、MemoryProxy 14、docs 10、dsh-plugin 1、MemoryKnowledge 0）。因此本轮门禁检验的是**工作树 + 未提交改动**，与「已提交代码」的 CI 结果不可直接等同。

| # | 命令 | rc | 关键读数 | 判定 | 对比上一轮基线 |
|---|------|----|---------|------|---------------|
| 1 | `MemoryCore: npm test --silent` | 0 | Test Files 320 passed (320)｜Tests **3086** passed (3086) | PASS | 320 files / **3084** tests ⇒ +2（新增 M6 快照用例 2 个） |
| 2 | `MemoryCore: npm run typecheck:gate` | 0 | 当前 **240 errors / 44 files**；基线 243/44；Δ=-3 ⇒ PASS | PASS | 240/44，持平（均低于上限 243） |
| 3 | `MemoryCore: npm run format:check` | 0 | `[format-changed] base=origin/main(17c05826)：本次没有改到 MemoryCore/src 下的 .ts，跳过。` | **无效（非 PASS）** | 上一轮同样跳过 ⇒ 这一行从未真正检查过文件，见下「判读 1」 |
| 4 | `MemoryProxy: npm test --silent` | 0 | Test Files 63 passed (63)｜Tests 561 passed (561) | PASS | 63/561，持平 |
| 5 | `MemoryProxy: npm run typecheck` | 0 | `tsc --noEmit` 无诊断输出 | PASS | 持平 |
| 6 | `MemoryPanel: npm test --silent` | 0 | Test Files 30 passed (30)｜Tests 265 passed (265) | PASS | 30/265，持平 |
| 7 | `MemoryPanel: npm run typecheck` | 0 | `tsc --noEmit` 无诊断输出 | PASS | 持平 |
| 8 | `MemoryKnowledge: npm test --silent` | 0 | Test Files 32 passed (32)｜Tests 209 passed (209) | PASS | 32/209，持平（日志里的 `[wiki-embed] FAIL after 2 attempts` 为用例故意制造的失败路径，见判读 2） |
| 9 | `dsh-plugin: npx tsc -p tsconfig.json --noEmit` | 0 | 无 `error TS` 行 | PASS | 持平 |
| 10 | `dsh-plugin: npx vitest run` | 0 | Test Files 15 passed (15)｜Tests **223** passed (223)｜3.29s | PASS | 15 files / **221** tests ⇒ +2，涨落原因未确认（非本轮改动；工作树 dsh-plugin 仅 1 个改动文件，可能来自并行 task-43） |
| 11 | `dsh-plugin: npm run build` | 0 | `tsc -p tsconfig.json` 无错误 | PASS | 持平 |
| 12 | `bash -n dsh-plugin/scripts/*.sh` | 0 | all scripts parse (3 files) | PASS | 持平 |

## 判读

### 1. core-format 是「空过」，不能算格式合规
- `MemoryCore/scripts/format-changed.mjs:82-97` 的 `changedTsFromGit()`（三点 diff 在 `:88`）用 `git diff --name-only --diff-filter=<A|M> <merge-base>...HEAD`（三点 diff，**只看已提交对象**）。本轮 171 个改动全在工作树、没有 commit，diff 为空 ⇒ 目标列表为空 ⇒ 提前 `return 0`（日志第 620 行「跳过」）。
- 更硬的坑：`MemoryCore/node_modules` 里**没有 prettier**（`MemoryCore/package.json:193` 声明 `"prettier": "^3.9.10"` 于 devDependencies，全仓 find 无 `prettier.cjs`，根 `node_modules` 也没有）。一旦将来真有已提交 diff，`:56-65 resolvePrettier()`（本地二进制路径在 `:61`）会直接 `fail("找不到 prettier…", 2)`。
- 也就是说这条门禁当前只有两种结局：**跳过**（工作树有改动时）或**因缺工具而红**（有已提交 diff 时），永远不会真的判定格式。
- 让它有效的最小步骤：`pnpm install`（或设 `PRETTIER_BIN`）→ 对工作树改动文件显式传参（显式文件在 `:105 explicitFiles()` 起、按 `:20` 注释为硬门）：`node scripts/format-changed.mjs <file...>`。但脚本头注释已说明本仓 **646 个 .ts 中 >545 个与 prettier 现状不一致**，显式硬门会把存量文件大面积判红；正确顺序仍是先落 `.prettierrc` + 一个纯格式 commit，再把 `FORMAT_STRICT_MODIFIED=1` 打开。

### 2. knowledge 的 FAIL 日志是测试故意的
日志 1191-1198 / 1200 / 1266 / 1299 / 1305 等处的 `[wiki-embed] FAIL after 2 attempts`、`[wiki-vec] DROP TABLE`、`[auth] rejected unauthenticated` 都来自用例自身构造的失败/重建/鉴权路径（embedding-truncate、index-db-vec、service-auth、rrf-hop-search 等），对应套件 32 files / 209 tests 全绿，无风险。

### 3. 数字涨落归属
- MemoryCore +2 tests：本轮新增的 M6 两个用例（`MemoryCore/__tests__/bench-report-gate.test.ts`，softPenalty/evidencePack 双快照 + defaults 断言）。
- dsh-plugin +2 tests：本轮未改 dsh-plugin，原因未确认；**不作为任何结论的依据**，需 owner 自证。

## 覆盖边界（这份门禁不证明什么）

- 不跑 bench（贵，指标口径另见 `docs/optimization-results.md` 与各臂报告），因此**不证明**任何检索/生成质量读数。
- 不跑 e2e：不启 8420、不碰 desktop profile，活服务链路未验证。
- MemoryKnowledge **没有 typecheck 门**（脚本只跑了它的 tests）。
- docs 一致性（`docs/ops/config-default-ledger.md` 等台账与代码是否对齐）不在本门禁内。
- dsh-plugin 只有 typecheck + tests + build，无端到端装载验证。

## 复现

```bash
cd /d/TDB/td-agemem
bash scratch/lead/final-gate.sh            # 约 5 分钟，串行 12 项
tail -n 40 scratch/lead/final-gate.log     # FINAL GATE 表格 + 每项详单
```
