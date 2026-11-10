# 可复制的执行提示词：灵魂层全量测试（3 个月伪造语料）

用法：新开一个会话（选 T-agent 或默认 agent 均可），把下面代码块整段复制进去。里面的路径、端口、表名都已核实，不要凭记忆改。
配套文档：`docs/specs/2026-11-08-soul-fulltest-plan.md`（用例清单与阈值以它为准）。

```
【任务】给 D:/TDB/td-agemem 的灵魂层做一次全量测试：新建一个测试专用 agent 人格，伪造 3 个月聊天数据灌进去，按 docs/specs/2026-11-08-soul-fulltest-plan.md 的 41 条用例逐条判 PASS/FAIL，不许跑完再改阈值。

【先读这三份，不要凭记忆】
- docs/specs/2026-11-08-soul-fulltest-plan.md（用例、判据、阈值、执行顺序，唯一权威）
- docs/specs/2026-11-08-emotion-person-scene-plan-v4.md（数据模型与阶段划分）
- docs/specs/2026-11-08-person-profile-distill-spec.md 第 14/15 节（档案字段、单写者口径）

【硬约束】
1. 不 commit、不 push、不建分支。HEAD 现在是 7f07f17。
2. 不打印任何 key/token。Bearer 只能从 MemoryCore/tdai-gateway.yaml 的 config.server.apiKey 逐个候选试，命中也不许回显值。
3. 生产写库只允许「脚本 + 缺省 dry-run + 先 copyFileSync 备份 + 写 soul_ledger」三件套；禁止 interactive SQL 直接 INSERT/UPDATE/DELETE。
4. 只动测试专用 agent 名下的数据。任何可能波及生产 agent 的操作先停手问人。
5. 结论必须带 path:line 或 SQL 实测数字。测试全绿不算放行依据；单测是 L4，不能单独判 PASS。
6. 未采集就写「未采集」，不等于通过。

【环境事实（已核实，别重查）】
- 服务：8420 MemoryCore（core）、8421 MemoryKnowledge、8123 MemoryPanel；控制面 127.0.0.1:8446。
  重启：curl -X POST http://127.0.0.1:8446/restart -H "X-Tdb-Control: 1" -H "Content-Type: application/json" -d '{"name":"tdai-core"}'（panel 传 tdai-panel）。core 冷启动约 25–35s，之后 curl http://127.0.0.1:8420/health 应为 200。
- 库：D:/TDB/data/vectors.db（主）、D:/TDB/data/metadata/tdai_metadata_default/metadata.db（agent 元数据与人格档案）。只读用 node:sqlite 的 { readOnly: true }。
- 租户：team-2k12lgb650 / usr-2m7b1144d9。已有测试 agent agt-3i8k22f496（青禾）、审墨 agt-fa0u5mi7x4 —— 不要复用，本任务新建一个。
- 建 agent：POST /v3/meta/agent/create {team_id, owner_user_id, name, description, status:"inactive"}；人格：POST /v3/meta/agent-persona/save {agent_id, name, pronoun, self_image, voice, purpose, traits:[{label,weight}], redlines:[{text}]}。
- 语料入口是 L0 表 l0_conversations，列：record_id, session_key, session_id, team_id, task_id, user_id, agent_id, role, message_text, recorded_at, timestamp, classification。事件由 recentL0Messages 按 recorded_at 窗口读，然后挖成 soul_episodes。
- soul_* 表：soul_episodes / soul_emotions / soul_events 无 / soul_persona / soul_person / soul_person_relation / soul_promises / soul_promise_events / soul_trait_state / soul_trait_label / soul_state / soul_ledger / soul_gate_stats / soul_snapshots。
  注意：soul_ledger 没有 tenant 列，租户是 team_id/user_id/agent_id 三列。
- 读面（都要 Bearer + x-tdai-service-id: default）：GET /v3/soul/card?team&user&agent[&session][&participants]、/v3/soul/turn、/v3/soul/persons、/v3/soul/person?key=、/v3/soul/trait-state、/v3/soul/emotions、/v3/soul/injection/stats。
- 面板 BFF（MemoryPanel 8123）：/api/v1/soul/persons、/api/v1/soul/person，必须带 x-tdai-service-id: default 与 x-tdai-user-key: hechen，否则 400。
- 门基线（先跑再动手）：cd MemoryCore && node scripts/typecheck-gate.mjs（当前 121 errors / 23 files，基线 149/28，Δ=-28 PASS）；npx vitest run（当前 3985 tests 全绿）。面板：cd MemoryPanel && npx tsc --noEmit && npx vitest run；web 构建 cd MemoryPanel/web && npm run build。

【步骤，按顺序，每步过了再下一步】
S0 备份 + 门基线：备份 vectors.db 与 metadata.db（带时间戳后缀），记录 typecheck 与全量 vitest 数字。
S1 建 T-agent（名字「砚舟」，种子标签 严谨0.72/好奇0.35/亲和0.30，三条红线见方案 §1），并核 GET /v3/soul/card 回读：三条红线在 identity 段、种子标签在 anchors 段、warnings 不含「底色为空」。
S2 生成 fixture：MemoryCore/scripts/fixtures/soul-fulltest-corpus.json，按方案 §5 结构。写生成脚本时缺省 dry-run，只打印统计（人数/段数/条数/时间跨度/每场景计数），对不上方案 §2 就停，别灌。
   关键：turns[].text 必须真的能命中确定性正则——批评要含「不对/错了/漏了/没做到」这类词（BLAME_TIGHT），修复要含「补上了/已按/已改/改完」（REPAIRED_STANCE），承诺要含「我答应过自己」（PROMISE）。只写「他批评了我」这种概括，事件层什么都长不出来。
S3 临时库 90 天回放（主实验）：mkdtemp + 真 VectorStore + 真 runSoulMaintenance，模拟时钟从 2026-08-10 推进到 2026-11-08，每天 1–3 个 tick，rewriter 用确定性 stub（按 fixture 的 expect 输出），另跑一份真 LLM 变体只覆盖最后 7 天做对照。
   坑：recentL0Messages 的窗口用真实 Date.now() 算，所以要传足够大的 sinceDays（≥400）才读得到「3 个月前」的行；runSoulMaintenance 的 now 参数控制衰减/降级/冻结的时钟。
   产物：soul-fulltest-replay-report.md（每天一行：episodes/emotions/persona 行数/admit/reject/freeze/degrade/relations）+ 逐条用例结果。
S4 生产冒烟：只把最近 7 天那 6 段（约 90 条 L0）灌到 T-agent 名下，重启 core，等 1–2 个 tick，跑方案里标 [冒烟] 的用例（C3 等）。
S5 面板与注入取证：跑 D1–D4，并把 GET /v3/soul/card 两段 chars 与 persona-injection.jsonl 的 section-read 对账（宿主未重启就没有 section-read，这种情况写未采集，不许编）。
S6 清理：写脚本按 T-agent 清扫 l0_conversations/l1_records/soul_* 行，缺省 dry-run，--apply 才删，删前备份；清完复核生产基线（soul_person 4 人、既有 agent 的 soul_snapshots.version 未变）。

【判口径】
- 只有方案 §6 五层 41 条全绿且 E6（生产 agent 未被污染）绿，才允许写 PASS；E6 红则整体 FAIL。
- B9（新标签生长）若 90 天没长出标签，记「未达成」并给出净票数据，说明是证据不够还是代码不产。
- 关系层四种行文（没做到/顶了回去/只回了话/后来补上了）各要 ≥1 条实拍；凑不出就是语料设计失败，改语料不是改判据。

【已踩过的坑，别重犯】
- soul_persona 的 itemId 由「层 + 文本哈希」决定：改了行文模板，旧行不会自己消失，必须写 validTo 作废（参考 MemoryCore/scripts/invalidate-old-relationship-form.mts）。
- soul_persona 的 human 层是单写者：只有 core/person/profile-distiller.ts 写，改写产线写 human 会被 human_writer_removed 拒。造数据别指望改写产线长 human 行。
- AxisVector 是对象不是数组；soul_ledger 无 tenant 列。
- vitest 4 没有 basic reporter，别传 --reporter=basic。
- 这些源码是 CRLF，用 edit 工具改多行 old_string 常匹配失败；用 node 脚本按行替换并保留 \r\n。
- 改了 dsh-plugin 要 npm run build 再 cp -rf dist/. 到 C:/Users/Administrator/.dsh/profiles/desktop/node_modules/@tdb/agemem-dsh/dist/，且要重启宿主才生效。
- Windows 上没有 python；PowerShell 长脚本要写成 .ps1 用 -File 跑。

【交付格式】
一、结论（≤5 行）：五层逐层 PASS/FAIL/未采集，加一句整体判定。
二、用例结果表：ID | 判据 | 实测值 | 证据级别(L1/L2/L3/L5) | PASS/FAIL。
三、未采集清单：只有生产/重启/长期真实对话才能验的东西，逐条写清为什么现在拿不到。
四、改了哪些文件（path:line）+ 门数字（typecheck/vitest/面板）+ 清理后的生产基线核对结果。
最后一行写「本轮未采集」。
```
