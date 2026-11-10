# 灵魂层全量测试方案（3 个月伪造语料 · issue #180）

- 文档版本：v1（2026-11-08）
- 追踪：GitHub issue [#180](https://github.com/cxin21/tdb-hechen/issues/180)
- 关联规格：`docs/specs/2026-11-07-soul-production-grade-spec.md`、`docs/specs/2026-11-08-emotion-person-scene-plan-v4.md`、`docs/specs/2026-11-08-person-profile-distill-spec.md`
- 目的：用一个**独立测试人格 + 3 个月伪造语料**，把「L0 → 事件 → 情绪 → 事实/人设 → 人物档案/关系 → 注入 → 面板」整条链路跑一遍，并按本文用例逐条判 PASS/FAIL。

## 0. 三条前置约定

1. **不拿生产 agent 做实验**。新建 `测试专用` agent（下称 T-agent），所有伪造数据只写它名下；生产既有 agent 的卡不得变化（用 `soul_snapshots` 版本号前后比对）。
2. **主实验在临时库做**（`mkdtemp` + 真 `VectorStore` + 真 `runSoulMaintenance`，模拟时钟 90 天）。生产库只做「冒烟」（近期 7 天、约 60 条 L0，真 tick 跑一轮），因为生产窗口按真实时钟算，塞不进 3 个月。
3. **判据先写死再跑**：本文 §6 的阈值改一次就要在 issue 里说明理由；不许跑完再调阈值。

## 1. 测试人格（T-agent）规格

| 项 | 值 |
| --- | --- |
| 名称 | 砚舟（自称「我」） |
| 形象 | 一个把复杂事情拆成步骤的人；说话短句，先给结论 |
| 使命 | 测试专用：验证人格层在长周期、多人物、多场景下的稳定与可解释 |
| 底色（种子） | 严谨 0.72 · 好奇 0.35 · 亲和 0.30（其余 3 轴 0.1） |
| 红线 | ① 不得未验证就声称已验证 ② 不得替用户承诺时间 ③ 不得把推测写成事实 |
| 创建方式 | `POST /v3/meta/agent/create` + `POST /v3/meta/agent-persona/save`（见 §4 命令） |

理由：种子标签只给 3 条，其余留空，才能观察「标签由经历长出来」；红线 3 条便于验证「红线只 append/retract、永不衰减合并」。

## 2. 语料规模（硬指标）

| 维度 | 目标 | 为什么是这个数 |
| --- | --- | --- |
| 时间跨度 | 2026-08-10 → 2026-11-08（90 天） | 覆盖 `windowDays=7`、`degradeAfterDays=30`、`freezeAfterDays=90` 三个档 |
| 人物 | **8 人**（用户本人 + 7 位：直属上级、两位同事、一位外部合作方、一位新人、一位「只在群里出现过」的旁观者、一位「关系破裂后消失」的人） | 超过 5 个对象；其中 1 人只有名字没有绑定（验证 `obj_key=null` 的虚线边）、1 人后期断联（验证 `valid_to`） |
| 会话段 | **24 段**（每段 6–14 轮，共约 620 条 L0） | 超过 20 段；每段一个场景，避免「一段塞所有情绪」 |
| 关系边 | ≥15 条，覆盖 `reports_to / colleague / client / mentor / friend / rival` 六种谓词 | 验证 `PRED_CANON` 归一、反向边只记一次、对称标 mutual |
| 情绪事件 | ≥60 条触发 ±valence 的对话，其中 ≥12 条带明确对象（人名） | 六档漏斗每档都要有样本，且对象锚可复核 |
| 冲突-修复对 | 8 组（含 3 组「先顶回去、后来补上」、2 组「认了但没做到」、3 组「未修复」） | 关系层四种行文各要有样本 |
| 承诺 | 6 条自我承诺：3 兑现、2 破约、1 长期 open | 覆盖 `kept/broken/open` |
| 沉默期 | 两段 ≥21 天的空窗（第 30–52 天、第 74–90 天） | 验证衰减/降级/冻结与「回归后复活」 |

## 3. 场景矩阵

| 编号 | 场景 | 人物 | 期望产生的结构 |
| --- | --- | --- | --- |
| S1 | 每周例会汇报（松→常） | 上级、两位同事 | 工作类事件不产情绪；`work` 通道 |
| S2 | 当面指出交付未验证（收） | 上级 | 冲突 + 红线命中 + 关系 `rival→repaired` |
| S3 | 灰度决策被授权（常） | 上级 | 信任 `up`（把判断权交给我） |
| S4 | 新人问入门问题（松） | 新人 | `mentor` 边 + 耐心类标签激活 |
| S5 | 外部合作方压期（收） | 合作方 | 压力类情绪（焦虑）+ 承诺"下次一定先评估" |
| S6 | 同事甩锅给我（收↑） | 同事 A | 冲突 + 守界轴下降 + `rival` 边 |
| S7 | 同事 A 当面道歉并复盘（松） | 同事 A | 修复 + 信任回升 |
| S8 | 群里旁观者一句话（常，无绑定） | 旁观者（无名无 id） | 关系边 `obj_key=null`，虚线，不可点 |
| S9 | 关系破裂后断联（第 60 天后无消息） | 前合作方 | 该人档案/边 `valid_to` 生效，卡上不再出现 |
| S10 | 长时间沉默后回归（第 52、90 天） | 用户本人 | 情绪半衰期归零 → 输出「底子」行，不输出陈旧情绪 |
| S11 | 我答应过自己的三件事 | — | 承诺 `kept` 2、`broken` 1 |
| S12 | 一次越权操作被指出 | 用户本人 | 守界轴 −、红线"不得未验证就声称已验证"命中 |
| S13 | 关系陈述（补：原 24 段里没有任何一句明确关系） | 上级 / 徒弟 / 同事 / 客户 / 已结束 | 见下 |

**S13 为什么要补（2026-11-09 实测）**：第一次 90 天回放关系边 0 条，把模型原始输出打出来才确认——语料里 L1 全是「偏好 / 工作事实」，没有一句「他是我的谁」，模型按「没有依据直接省略」正确地不输出。原先出的 2–3 条边全是误抽（`-[同事]-> 赵宁` 的 quote 是「与同事赵宁无关」的否定句）。所以补四段关系陈述：

| 会话 | 内容 | 期望 |
| --- | --- | --- |
| `ft-s13a` | 「周衡是我直属上级」+「我是他手下唯一的产品经理」 | 一条边：`p_b38a137ab63b -[上级]-> p_cedcb09bc663`；反向表述归一到同一条，不产第二条 |
| `ft-s13b` | 「林夏算我带出来的，我给她当师父」 | 方向不能反：obj 是徒弟，pred 取「徒弟/师父」配对应 inverse |
| `ft-s13c` | 「赵宁纯同事，不是上下级」+「陈屿是客户方负责人」 | 同事边 `mutual`；客户边方向正确；「不是上下级」不得抽出上级/下属边 |
| `ft-s13d` | 「前合作方三月份就散了，没有合作关系」 | 不产现行边（或产 `valid_to` 已结束） |

## 4. 执行顺序

**S0 备份与门基线**（先测再动）
- `node scripts/typecheck-gate.mjs` 记下 errors/files；`npx vitest run` 记下 files/tests。
- 备份：`copy D:/TDB/data/vectors.db D:/TDB/data/vectors.db.bak-fulltest-<ts>`；`D:/TDB/data/metadata/tdai_metadata_default/metadata.db` 同。

**S1 建 T-agent 并核身份**
```
POST http://127.0.0.1:8420/v3/meta/agent/create
{"team_id":"team-2k12lgb650","owner_user_id":"usr-2m7b1144d9","name":"砚舟","description":"全量测试专用 agent（勿用于生产对话）","status":"inactive"}
POST http://127.0.0.1:8420/v3/meta/agent-persona/save
{"agent_id":"<新 id>","name":"砚舟","pronoun":"我","self_image":"…","voice":"…","purpose":"…",
 "traits":[{"label":"严谨","weight":0.72},{"label":"好奇","weight":0.35},{"label":"亲和","weight":0.30}],
 "redlines":[{"text":"不得未验证就声称已验证"},{"text":"不得替用户承诺时间"},{"text":"不得把推测写成事实"}]}
```
判据：`GET /v3/soul/card?team&user&agent=<新 id>` 回 200，`identity` 段含三条红线，`anchors` 段含种子标签，`warnings` 不含 `底色为空`。

**S2 生成语料（fixture，不入库）**
- 产物：`MemoryCore/scripts/fixtures/soul-fulltest-corpus.json`，结构见 §5。
- 生成脚本缺省 dry-run，只打印统计（人数/段数/条数/时间分布/每类场景计数），统计对不上 §2 就停。

**S3 临时库回放（主实验，L3 证据）**
- `mkdtemp` 建临时库 → 真 `VectorStore` → 按天推进 `now`（90 天，每天 1–3 个 tick，用 `runSoulMaintenance({store, tenant, now, ...})`）→ 每天喂当天的 L0 行。
- `rewriter` 用**确定性 stub**（按 fixture 里预写的期望层输出，不调 LLM），保证可重复；另跑一份「真 LLM」变体做对照（只跑最后 7 天，避免成本）。理由：3 个月 × 真模型不可重复，主实验必须确定性。
- 产物：`soul-fulltest-replay-report.md`（每天一行：episodes/emotions/persona 行数/admit/reject/freeze/degrade/relations）+ 断言结果。

**S4 生产冒烟**
- 只灌「最近 7 天」那 6 段（约 90 条 L0）到 T-agent 名下，重启 core，等 1–2 个 tick，跑 §6 里标 `[冒烟]` 的用例。

**S5 面板与注入取证**
- `GET /v3/soul/persons`、`/v3/soul/person?key=`、`/v3/soul/card?...&session=`、`/v3/soul/turn`、`/v3/soul/trait-state`、`/v3/soul/injection/stats`（Bearer + `x-tdai-service-id`）。
- Panel：`/api/v1/soul/persons`（要 `x-tdai-service-id: default` + `x-tdai-user-key: hechen`）。

**S6 清理**
- 删 T-agent 名下 L0/L1/episodes/emotions/persona/person/relation/trait/state/ledger/snapshots（脚本缺省 dry-run，`--apply` 才删，删前备份）。
- 生产库 `soul_person` 若出现测试人物，一并清；面板确认 4 人基线恢复。

## 5. 语料 fixture 结构

```json
{
  "tenant": {"teamId": "...", "userId": "...", "agentId": "<T-agent>"},
  "span": {"from": "2026-08-10T00:00:00.000Z", "to": "2026-11-08T00:00:00.000Z"},
  "persons": [
    {"key": "p_lead", "displayName": "上级", "platform": "tdai", "platformId": "usr-xxx"},
    {"key": "p_peer_a", "displayName": "同事A", "platform": "tdai", "platformId": "usr-yyy"},
    {"key": null, "displayName": "旁观者", "platform": null, "platformId": null}
  ],
  "sessions": [
    {
      "scene": "S2",
      "sessionKey": "ft-s02",
      "startAt": "2026-08-12T02:00:00.000Z",
      "participants": ["p_lead"],
      "turns": [
        {"role": "user", "userId": "usr-xxx", "text": "…", "at": "…"},
        {"role": "assistant", "text": "…", "at": "…"}
      ],
      "expect": {"episodeKind": "correction", "emotionLabel": "愧疚", "relationPred": "rival", "relationThen": "repaired"}
    }
  ]
}
```
约束：`turns[].text` 里**必须包含**能让 `BLAME_TIGHT` / `REPAIRED_STANCE` / `PROMISE` 命中的原话（这些是确定性判据的输入，不能只写"他批评了我"）。每段 `expect` 是断言输入，不是让测试去猜。

## 6. 用例清单

判据列写的是**可核对的断言**，不是形容词。`[冒烟]` 表示在生产库上跑，其余在临时库。

### A 身份与数据层

| ID | 用例 | 判据 |
| --- | --- | --- |
| A1 | T-agent 人格写入可回读 | `/v3/soul/card` 的 identity 段含 3 条红线、anchors 含 3 个种子标签；`soul_trait_state.seed_state_json` 与声明一致 |
| A2 | L0 灌入后按租户隔离 | 查 `l0_conversations`：T-agent 行数 = fixture 条数；其它 agent 行数不变 |
| A3 | 事件由 L0 长出且带人 | `soul_episodes` 行数 ≥ 24（一段 ≥1 条）；`persons_json` 非空的 ≥ 80% |
| A4 | 同段重复灌入不翻倍 | 同 fixture 灌两遍 → `soul_episodes` 增长 ≤ 1 条（`hasRecentL0Duplicate` 生效） |
| A5 | 时间戳语义正确 | 回放报告里每天的 `at` 都落在模拟时钟当天；无「未来事件」 |

### B 派生层（事件 → 情绪 → 事实 → 档案 → 关系 → 特质）

| ID | 用例 | 判据 |
| --- | --- | --- |
| B1 | 六档情绪漏斗每档有样本 | `soul_gate_stats` 里 `emotion:*` 六个码 count 均 ≥1 |
| B2 | 情绪有对象锚且可复议 | `soul_emotions.object_person` 非空 ≥ 12 行；同一对象复发能查到 ≥2 条 |
| B3 | 半衰期真的衰减 | 同一对象两条相隔 ≥3 半衰期的事件：后一条读取时 intensity < 前一条的 40% |
| B4 | 情绪到期后不出陈旧行 | 沉默 21 天后 `/v3/soul/turn` 输出「底子」行，不含旧情绪标签 |
| B5 | 冲突-修复四态各有样本 | 关系层四种行文（没做到/顶了回去/只回了话/后来补上了）各 ≥1 行 |
| B6 | 人物档案九字段 | 至少 6 人有 ≥3 字段；`dislikes` 行必有 ≥2 条证据；`focus` 超 7 天后标 stale |
| B7 | 关系边六谓词归一并去重 | `soul_person_relation` 谓词全部在 `PRED_CANON` 内；A→B 与 B→A 同一谓词只存一条 |
| B8 | 特质 6 轴漂移有净票 | `soul_trait_state.axis_json` 在 90 天内至少 2 轴变化 >0.05；每次变化能在账本找到 `action=drift` 且带 `protocol_version`；Σ\|state\| ≤0.5 |
| B9 | 标签随经历生长 | 新增标签（非种子）≥1 条，带 gloss 与 `direction`，且不与既有标签余弦 >0.85 |
| B10 | 承诺三态齐全 | `soul_promises` 里 kept ≥2、broken ≥1、open ≥1；`soul_promise_events` 有对应迁移 |
| B11 | 单写者 | `layer='human'` 行 100% 带 `meta.person.key`；`meta.source='l1+model+episode'` 的 human 行为 0 |
| B12 | 断联后失效 | 断联人（S9）的档案行与边带 `valid_to`，现行查询不再返回 |

### C 注入层

| ID | 用例 | 判据 |
| --- | --- | --- |
| C1 | 两段注入都有内容 | `/v3/soul/card` 的 `segments` 两段 chars >0；identity ≤1600、anchor ≤400 |
| C2 | 读法常量在最前 | identity 段第 1 行为读法，且全文不含轴名/α/tanh/direction/权重 |
| C3 | 按人过滤 [冒烟] | `?participants=上级` 的卡只含上级相关 human 行；不含他人行 |
| C4 | 未知会话不过滤 | `?session=no-such` 返回 `persons` 缺失且两段都在 |
| C5 | 红线永不裁剪 | 把 3 条红线全渲染，即使 identity 超预算也不出现 `omitted: budget` 命中 boundary |
| C6 | 注入量回报对账 | `injection-log` 的 `section-read` chars 与 `/v3/soul/card` 两段 chars 逐段相等 |

### D 面板与读面

| ID | 用例 | 判据 |
| --- | --- | --- |
| D1 | 人物列表 | `/api/v1/soul/persons` 返回 8 人（含 1 位无绑定），`fieldCount/relationCount` 与库内一致 |
| D2 | 单人详情 | `/api/v1/soul/person?key=` 九字段 + `evidence[].quote` 可在 L1 找到 |
| D3 | 关系图 | 边数与 `soul_person_relation` 现行行一致；`obj_key=null` 的边渲染为虚线 |
| D4 | 空态与错误码 | 不存在的 key → 404；缺 team → 400；Core 503 原码透出 |

### E 时间与不变量

| ID | 用例 | 判据 |
| --- | --- | --- |
| E1 | 90 天回放可重放 | 同一 fixture 连跑两次，最终 `soul_persona` 行数与 itemId 集合完全一致 |
| E2 | 滑出窗口不冻结 | 早期事件滑出 `windowDays` 后其人格行 `state` 仍为 active 且带 `valid_to`（不是 frozen） |
| E3 | 无永久冻结 | 90 天结束时 `state='frozen'` 行数 ≤ 2（且都有理由） |
| E4 | 告警不刷屏 | 3 个月里同类 alert 每 6h ≤1 条；账本 `action=alert` 行数 ≤ 90 天 ×3 |
| E5 | 账本可追 | 每次 persona 变更都有 `soul_ledger` 行，`before_hash/after_hash` 成对 |
| E6 | 生产 agent 未被污染 | 实验前后生产既有 agent 的 `soul_snapshots.version` 不变 |

## 7. 判 PASS 的门槛

- A/B/C/D/E 五层全绿，且 E6 必须绿（污染即整体 FAIL，不看出题率）。
- 允许的失败：B9（新标签生长）若 90 天内无新标签，记「未达成」而不是 PASS——但要在报告里给净票数据，说明是「证据不够」还是「代码不产」。
- 任何一条 FAIL 必须带 `path:line` 或 SQL 结果，不接受「看起来正常」。

## 8. 回滚

1. 生产冒烟前已备份 `vectors.db` 与 `metadata.db`；如需回滚，停 core → 覆盖备份 → 启 core。
2. 只清测试数据用 §4 S6 脚本（不整库覆盖），避免把实验期间的正常数据一起丢掉。
3. T-agent 若已写进 `meta_agents`，回滚时按 `agent_id` 删行（含 `meta_agent_persona`）。

## 9. 未采集（写报告时必须列）

- 真 LLM 改写质量：主实验用 stub，真模型只跑最后 7 天，长期演化下的改写质量属未采集。
- 宿主侧重注入：`section-read` 需要 DSH 宿主重启后才有新插件；本测试只验 Core 侧两段。
- Panel 真实浏览器点击：只验 HTTP + 构建产物，不验交互手感。
- 跨租户并发：单租户单 agent，多租户竞争属未采集。
