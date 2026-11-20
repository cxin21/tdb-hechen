# 记忆星图 UI 验收用例（2026-11-11）

测量对象：http://127.0.0.1:8123（MemoryPanel 新壳，星图为默认入口）。
会话注入：localStorage 键 tdai-panel.session = {"instanceId":"default","userKey":"hechen","user":{"user_id":"usr-2m7b1144d9"}}。
执行者：自动化脚本 .scratch/ui-test-runner.mjs（断言 + 截图）+ 人工/代理浏览器走查。

## A. 入口与登录

- TC-A1 未注入会话时打开 /，必须停在登录页（出现 .login-gate 或登录按钮），不得白屏。
- TC-A2 登录页视觉与星图同风格：深色底、无大面积白块（人工判读截图）。
- TC-A3 注入会话后 30s 内出现 canvas.fb-canvas 且 data-testid=five-bodies 存在。

## B. 四云与数据

- TC-B1 data-counts 含 memory/wiki/code/skills 四项；memory 的 L0/L1/L2/L3 至少一项 > 0。
- TC-B2 wiki 云 total > 0 时 lit 必须 <= total；lit=0 且 total>0 视为「已连接但未分配」，不判失败但要在卡片写明。
- TC-B3 code 云 total = 0 时云名计数显示「暂无」，不得显示 0/0 冒充有数据。
- TC-B4 skills 云 total >= mounted，且卡片显示 已挂载/团队可见 两个数字。
- TC-B5 首屏错误容忍：单个接口失败时页面仍渲染其余云，并在底部状态条列出失败项（不是整页报错）。

## C. 聚焦

- TC-C1 单击忆云后 URL 出现 cloud=memory，右侧聚焦卡出现「忆云 / 进入 / 返回全景」。
- TC-C2 聚焦态只画忆云：data-centers 的键集合应为 {memory}（允许短暂过渡，3s 内稳定）。
- TC-C3 按 Escape 或点「返回全景」后 URL 去掉 cloud 参数，四云全部回来。
- TC-C4 直接访问 #/?cloud=wiki 必须直接进典籍云聚焦态（刷新/分享可复现）。
- TC-C5 聚焦态滚轮缩放仍生效（画布数据或截图尺寸变化可见）。

## D. 星点与卡片

- TC-D1 点击任一星点出现 .fb-sel 卡片，含 对象/状态/关联线/进入/看人格卡。
- TC-D2 星点卡片「关联星点」清单条目数与关联线数一致（最多 8 条），点条目后卡片切换到该星。
- TC-D3 忆云 L1 星点必须能追到 L0：data-mem-l0-edges > 0（当前实测 35）。
- TC-D4 人物星点（金色）点击后出现 data-testid=person-detail，显示名字与关系边数，「进入人物档案」跳 /soul。
- TC-D5 点人格恒星核心进入 /soul 人格站台。

## E. 站台与旧功能覆盖

- TC-E1 六个星门（记忆/人格/知识/代码/技能/团队）+ 设置可打开，抽屉不遮挡返回路径（点遮罩回 /）。
- TC-E2 记忆站台：层切换 L0/L1/L2/L3 有数据，块详情可开。
- TC-E3 知识站台：wiki 列表、同步重建、删除三条写入口可见（写操作不在自动用例里执行）。
- TC-E4 技能站台：技能列表与挂载状态可见，搜索可用。
- TC-E5 团队/成员/API Key/设置四页在 /legacy 下仍可访问（旧壳兜底）。
- TC-E6 旧壳顶栏「使用说明」当前无路由，点开为空 —— 已知缺陷，登记不判失败。

## F. 权限与边界

- TC-F1 未选团队/智能体时星图显示「先选团队与智能体」，不发数据请求。
- TC-F2 切团队后所有云重新取数，URL/localStorage 记忆块归属不串租户。
- TC-F3 越权资产不出现：切换到一个无 wiki 权限的团队时，典籍云应为空且卡片写原因。
- TC-F4 写操作（同步/删除/新建）必须由人点击触发，自动化用例只验证入口存在。

## G. 完整视图（原 panel 深操作落点）

- TC-G1 七个站台加 ?full=1 后抽屉内出现 .st-embed，且正文非空（/team 本身也落到成员页，不只 /team/members）。
- TC-G2 抽屉「简版视图」去掉 full=1，.st-embed 消失，回到星图简版。
- TC-G3 刷新 #/wiki?full=1 后完整视图仍在（深链可复现）。
- TC-G4 知识完整视图默认停在团队 Wiki 池，页签写「团队 Wiki 池 N」，N>0 时正文出现知识库名与「编辑源 / 重新拉取 / 分配」，不得只显示「没有匹配的 Wiki」。
- TC-G5 代码完整视图默认停在团队 Code 池；当前团队仓库数为 0 时显示「暂无已注册仓库」和「注册仓库」，不得白屏。
- TC-G6 设置完整视图对非管理员只显示「仅管理员可访问设置页」，这是权限门，不判失败。

## 执行记录

自动化脚本输出 PASS/FAIL 清单与截图目录 .scratch/ui-test-<时间>/。


## H 团队本体

- TC-H1 顶栏有「新建」按钮（title=新建团队），点开出现 data-testid=team-dialog，含名称与说明输入。
- TC-H2 非管理员不出现「编辑」「删除」。当前账号 usr-2m7b1144d9 对 default-team 不是 owner/admin，顶栏不得出现 title=删除当前团队。
- TC-H3 保存走 teamsApi.create（meta team/create），成功后 writeActiveTeamId 再 invalidate。验收用一次性团队，建完即删，不留生产行。
