# 移交文档：设计↔实现全面复查 + 未完成闭环 + UI 2.0（2026-09-19 深夜）

> 本文档供新会话接续使用（自包含）。上一会话完成：09-19 三方审计（33 项）→ 批次一/二/三修复（F-EV12-1/2/2b/4/5、F-EV13-1、A-3 勘误、A-6 spec 同步）→ UI 实测轮（U7 回归修复+存量修复）。详见 `2026-09-19-soul-audit-report.md` + `2026-09-19-remaining-work-v6.md` + CHANGELOG 顶部四节。

## 使命与原则
对照设计文档（唯一权威基准）全面复查设计与实现：遗漏补全、错误修复、未完成项完成。**原则=自生长、自维护**：任何"等人操作/等人发现"的环节都是设计缺口；所有身份相关写入面必须过门（单一源）；宁缺毋滥；LLM 只提议、确定性门裁决。

## 环境与访问（本地 Windows+PowerShell）
- ssh：`ssh -i "$env:USERPROFILE\.ssh\id_ed25519_tdai" -o BatchMode=yes ubuntu@43.143.239.154`
- 仓库：`/opt/tdai/td-agemem`（部署即仓库，main 直改）；写盘/测试 `sudo -H -u tdai`，git `sudo -H -u tdai git`；push origin main
- 服务：core 8420 / proxy 8096 / knowledge 8421 / panel 8123（systemd tdai-*，tsx 直跑，重启即生效）
- DB：`/data/tdai-memory/vectors.db`（node:sqlite readOnly 核对；写态操作仅限测试租户）
- 密钥：`/opt/tdai/etc/env`（600 root）——绝不回显、不入报告/对话；Panel 登录 user_key=TDAI_GATEWAY_API_KEY
- LLM：已换 ark 套餐（config-override.json）；**改 override 后须重启两次才生效**（活体避坑 09-19）

## PowerShell 避坑（高频）
多行命令/含引号命令一律：本地 write 脚本 → `base64` 编码 → `echo '<b64>' | base64 -d > /tmp/x && bash /tmp/x`；禁止内联 node -e/python -c（引号必碎）；grep 锚失败会中断 && 链（先 tail 看全输出再断言）；补丁脚本必须 count==1 锚+读回验证+显式 ABORT（防部分写入）。

## 必读（动手前按序）
1. `docs/superpowers/specs/2026-09-17-soul-memory-design.md`——唯一权威基准（392 行；§2.5 双槽/§2.6 锚层三池/§2.7 渲染/§2.8 调度/§4 属性表/§5 公式 F1-F20/§6.5 UI/§7 分期）
2. `docs/superpowers/plans/2026-09-19-remaining-work-v6.md`——未完成台账（本清单与其差异以台账为准）
3. `docs/superpowers/plans/2026-09-19-soul-audit-report.md`——33 项审计判定+勘误（注意 #27 已勘误改判）
4. CHANGELOG 顶部四节（审计修复轮一/批次二/三/UI 轮）——已修项与验证记录勿重做

## 当前基线（HEAD 0dcc8ea，2026-09-19 深夜）
- MemoryCore：vitest **636/636**、tsc **222** 存量债持平；MemoryPanel：vitest **112/112**、web vite build 成功、web tsc 余 **2 存量错**（ValueAnchorsPanel:347/:350，ChatMemorySearchHit 类型债，已登记）
- 四服务健康；生产桶锚：theme 15/15 满、person 2；ev13 测试租户已全流程验证（23 L1、双 p- 锚、双 theme 锚、identityRefs 回填 0→2、身份门活体拦截）
- LLM：ark 套餐正常（直连探针 HTTP 200）；embedding=ark doubao（独立配额）

## 任务清单（按序；每项走"检查规范+验证 SOP"）

### P0 对照复查（主任务）
对照设计文档逐节复查设计与实现一致性（§0-§10+附录 A），每节产出判定表：设计原文摘录 | 代码 file:line | 真数据证据 | ✅⚠️❌📝 | 差异说明。已知重点复核项：
- **F-EV13-1 残余**：identityFactMatchesCorpus 12 字滑窗对"摘要式改写"不足（ev13 二轮实测：GROW-MAINT unsupported=2 含残余假阳、character 提案「守诺」依赖槽行逐字仍拒采）——彻底解=A-7b
- **A-7b 证据指针（设计级，方案已定向）**：identity-discovery 提案协议增补"支撑样本指针"——LLM 输出支撑样本编号→校验在样本窗内→identityRefs 记 record_id 引用；GROW-MAINT=引用行仍 active 即支撑；F14 保护=引用行在即保护。触及 prompt 协议与 ref 语义：先出设计小节→TDD→对抗审查
- web tsc 残余 2 存量错；ev13 character 采纳待 A-7b 后活体复验
- 自生长/自维护视角全面扫描：凡"等人操作/等人发现"环节=缺口；所有身份写入面是否都有门

### P1 UI 2.0 重设计（用户明确不满：太丑、信息不全）
硬需求：①**灵魂页签从 Chat_Memory 独立成一级页**（身份双槽/价值锚三池/品格锚/重要的人/感受段完整呈现）；②**记忆属性与关系全景**：19 列属性（certainty/valence/arousal/significance/双时态 valid_start-end/来源/scene/版本演化）、l1_links 关系图（similar/evolve/conflict/derived_from/part_of）、refs 反向链（coreRefs/personRefs/identityRefs 反查）、pending 裁决流、锚池配额健康条（15/8/8 用量）；③对照 UI redesign spec（2026-09-10）规范做视觉升级。
流程：**先出设计稿**（信息架构/分区/组件/数据映射/交互）→用户确认→再实施（TDD+面板基线）。

### P2 gated（仅登记，实施前逐项问用户）
测试数据清理（ev12/ev13 种子与夹具+旧 ev*/ta-team/xtest 八表）；D2 预注册 A/B 启动（标注 367/正例 82 已达标）；P3 sensitivity；selfIdentity.intervalHours 1→24；maxPerPass 3→2 定格；neighborExpand 重开（归档节点经图回流需拍板）；T7b Claude Code 场景实测。

## 验证 SOP（每项必过，缺一收口无效）
1. TDD：RED 用例先行（新测试文件，旧用例保持绿）
2. 补丁：python 锚点唯一（count==1）+读回验证+显式 ABORT；CRLF 探测
3. 门禁：MemoryCore vitest ≥636 全绿 + tsc 222 持平；MemoryPanel vitest 112 + web vite build 成功
4. 真实数据：≥10 组全新租户对抗种子（身份设定/角色指派/尊称驯化/定时状态/合法自证/第三方人物/agent 行为事实/跨租户隔离/遗忘保护对照），`/v3/conversation/add`（**body 传 session_id**，x-tdai-team/user/agent-id 三头+Bearer+service-id: default）→ 等 L1 提取（~3min，journal markL1ExtractionComplete extracted>0）→ 等 lifecycle tick（10min）发现轮 → DB 只读核对（core_memory 槽零对抗词/core_values 锚 shape/refs 回填/state 键）→ `/v3/recall` 注入块逐行审读（来源/主语/属性/公式/场景）→ 跨租户隔离探针
5. UI：browser 打开 panel 8123（登录用 user_key，请用户输入）→ 各分区截图+DOM 断言（querySelector 文本）
6. 文档：CHANGELOG+v6 台账+相关 spec 同步（文档-代码不分离）
7. 密钥扫描（diff grep sk- 等=0）→ commit（sudo -H -u tdai）→ push → 重启对应服务 → 活体复测

## 已知结论勿重做（勿翻案，除非有新证据）
- F-EV12-1/2/2b/4/5、F-EV13-1 已修（CHANGELOG 有案）；A-3 悬空边=非缺陷（B3 裁决 sqlite.ts:1951，级联删边会断证据链）；agentAct 标注=不做（self_identity fallback 代偿，spec 已注记）；审计 33 项中 22✅ 的项勿重复审计——抽查即可
- identityFactMatchesCorpus：<4 字不命中；f===c 命中；统一 strip 列表前缀（probe 实证教训）
- E3/结论层缓存键已含租户三元组；空 sessionKey 关断只在检索通道（结论层走 default 占位键+租户后缀）
- 面板 web 构建必须 vite build（esbuild 无类型检查——tsc 需单独跑，存量 2 错勿慌）

## 输出要求
每项判定表；收口四态（DONE/DONE_WITH_CONCERNS/NEEDS_CONTEXT/BLOCKED）+ commit hash + 一行摘要 + 疑虑清单。**宁可 BLOCKED+诚实清单，不许粉饰收口。**
