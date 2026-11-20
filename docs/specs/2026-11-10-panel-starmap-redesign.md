# MemoryPanel 星图重设计（v1 设计稿）

状态：设计稿，待拍板。未改代码、未写库。
依据：`docs/panel-ui-inventory-2026-11-10.md`（接口与交互基线，77 条路由 / 143 个前端方法）。

## 1. 一句话

把 `/` 从「星图画布 + 七站抽屉」改成「以当前智能体为观测点的一张星图」：中心一颗人格恒星，四周四片星云，每片云内部按层级或归属分出同心带与亮暗，所有深度操作在右侧详情抽屉里完成，旧九页退到 `/legacy` 只做兜底与批量写。

观测点 = (team, agent)。切智能体即换图，不换路由。

## 2. 命名

推荐一套（四字同构、每个词说清东西是什么）：

| 现名 | 建议名 | 为什么 |
|---|---|---|
| 人格恒星云 | **人格恒星** | 它是唯一的中心光源，不是「云」 |
| 记忆星云 | **忆云** | 记忆是主体，名字最短最重 |
| 知识星云（wiki） | **典籍云** | wiki 是给人读的文档库，「典籍」比「知识」准，也避开与「能力/技能」的混用 |
| 代码星云（codegraph） | **构筑云** | codegraph 是代码骨架与依赖结构，「构筑」指向结构而非源码 |
| 能力星云（skills） | **技艺云** | skill 是能被 agent 调用的技艺包 |

备选一套（更直白，若你更想要一眼看懂）：记忆星云 / 知识星云 / 代码星云 / 能力星云，中心仍叫人格恒星。两套在代码里都只是常量表，改一次即可。

## 3. 空间结构

同心三层，一张画布，不翻页。

| 层 | 半径 | 内容 |
|---|---|---|
| 核心 | 0–140px | 人格恒星：中心是人格卡本体，向外一圈 8–14 个属性星点（六轴特质、情绪、人物、版本、注入健康） |
| 云带 | 240–560px | 四片星云。忆云占上半 180°（它要画四条同心带），典籍云 60°、构筑云 60°、技艺云 60° 分下半 |
| 外环 | 560–720px | 暗星区与时间刻度：团队可见但未挂到当前 agent 的资产、以及「最近更新」的时间弧 |

忆云内部从内到外：L3 → L2 → L1 → L0（内层少而重，外层多而轻），与你说的顺序一致。典籍、构筑、技艺三云内部按「已挂载 / 团队可见」分两带，亮带在内、暗带在外。

## 4. 五组星点定义

### 4.1 忆云

| 带 | 星点是什么 | 接口 | 关键字段 | 上限与加载 |
|---|---|---|---|---|
| L3 | 一条内核记忆 | `POST /api/v1/chat-memory/layer` {block_id, layer:"L3", limit≤200, offset} | items[{id,title,body,tags,refs}] | 全量（通常个位数） |
| L2 | 一个场景 | 同上 {layer:"L2", path?} | 场景列表 / read 正文 | 全量 |
| L1 | 一条原子记忆 | 同上 {layer:"L1", limit≤200, offset} | items[{id,title,body}] | 首屏取最近 200 |
| L0 | **一个会话**（按 session_id 聚合），会话内小星点才是消息 | 同上 {layer:"L0", before_ts 游标, limit≤200} | messages[] 实测字段 {id,role,title,body,tags,refs,created_at}，**没有 session_id**；会话 id 只在 title 里形如 `assistant @ session-<uuid>`；L1 才有 session_id / session_key | 会话级首屏，展开再拉消息 |

- L0 星点大小 = 该会话消息数，颜色深浅 = 最近一次活动距今天数。
- 亮暗：当前 agent 的 fixed 记忆块亮（`POST /api/v1/chat-memory/agent-fixed` {agent_id}），团队共享但未挂载的暗。别人私密的块**不出现**，不是暗星。
- 权限：这一路是 H+U，且逐块过 `authorizeChatMemoryRead`（owner / visibility=team / 借入），无权限回 403 ASSET_NOT_ACCESSIBLE，前端表现为「该块不出星」。

### 4.2 典籍云

| 星点 | 接口 | 字段 | 说明 |
|---|---|---|---|
| 星云 = 一个 wiki 库 | `POST /api/v1/knowledge/wiki/team-assets` 或 `agent-fixed` | {knowledge_id,name,status,scope} | 云心写在扇区外缘 |
| 星团 = 目录/类型簇 | `POST /api/v1/knowledge/wiki/graph` {wiki_id} | nodes[{id,label,type,path}]；**实测 communities 恒为空数组**，改为前端按 path 顶层目录 + type 分簇 | 默认只画簇，避免一次几千点 |
| 最小星点 = 页面/块 | 同上 graph | nodes[{id,label,type,path,linkCount,community}]、edges[{source,target,weight}] | 点开社区才展开成员 |

亮暗：`POST /api/v1/knowledge/agent-fixed` {agent_id} 里的 wiki 亮，团队可见未挂载暗。状态 processing/failed 用脉冲与红边，不靠颜色单独表达。

### 4.3 构筑云

现状是缺口：code graph 只有 `stats{files,nodes,edges}`，`search`/`explore` 返回 `{text,isError}` 纯文本，**没有节点级读面**。所以分两档：

- v1（不改后端）：星点 = 一个仓库，大小按 files/nodes，亮度按是否挂到当前 agent。点开是仓库详情（现状 code-detail-view 的搜索/探索仍在）。
- v2（需要一个新接口）：KS 增加结构读面，形如 `POST /v3/code-graph/{id}/graph` 返回 `{nodes[{id,label,kind,path}],edges[{source,target,kind}]}`，与 wiki graph 同形。有了它，构筑云才能画到文件/符号级。
- 没有结构面时的降级：不假装有图，扇区里只画仓库星点并在云名后标「结构面未开通」。

### 4.4 技艺云

- 星点 = 一个 skill，来自 `POST /api/v1/skill/list`；绑定走同一接口传 `{user_id,team_id,agent_id}`（实测返回该 agent 名下 total，件数 339 / 51 / 0）。`POST /api/v1/meta/agent-fixed-asset/list` 对外恒 501，不可用。
- 亮暗：绑定当前 agent 亮，团队可见未挂载暗；仅本人可见的私密 skill 出现在内圈但带锁标。
- fork 副本（名字带 `-fork-<agentId>`）不合并：父 skill 与副本之间画一条细血缘线，副本星点小一号，避免把「复制」误读成「同一个」。
- 版本多的 skill 星点外有一圈年龄环（版本数 1/2-5/>5 三档），不逐版本出星点。

### 4.5 人格恒星

| 位置 | 星点是什么 | 接口 | 关键字段 |
|---|---|---|---|
| 中心 | 人格卡本体（发光核心，直径随卡片字数 1000–2400 微调） | `GET /api/v1/chat-memory/soul-card?team&user&agent` | text、chars、warnings（warnings 显示为核外暗斑） |
| 内圈 | 六轴特质 | `GET /api/v1/chat-memory/soul-trait-state` | traits[{label,seedWeight,nowWeight,drifted}]，漂移量 = 半径差 |
| 内圈 | 情绪 | `GET /api/v1/soul/emotions` | rows[{at,object,label,valence,arousal,intensity,decayedIntensity}] 与 funnel |
| 内圈 | 人物档案 | `GET /api/v1/soul/persons`、`/soul/person` | persons[{key,displayName,fieldCount,relationCount}]、edges[{subjKey,pred,objKey,direction}] |
| 内圈 | 版本与注入健康 | `POST /chat-memory/soul-versions`、`GET /soul/injection-stats` | versions[]、rows/lastAt/failReasons |

连线：人物之间按 `edges.direction` 画（out 有向箭头、mutual 双向）；人物到忆云的点按 `fields[].evidence[].recordId` 反查，只画一根「依据」线，不做全量 mesh。

结构化块已具备（实测 2026-11-10）：soul-card 直接回 `blocks[]`，9 块，字段 {id,title,chars,source(declared/observed/structured/absent),confidence(high/medium/low/absent),evidenceIds,warnings}；实测 firstLook 5 / life 48 / character 248 / voice 55 / us 247 / now 48 / memory 142 / boundaries 0(absent) / recent 0(absent)。恒星布点用 blocks，不用解析 text。absent 块画成核外暗斑，不画实点。

## 5. 交互

- 默认：四云 + 恒星 + 暗星。亮星实心带光晕，暗星半透无光晕。
- 悬停：星点名 + 一行摘要 + 亮暗原因（「已挂载到砚舟」/「团队可见未挂载」）。
- 点击星点：右侧抽屉（沿用现有 sheet 与 Esc 收起），抽屉内容直接复用旧页详情组件，不重写细节。
- 点击云名或扇区空白：聚焦该云，其它云降到 12% 透明，云内进入下一层（社区→页面、会话→消息）。
- 缩放与复位：滚轮缩放、空白点击复位、`Esc` 收起抽屉。
- 键盘：Tab 在星点间移动、Enter 进详情，focus 环可见。
- 顶部筛选：时间窗（外环拖动）、只看已挂载、只看我可写的、只看异常（processing/failed/stale）。
- 云名角标：星点数 / 已挂载数 / 待处理数。
- 空态：整云为空给一句「这朵云还没有东西」+ 直接入口（新建 wiki / 导入 skill），不画空圆。

## 6. 接口边界与权限

三条原则：

1. **不可见不出现**。越权数据不画灰点，暗星只表示「团队可见但没挂到当前 agent」。这条决定了 star map 不能只靠一次聚合接口喂全量。
2. **首屏 ≤6 个请求，并发 ≤2 且重接口串行**。限速是 120/min（user-key）与 60/min（IP）。实测教训：并发 6 路打 soul-card / persons / emotions 会各自顶到 15s 超时回 504，而同一批接口串行时耗时 7–79ms。
3. **全部走 BFF，不直连 Core**，写操作沿用现有路由与 409 语义（`data.conflict`）。

| 动作 | 现有接口 | 鉴权 | 常见失败 | 能否批量 |
|---|---|---|---|---|
| 四云资产清单 | `POST /agent-overview/bootstrap` | H+T | 401/403 | 是（六路 allSettled，单路失败降级空） |
| 记忆块挂载 | `POST /chat-memory/agent-fixed` | H | 400/401/403/404 | 单 agent |
| 记忆分层 | `POST /chat-memory/layer` | H+U | 400/401/403/404，RANGE_TOO_LARGE | 单块单层 |
| wiki/code 挂载 | `POST /knowledge/agent-fixed` | H+T | 同上 | 单 agent |
| wiki 结构 | `POST /knowledge/wiki/graph` | H+K(read) | 403/404 | 单库 |
| skill 列表与绑定 | `POST /skill/list`（带 user_id/team_id/agent_id） | H | 400/401 | 分页（page/page_size） |
| 人格卡与人物 | `GET /chat-memory/soul-card`、`GET /soul/persons` | H | 502/503/504 | 单 agent |

三个缺口，按价值排序（2026-11-10 实测后修正：人格卡 blocks 已有，缺口取消）：

1. **构筑云结构读面**（KS 新增）：没有它，构筑云只能到仓库级。
2. **L0 缺 session_id**（Core 补一个字段，或在 `/v3/conversation/query` 的 message 上回 session_id）：现在只能从 title 字符串 `role @ session-<uuid>` 反解，改一次文案就断。
3. **跨云聚合读面**（BFF 新增 `POST /api/v1/starmap/overview`，H+T）：一次返回四云计数 + 当前 agent 已挂载集合 + 人格摘要。没有它首屏是 6 个请求起步，切 agent 就再一轮。

## 7. 性能预算

- 首屏星点 ≤ 800（恒星 14 + 忆云 4 带各 ≤200 但总和截 500 + 三云各 ≤100）。
- 单云展开 ≤ 1200 点，超出走聚合：wiki 按 community、记忆按 session、skill 按 name 前缀。
- 视口裁剪 + `requestAnimationFrame` 合帧；静止时停渲染循环（现在 Starfield 已在跑常驻动画，要改成按需）。
- 首屏 p95 < 1.2s，切 agent p95 < 900ms（有缓存时）。实测串行单条 7–79ms，642 点 wiki graph 65ms，预算成立的前提是并发不超过 2。
- 缓存：四云资产清单与人格摘要按 agent 缓存 60s；分层数据不缓存。

## 8. 分阶段

| 期 | 内容 | 是否动后端 |
|---|---|---|
| P0 | 命名与扇区、恒星 + 四云计数、亮暗、抽屉复用旧详情 | 否 |
| P1 | 忆云四带钻取（layer + session 聚合 + 游标加载） | 否 |
| P2 | 典籍云（graph + communities）与技艺云（列表 + 血缘） | 否 |
| P3 | 构筑云（先仓库级；结构面到位后再到块级） | 是（KS） |
| P4 | 人格恒星展开（人物边、情绪、版本） | 否（blocks 已在，只剩人物边与情绪读面） |

## 9. 验收口径

- 首屏请求数 ≤6 且不出现 429（连续切 agent 10 次不触发）。
- 亮暗正确率：以 `agent-fixed` 三路真值为准，100% 对齐（抽样 20 个星点逐个人工核对）。
- 越权：用他人私密记忆块的 asset_id 断言星点数为 0、且不出现在任何云。
- 可达性：从默认视图两级点击内能到达旧页任一深度操作（wiki 编译、记忆编辑、skill 版本链）。
- 空态：新 team、无 agent、全空三态各自有入口，不出现空圆与假数字。

## 10. 实测规模与口径修正（2026-11-10 23:47–23:52，打真实 8123）

观测点：team-2k12lgb650 + agt-2m7buribzz（user usr-2m7b1144d9），带 `x-tdai-user-key: hechen` 与 `x-tdai-service-id: default`。全部串行调用，未触发 429。

| 云 | 实测 | 说明 |
|---|---|---|
| 忆云 L0 / L1 / L2 / L3 | 14782 / 11480 / 15 / 1（agt-2m7buribzz）；agt-bbr29z58s2 L0 1007；agt-h6dp2dvr4a L0 48 | 量级决定忆云必须聚合，不能逐条画 |
| 忆云块元数据 | `/chat-memory/mine` 与 `agent-fixed` 的 `layer_counts` 四个键**全是 0** | 计数不可信，真实 total 只能从 `/chat-memory/layer` 单层取 |
| 典籍云 | 3 个 wiki：wiki-m6c41uvc ready 50 点/332 边、wiki-s5obgst6 ready 686 点/2887 边、wiki-sm8cdo1j failed 0 点；communities 三库均 `[]` | 686 点在预算内；分簇要前端做 |
| 构筑云 | `/knowledge/code-graph/list` total 0 | 当前团队没有 code graph，P3 先按空态做 |
| 技艺云 | skill/list 带 agent_id：339 / 51 / 0（三个 agent）；团队可见 assets.skills 0 | 339 点超预算，按 name 前缀聚簇后再展开 |
| 人格恒星 | soul-card chars 1085、version 37、blocks 9；traits 2 轴；persons 10 / edges 1；emotions rows 0 | 真名亮、absent 块（边界/最近的变化）画暗斑 |
| 首屏 | 四云清单（bootstrap）+ 记忆块（agent-fixed）+ 忆云四层计数（layer×4）+ 典籍计数（wiki/list）+ 技艺计数（skill/list 一次）+ 人格卡 = 9 个请求 | 超了 §6 的 ≤6，所以 `/starmap/overview` 这个缺口值得补 |

三条口径改写（已回改前文）：

1. **L0 没有 session_id**。实测 message 字段只有 `{id,role,title,body,tags,refs,created_at}`，会话 id 藏在 title 的 `role @ session-<uuid>` 里；L1 才有 `session_id`/`session_key`。忆云 L0 按会话聚合要么让 Core 补字段，要么先用 L1 的 session_id 反查，解析 title 只作兜底。
2. **communities 不存在**。wiki graph 返回的 communities 恒为空数组，社区检测没有落地；分簇改为「path 顶层目录 + type」，前端可确定性地算。
3. **soul-card 已有 blocks**。9 块带 source/confidence/evidenceIds/warnings，恒星布点直接吃它；原「缺口 2：人格卡结构化」撤销。修正为「缺口 2：L0 缺 session_id」。

另外两条操作事实：`/knowledge/wiki/graph` 之前的 401 是 wiki 还在 draft（未 ingest 完），ready 后即 200；soul-card / trait-state / persons / emotions 的 504 只在 6 路并发时出现，串行时 7–79ms。
