# ADR-0017 资产读授权口径：get / list 与归档可见性

- **状态**：已接受（2026-10-30，issue #116 实施；同日收尾追加：两条 list 端点合并为 `collectVisibleAssets` 并统一排序口径）
- **关联**：#116（fix(memory-core): asset/get 与 asset/list 缺调用者过滤，水平越权）；上游 TencentCloud/TencentDB-Agent-Memory 的 `v3/meta` 资产读实现（本决策以其为起点，归档口径与上游不同，见决定 3）
- **域词典**：[CONTEXT.md](../../CONTEXT.md) → 资产读授权口径（caller read authz）

## 背景

`asset/get` 与 `asset/list` 一度把鉴权上下文丢弃（路由参数写成 `_c`），直接落到 `getAssetById` / `listAssetsByTeam`：任意持 `asset_id` 的调用者能读他人资产元数据，任意成员能分页枚举整个 team 的全量资产（含他人 private / restricted）。#116 修复了越权，但在收尾 review 里暴露了两个**口径不一致**问题：

1. **归档口径分裂**：`asset/list`（caller 视图）对 owner 短路放行，归档/弃用/失败状态的资产照常出现；`asset/list-accessible` 则用 `FILTERED_STATUSES` 无条件剔除这三种状态。同一个团队资产在两条列表通道里可见性不同，前端两个 tab 各说各话。
2. **restricted 资产的 ACL 形同虚设**：`checkAssetPermission` 的快速路径先按 visibility 判死，只有 `no_permission` 才懒加载 ACL，于是 `acl/grant` 对 `visibility=restricted` 授予的权限永远不生效（本票内一并修复）。

同时 `agent` 主体的 ACL（`subject_type=agent`）没有任何用例覆盖，等于未验证的通道。

## 决定

1. **单条读（`asset/get`）**：`system_admin` 豁免 → owner 恒可读（**含 archived**，管理/恢复路径必须可寻址）→ 其余调用者走 `checkAssetPermission`。无权返回 `null`，路由层映射为 **404**，文案与「资产不存在」完全一致（不返回 403，不泄露资产存在性）。实现：`MetadataService.getAssetForCaller`。
2. **列表读（`asset/list`、`asset/list-accessible`）**：先做成员校验（非 `active` 团队成员 → 空页、`total=0`，不报错以免泄露 team 信息），再逐条可见性判定，**过滤在分页前完成**，因此 `total` 恒为「可见集合」的总数。`list-accessible` 额外保留既有的 visibility 白名单与 agent 通道语义。两个端点共用同一个采集器 `MetadataService.collectVisibleAssets`（team 列表 + 分页扫描 + 跨 team 去重 + 归档/visibility 剔除 + `canRead` 判定 + 统一排序），端点之间只差「传哪些 team、判定用谁」——`asset/list` 传单 team 与 `canReadAsset`（admin 恒 true），`list-accessible` 传用户全部 team 与 `checkAssetPermission`（带 `agent_id`）。
3. **归档口径单一谓词**：`isHiddenFromDefaultList(asset)`（内含 `FILTERED_STATUSES = ["archived","deprecated","failed"]`）是唯一判定源，`asset/list`、`asset/list-accessible`、`agent-fixed-asset/list-with-detail` 共用。**默认列表隐藏这三种状态（对 owner 与 system_admin 同样生效）**；只有 `asset/list` 的显式 `status` 过滤才可能返回它们，且返回前仍要通过可见性判定（非 owner 查他人归档资产即使显式过滤也是空的）。单条 `get` 不受此谓词影响。
4. **ACL 不得放宽 visibility**：`private` 恒只有 owner 可读，`acl/grant` 授予 `private` 资产 read 一律无效（有意保留的严格态，防止「授权绕过私有」）。`restricted` 是严格 ACL 白名单：非 admin 成员/agent 只有 ACL 命中才放行；admin 不受 visibility 限制但同样不能被 ACL「加宽」到 private 之外。
5. **ACL 查表时机**：快速路径不再无条件先行；`restricted` 资产对非 admin 调用者必定补查一次 ACL 记录后重判，其余情形保持「先 visibility、`no_permission` 才查表」的懒加载。这是 #116 追加修复的核心改动。
6. **agent 主体是 opt-in 通道**：`subject_type=agent` 的 ACL 只在调用方显式传 `agent_id` 时参与匹配（`acl/check`、`asset/list-accessible`）；不传时 agent 侧授权完全不生效，避免「某个 agent 被授权后所有成员读同一资产」的隐性加宽。
7. **判定单一源**：权限判定只在 `PermissionChecker.checkPermission` 内（owner → 非成员 → visibility → 角色默认 → ACL → deny）。service 层只负责 caller 视图编排（`getAssetForCaller` / `listAssetsForCaller` / `canReadAsset`），路由层不自行判定、不再出现丢弃上下文的直读端点。

## 理由

- **为什么无权是 404 而不是 403**：403 等于承认「资产存在但你无权」，可被用来枚举 id 空间；404 与不存在同文案把「不存在」与「无权」压成一个观测面，是水平越权的最小泄露形态。
- **为什么 get 与 list 的归档口径不同**：显式寻址（get）是管理/恢复路径，owner 必须能读到归档资产；默认视图（list）是「日常可见面」，把归档塞进去只会让人误以为资产还在服役。口径差异不是不一致，而是两种不同的读意图，必须在文档层写清而不是靠端点各自约定。
- **为什么统一到一个谓词**：三个列表端点各自写 `FILTERED_STATUSES.includes(...)` 是口径漂移的典型起点（本次就是如此）；把谓词收敛成一处，新增端点复用即可，测试也只需钉一处行为。
- **为什么 agent 通道必须 opt-in**：agent 是「代表某个用户/流程执行」的主体，权限应随调用方声明的 agent 身份走，而不是在后台默默叠加；opt-in 让权限来源在请求里可见、可审计。
- **为什么最终仍把两个 list 端点合并成 `collectVisibleAssets`**：首轮 review 时以「会重写两条线上路径、超出 #116 范围」为由不采纳。收尾时发现不合并的直接代价已经兑现——两个端点各自维护扫描循环，排序口径随之分叉（`list-accessible` 自己 `sort`、`asset/list` 吃 store 的返回序）。既然排序必须显式化，复制两遍就是下一次口径漂移的起点，于是抽出采集器：端点只保留「成员校验 + 判定函数」两处差异，扫描/去重/剔除/排序只有一份实现。

## 后果

- **读放大**：`asset/list` 对每个候选资产逐条 `checkAssetPermission`（每页扫描 100 条），团队资产多时是 O(N) 次判定；这是「total 必须准确」的代价，暂不做批量权限查询。合并采集器后连 `system_admin` 的显式 `status` 过滤也走全量扫描（此前由 store 的分页 SQL 直接切页），管理面在大团队上多一次全表读；换来的是同一套排序与剔除口径。
- **行为变化**：owner 默认列表不再出现自己的归档/弃用/失败资产，需要显式 `status` 过滤；MemoryPanel 若依赖默认列表展示归档需调整。
- **排序口径已统一且显式**：两个端点都由 `collectVisibleAssets` 在末尾按 `created_at` 倒序排序，`asset/list` 不再依赖 store 的返回序（sqlite 恰好已是 `ORDER BY created_at DESC`，Mongo 等实现不保证；测试用「返回 asc 序的 store 子类」钉住这一条）。副作用：`asset/list` 的稳定序从「store 给什么算什么」变成确定的 `created_at DESC`（created_at 相同者相对序未定义，与 `list-accessible` 此前的行为一致）。
- **测试护栏**：`MemoryCore/src/metadata/router/v3-meta-router.asset-caller-authz.test.ts` 25 条用例钉住七件事——非成员 404 与不存在同文案、非成员空页 total=0、owner/admin 行为不变、restricted 的 ACL 生效、private 不被 ACL 放宽、归档口径与 agent 主体通道、两个 list 端点同一采集与排序口径（含 store 返回序非倒序时的免疫）。
- **文档债清零**：此前读授权口径没有任何书面记录，只能靠读三个文件的实现推断；本 ADR 是它的单一出处，后续调整（如引入批量权限查询）须回改此处。
