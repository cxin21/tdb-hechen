# #91 生产观察窗证据（2026-10-23）

## 时间线
- 昨夜：c6c877c（#91 实现）commit+push origin main（d98004c..c6c877c）。
- 今晨 08:37:55+08:00：supervisor takeover（state.json startedAt，restartsUsed=0）；tdai-core pid=11256 约于此拉起（/health uptime 1908s @ 09:10 核对）。重启 > 推送 → 代码生效时序成立。
- 09:07：用户授权「你验证一下，没有问题再关票」。
- 09:08-09:09：关票门全新复验（不沿用昨夜绿灯）。

## 关票门（全部亲跑实据）
- MemoryCore typecheck（pnpm run typecheck，cd MemoryCore）：243 错 = 基线逐位。
- MemoryCore vitest：234 files / 2136 tests 全绿（09:08:32 起 17.03s）。
- MemoryProxy vitest：54 files / 469 tests 全绿（09:09:01 起 3.58s）。

## 生产侧证据（只读取证，零写入零注入）
- /health 8420：status ok、vecRows=2099、embedding ok、lastVecWriteAt=2026-10-23T01:09:15.407Z、pipeline tasksConsumed=301/tasksFailed=0。
- supervisor state.json：startedAt=2026-10-23T08:37:55+08:00、restartsUsed=0、owned tdai-core=11256、ports core=8420/proxy=8096/panel=8123/knowledge=8421。
- core cmdline：node --import file:///D:/TDB/etc/logtee.mjs --import tsx src/gateway/server.ts（cwd=MemoryCore → 直载 c6c877c 源码，部署零构建）。
- **flag 状态（决定性）**：core 配置 = D:/TDB/td-agemem/MemoryCore/tdai-gateway.yaml（36567B，mtime 2026-10-20 19:41，#91 实现前未动）——**全文无 selfIdentityGate 键** → reflection.selfIdentityGate.recurrence.enabled 缺省 false（config-first 缺省关）。
- flag 接线（lifecycle-scheduler.ts:202-211）：recCfg?.enabled === true 才调 sweepExpiredSelfIdentityPending；golden 缺省关=零调用逐位。
- 生产库 vectors.db（node:sqlite readOnly + query_only 双保险）：core_pending 431 行（adopted=100/pending=80/rejected=251）；recurrence_json 非空=0、embedding_json 非空=0、attrs_json 非空=397；分界（08:39+08:00=00:39Z）后新行=1。
- 日志三件套：tdai-core-20261023-083743.out.log(+.tee.log) 0B（08:37:45 建，无输出）；上一代 083308（111KB，尾至 08:35:13）含 [identity-discovery] ran: agents=2 adopted=0 pending=0、[lifecycle] reflection triggered=0 cards=0 proposals=0。

## 判定
- 门绿 + 代码已部署 + 机制未破坏现状（缺省 off 逐位）✓
- **生产无 #91 行为证据**：flag 未开（yaml 无该键），recurrence_json=0 与缺省关逐位一致；窗内 reflection triggered=0，即使开 flag 也无自然触发可观察。
- 「关票凭端到端证据与生产观察窗确认」：机制工作性证据不成立 → 呈报用户拍板（开启 flag+重启开窗 / 维持 off 关票 / 继续等待）。
