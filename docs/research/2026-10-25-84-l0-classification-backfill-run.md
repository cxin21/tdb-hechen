# L0 存量分类回填执行报告（#84）

- 票：cxin21/tdb-hechen#84「[P1] L0 存量分类回填（UPDATE-only 零删除）」
- 执行日期：2026-10-25
- 生产库：D:/TDB/data/vectors.db（WAL 活跃，执行期间有 live 捕获写入）
- 前置豁免：影子期经用户 2026-10-25 拍板豁免（#83 收口评论）；dry-run 人工过目闸照常执行并在用户确认后写入。
- 前置条件：#83 已合入 main（493ddf9，收口核对 2026-10-25 全绿）。

## 工具与单一事实源

- 脚本：MemoryCore/scripts/backfill-l0-classification.ts（默认 dry-run，--write 才落库）
- 分类器：直接复用 MemoryProxy/src/common/intent-classifier.ts 的 classifyInbound（单一事实源，不复制规则）
- 探针覆写：整条 trim 后精确等于「探针消息：验证 L0 写入链路，本条可安全忽略。」才标记 scaffold（reason=probe-override）；防止压缩摘要引用探针句被误归因（dry-run #1 曾发现 3 行摘要引用探针句，已收紧为精确匹配）。

## 断言（写前写后自动核验）

1. 总行数不变（12443 → 12443）
2. 仅 classification 列变化：11 个非 classification 列（record_id,session_key,session_id,team_id,task_id,user_id,agent_id,role,message_text,recorded_at,timestamp）按 rowid 折叠 FNV-1a 32bit 指纹，写前 8710a1fc → 写后 8710a1fc 一致
3. 双保险 UPDATE：SET classification=? WHERE record_id=? AND classification='unclassified'（已分类行不可覆盖）
4. 单个 BEGIN IMMEDIATE 事务，异常 ROLLBACK；UPDATE rowcount == 计划数

## 执行结果

- 目标：role='user' AND classification='unclassified' 存量行，共 1526 条
- 写入：1526/1526，assertOk=true，退出码 0
- reason 分布：classifier 1525 + probe-override 1（msg-71176d28f2aa）
- 幂等：写后复跑 dry-run，targets=0

### user 行分类分布（回填前后）

| classification | 前 | 后 | 备注 |
| --- | ---: | ---: | --- |
| scaffold | 4884 | 6049 | +1161（含 1 条探针覆写） |
| real | 507 | 508 | +1 |
| echo | 0 | 321 | +321 |
| unknown | 68 | 111 | +43 |
| artifact | 25 | 25 | 不变（原已分类） |
| dup | 9 | 9 | 不变（原已分类） |
| unclassified | 1526 | 0 | 清零 |

全库维度：unclassified 6945 → 5420，剩余全部为 assistant 行（现役捕获不写分类，不在本票范围）。

## 30 行人工复核样本（分层）

抽样：real 全部 1 条 + probe-override 1 条 + scaffold 10 + echo 9 + unknown 9。

| 分类 | record_id | 预览 |
| --- | --- | --- |
| real | msg-05eb5af1c072 | 【TDB 记忆系统排查结论 2026-10-14】tdb 记忆只有 L0 无 L1/L2/L3 的根因排查… |
| scaffold | msg-71176d28f2aa | 探针消息：验证 L0 写入链路，本条可安全忽略。（probe-override） |
| scaffold | msg-5ed2b56e80bb | [Compressed conversation section] m00552–m00570 config 解析… |
| scaffold | msg-0002b02825f9 | This is an efficiency nudge to compress early… |
| scaffold | msg-e14bdeeaf09a | ⚠️ Context limit reached — compress now… |
| scaffold | msg-8763ca9d3b9a | [Compressed conversation section] m00267–m00417 E2E 执行… |
| scaffold | msg-b9717b312c01 | [Compressed conversation section] m00418–m00442 收尾… |
| scaffold | msg-1203287cb3f9 / msg-2198f12ff2b5 | [Compressed conversation section] m00675–m00676 重构侦察… |
| scaffold | msg-8639619e7041 | [Compressed conversation section] m00269–m00271 脚本首跑结果… |
| scaffold | msg-51f887a14e7c | [Compressed conversation section]（同 5ed2b56e80bb 重复捕获） |
| scaffold | msg-8095a604c93b | ⚠️ Context limit reached…（同 e14bdeeaf09a 重复捕获） |
| echo | msg-b2ac7ad35c17 / msg-b22e10399965 / msg-5df507ba9061 / msg-03c3ec5606ec / msg-290d7820dcb8 / msg-cb91f1db0627 / msg-89c2e7e9c161 / msg-6f986426bdb5 / msg-c2d564111241 | bili 代理 ACP 指令文本的中段截片（…call the compress tool…），小写英文无问号残片，判 echo（lowercase 回声）正确 |
| unknown | msg-d52ed1e0d16a / msg-c29b5bbec146 / msg-c457d0a07523 / msg-4577a4f46cf2 / msg-cb4da719b036 / msg-271594048bc3 / msg-626636c17233 / msg-a8c2c8fe26c8 / msg-4461cad0a34a | 同源 ACP 指令文本（CONFIRMATION MARKERS emitted by the bili proxy…），大小写混合无问号，判 unknown 正确 |

人工复核结论：无一行该判 real 而未判 real；scaffold/echo/unknown 均为系统注入文本或其截片。

## 归因边界说明

- echo/unknown 共 364 行几乎全部来自 bili 代理注入的 ACP 指令文本（压缩/确认标记相关说明）被截断后的中段残片：小写无问号 → echo；大小写混合无问号 → unknown。二者在下游均不进入 real 通道，行为等价于 scaffold。
- real 仅 1 条为真实用户排查消息（中文占比过门），与观测一致。
- probe-override 仅 1 条：探针行本体会被分类器判 real（纯中文占比 ~0.909），按票面契约显式覆写为 scaffold 软失效，未物理删除。

## 后置验证

- 探针行 msg-71176d28f2aa → classification=scaffold（只读直查核验）
- user 行 unclassified=0（只读直查核验）
- MemoryCore 全量 vitest：239 文件 2188/2188 通过（含本次新增 7 例：决策矩阵/dry-run 零写/write 生效+指纹/已分类与 assistant 不动/幂等/--limit/指纹能抓越权改动）
- typecheck 基线：本次两个新文件不在 tsc 程序内（scripts 不进基线、__tests__ 顶层不在 src/**），基线错误清单中零新增

## 下游影响

L1 抽取与召回按 classification 过滤：回填后 scaffold/echo/artifact/unknown/dup 均不进入 real 通道，存量 1526 行不再被当作真实用户输入参与召回。
