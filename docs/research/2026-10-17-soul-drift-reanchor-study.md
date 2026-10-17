# #43 灵魂注入漂移研究与再锚定证据（soul-drift-reanchor-study）

- 日期：2026-10-17
- 合同：r5-43（.scratch/triage/2026-10-16-r5/r5-43.md）——无-LLM 设计（真实数据挖掘+结构探针，禁 Ark）、研究租户 t-drift-study 隔离探针、产出=漂移定谳+再锚定建议
- 执行：主线接管（子代理 32524d1c 30+ 分钟零工件后由会话主线直接完成；第一版子代理 029ab156 因直连 Ark+占位 key 失败，教训已录）
- 红线遵守：全程零删除、零测试数据注入；写操作仅限研究租户（studyTenant=0 行实证未落任何数据）+只读探针

## 一、数据面发现（生产库 vectors.db 只读挖掘）

### 1.1 soul_snapshots（#30 快照门，9 行）

| 维度 | 事实 |
|---|---|
| 跨度 | 2026-10-16T11:12Z → 2026-10-17T05:04Z+（持续落行） |
| 行为 | 9 行 / 9 个不同 content_hash——指纹变化才落行，**快照门生产证据** |
| 结构演化 | len 2304→2303→2270→2782；`## 我能做什么` cap=false→true（10-17T05:03，=#40 启用时刻）；注入行数 12→24→29 |
| 判读 | 变化节奏≈2.6h/次，与批次工作节奏吻合；05:03-05:04 三连变化=配置启用瞬间的正常指纹抖动，非漂移 |

### 1.2 soul-overlap-journal（#22/#26/#51 观测层，791 行）

- 位置 `D:\TDB\data\logs\soul-overlap-journal.jsonl`（etc/proxy-config.yaml:493 显式启用），最后写入 10-17T13:07（活跃）。
- 13 会话；ts 10-16T15:20 → 10-17T05:07；**norm 字段 0 行**——符合预期：norm=1 随批次末 proxy 重启才写入，#51 两周三档窗口自重启起算。
- **行哈希 jaccard 全部=0**（700 个可比行无一交集）：soul-identity 与 core_memory 无字节级重叠。语义重复（同三段 slots 双注入）是**重排形态**（soul 侧 `- [identity] - …` 包装 vs core 侧裸 bullet），行哈希必然不同 → **#51 的 0.8 归一档对语义级重复结构性失明**（当前形态下永不触发）。这是观测层的边界发现，非缺陷：journal 设计目标是字节漂移监测（对此有效）；语义级去重需归一化/embedding 比对，属后续票议题。

### 1.3 core_values 现状（14 锚）

- 构成：9 active theme + 2 character（求实/严谨 w0.71）+ 1 person（用户 w0.77）+ 1 漂移锚 + 1 retired（测试全绿，软失效正常排除）。
- 权重域 0.5–0.8（active）；存储层有 float 伪影（w=0.32999999999999996，渲染经 weightLabel 不出字节，仅存储形态）。
- **shadow-first 漂移实锤**：`shadow-first w=0.41 v=-1 desc=空`。悬空链定谳：desc 为空 → 身份段价值锚行三重门（desc 空/episode/预算）跳过 → 感受段无 desc 门照渲染 → 产出「审慎提醒 shadow-first」悬空关键词（无身份段对应的裸引用）。数据级根因与六问轮代码级结论（soul-assembler.ts 两段过滤门不同构）完全吻合。

## 二、探针面发现（A4：研究租户活体探针，core 8420）

| 探针 | 请求 | 结果 |
|---|---|---|
| R1 recall 隔离 | POST /v3/recall（x-tdai-* 头=t-drift-study 三元组） | 200 code=0，空 block，soulVersion=sv-57ed4626（空态指纹），零快照落行 |
| R2 introspect 隔离 | POST /v3/soul/introspect {teamId:"t-drift-study",…} | 200 rendered=""、snapshots=[]、孤儿全列、notes 诚实降级（probes-not-provided/evidence-corpus-empty）——**租户隔离实锤** |
| R3 introspect 生产 | 同端点 body=真实三元组，snapshotLimit=3（只读） | 200 len=3304 全量渲染（identity/价值锚/person/品格/红线/capabilities 全段在位）——**#36 端点生产活体验收通过** |
| 零写入核验 | 探针后 SQL 只读复查 | studyTenant=0 行（研究租户未落任何数据）；total 8→9 为真实租户指纹变化的正常落行 |

## 三、漂移定谳

1. **系统级**：注入面无字节级漂移故障——快照指纹门、journal、introspect 三套观测层全部活体就绪且互相印证。
2. **数据级**：唯一漂移锚 = `shadow-first`（空 desc + 低权 0.41 + 负极性），症状=感受段悬空关键词；量级=1/9 active 锚。
3. **度量级**：journal 行哈希口径对语义重复失明（0.8 归一档永不触发）——记录为观测边界，不计缺陷。

## 四、再锚定建议（菜单，待拍板）

- **G1（数据操作，最优方案）**：`shadow-first` 置 retired（软失效、可逆、零删除）——感受段与身份段同步消失，悬空消除；面板可随时重提。属生产记忆库状态机操作，与 P1 红线（禁删/禁注）不冲突，但按惯例留用户确认。
- **G2（零操作）**：保持现状——悬空仅一处、语义无害（「审慎提醒 shadow-first」甚至仍指向真实审慎事项）；待 desc 生成机制（#11 T5 descRefresh 漂移）上线后自然补齐。
- **G3（代码操作，另票）**：感受段补 desc 门与身份段同构（彻底消悬空类）——已在 #22 落地同门修复后，此类只余 desc 空 case；可并入后续票。

**再锚定执行**：批次末 supervisor 全量重锚（RESTART-SOP 五规则）仍是唯一重置动作，等用户在场授权（杀 proxy 中断本会话）；norm=1 两周三档窗口自重启起算。

## 五、探针命令留存（复现用）

```
curl -X POST http://127.0.0.1:8420/v3/recall -H "Authorization: Bearer <key>" -H "x-tdai-service-id: default" \
  -H "x-tdai-team-id: t-drift-study" -H "x-tdai-user-id: u-drift" -H "x-tdai-agent-id: a-drift" \
  -H "x-tdai-session-id: sk-drift-probe-1" -d '{"query":"…"}'
curl -X POST http://127.0.0.1:8420/v3/soul/introspect -H "Authorization: Bearer <key>" -H "x-tdai-service-id: default" \
  -d '{"teamId":"…","userId":"…","agentId":"…","snapshotLimit":3}'
```

## 六、执行记录（2026-10-17 用户拍板：G1 + 推 git + 批次末重锚）

- **G1 已执行**：`UPDATE core_values SET state='retired' WHERE value_id='shadow-first' AND state='active' AND 三元组` → changes=1，total 14 不变（零删除），retired=2；introspect 活体验证 has-shadow-first=False、soulVersion sv-57ed4626→sv-77531f86；真实轮次 soul-feeling 审慎清单悬空消失（仅剩取证先行）。
- **推 git**：本报告按先例 0d1fe22 复制入库 fd8c171；etc/RESTART-SOP.md 与 start-tdb-supervised.ps1（MaxRestarts 3→10）属部署侧本地配置，按 SOP 不入库留磁盘。
- **批次末重锚已执行**：杀监督外 core 7700 + panel 17828 → 新 supervisor pid 10536 takeover（MaxRestarts=10、restartsUsed=0、owned 四服务齐整零监督外：proxy/panel/knowledge/core）→ 四端口 200（8420/8096/8421/8123）。
- **重锚后 E2E 全绿**：#39 redline=action_proximate 活体（`<soul-event kind="redline">` 近端块多次真实出现）；#40 capabilities 段在位；#51 journal norm=1 首行落账（ts 2026-10-17T05:27:36Z，两周三档窗口自此刻起算）；#30 快照门新指纹行继续落账（65915f11/d82ca875/aaff6991）。
