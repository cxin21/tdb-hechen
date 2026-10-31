# core 8420 宕机（2026-11-01 02:08–02:14）取证与重启方案

> **状态（取证时刻 2026-11-01T03:47+08:00）**：8420 无监听；D:/TDB/data/run/tdb-supervisor.state.json
> 显示 supervisor 41952 的 autoRestart=true / restartsUsed=3（预算已用尽），owned.tdai-core=40852 已不存在；
> panel 35812、proxy 17884 仍活；knowledge 8421 活在 31116。**本文只出方案与命令，未执行任何重启、
> 未改 yaml、未改 config**（用户/Lead 拍板后执行）。

## 1. 结论（按证据强度排序）

1. **进程被「JS 层之外」终止**：四代实例都没有 shutdown/stop 行、没有 uncaught、没有 FATAL、没有 exit code 落盘；
   supervisor 只在子进程**已经消失**后才重启（D:/TDB/etc/start-tdb-supervised.ps1:105-126），唯一主动杀进程的路径是
   host 退出 :99-103 与 takeover :40-42，均不适用。⇒ 排除「应用主动退出」。
2. **事发时 local rerank 通路本身是坏的，且死亡时刻与之强耦合**：历史 149 次 `[rerank] startup warmup done` 全部
   1.6–9.7s、`scores=32, docs=32`；今天最后两代 66.7s / 72.6s 且 `scores=0`。该行格式见
   MemoryCore/src/gateway/server.ts:965-967（`scores=${scores?.length ?? 0}`）⇒ **scores=0 的真实含义是
   reranker.rerank() 返回 null（降级），不是「打了 0 分」**。
   66–72s 是**单次**加载/推理返回 null 的耗时（本地档不吃 `rerank.timeoutMs: 5000`——那是云 provider 的参数；
   本地档的内部预算见 MemoryCore/src/core/recall/rerank/local.ts:100-107：`loadTimeoutMs: 300_000`、
   `inferTimeoutMs: 30_000`、`failureRetryMs: 60_000`），对比历史 2–10s 正常加载 ~15× 慢。
   更糟的是**这次降级完全没有日志**：`markFailed()` 把 reason 直接丢弃（local.ts:293-298 `void reason`），
   所以「加载失败」与「推理失败」在现存日志里**不可区分**（见 §8.7）。
3. **最可能的杀手 K1（置信度中高）**：onnxruntime-node / transformers.js 在 rerank worker_threads 里的**原生崩溃**
   直接带走整个进程（MemoryCore/src/core/recall/rerank/local.ts:192 起 worker；:163-170 只处理 worker 的
   error/exit 事件——原生 abort 不给 JS 侧这个机会）。支撑：3 次死亡中 2 次紧接 S3 rerank 预热收尾后 0–4s
   （25120 → 02:11:24.418 日志；40852 → 02:13:45.854 日志，02:13:47 watchdog 判死），1 次发生在并发 recall
   刚进入 rerank 的时刻（28876 → 02:08:47.152 最后一行是 `[query-expand] timeoutMs clamped`）。
4. **K2（中，未排除）**：安全软件（奇安信天擎 QI-ANXIN + Defender）静默终止 node.exe。本机 AV 无审计日志可读，
   无法证伪；但解释不了 2/3 次死亡与 rerank 步骤的秒级耦合。
5. **K3（低）**：402 配额反压 + CPU 饱和「把机器拖死」。402/2067 只解释 63.9MB 日志、5s recall 超时与
   `[skill-conv-worker]` 忙循环，**不解释静默消失**（配额错误在代码里是一次即死信：
   MemoryCore/src/utils/task-failure.ts:196、MemoryCore/src/services/pipeline-worker.ts:546-547）。

### 1.1 方法学警告（必须记住）

- **「Application 日志没有 node.exe 崩溃事件」不能当成「没有原生崩溃」的证据**：本机 `WerSvc`（Windows Error
  Reporting）= **Stopped**，Application 近 7 天 1875 条事件里 node.exe 相关 0 条。WER 停用 ⇒ 原生崩溃不落该日志。
  要拿崩溃栈必须先起 WerSvc 或配置 LocalDumps（需管理员，本文不含）。
- `CMD` 包装层的退出码无处记录：D:/TDB/etc/tdb-services.common.ps1:129-131 用
  `cmd /d /s /c "node … 1>out 2>err"`，cmd 退出码随包装进程丢失；supervisor 只用 `Get-Process -Id` 判存活（:108）。
  **这就是「无 exit code」的结构性原因**，不是「进程没退出」。

## 2. 时间线（同一 supervisor 41952 内四代）

| 代 | pid | 起 | 止 | 存活 | 死前最后一行 | 旁证 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 20304 | 00:29:23 | 00:39:09 | 586s | （out 768KB） | 00:29:35 rerank warmup 4962ms scores=32 |
| 2 | 28876 | 00:39:10 | 02:08:47 | 89min | `[recall] [query-expand] timeoutMs clamped into recall budget: 8000 → 4000ms` | out 63.9MB / tee 71.7MB / err 7.7MB；`[skill-conv-worker] dequeued` 119782 条、`extract-lock contended` 118684 条；err 里大量 2067/402 配额 |
| 3 | 25120 | 02:08:51 | 02:11:24 | 153s | `[warmup] boot warmup total=70232ms (status=done)`（02:11:24.418） | 前一行 `[rerank] startup warmup done in 66718ms (scores=0, docs=32)` |
| 4 | 40852 | 02:11:28 | 02:13:45 | 137s | `[warmup] boot warmup total=75718ms (status=done)`（02:13:45.854） | 前一行 `[rerank] startup warmup done in 72575ms (scores=0, docs=32)`；02:12:31 `Gateway listening on http://127.0.0.1:8420` |

- 02:13:47 起 supervisor 每 2s 刷 `[watchdog] tdai-core (pid …) died` + `restart budget exhausted (3) - giving up`
  （本实例 2307 组；全局 grep died 50072 条）⇒ 日志刷屏且无时间戳前缀，是 supervisor 自身的观测缺陷。
- 3 次重试用尽即不再重试（D:/TDB/integrations/dsh-tdb-lifecycle/lib/index.js:38 `DEFAULTS.maxRestarts=3`，
  脚本 -MaxRestarts 缺省 10 但实际被插件传 3）。

## 3. 证据矩阵

| 维度 | 读数 | 说明 |
| --- | --- | --- |
| 进程 | 40852 不存在（tasklist 无匹配）；8420 无 LISTENING | 进程真的没了 |
| 端口 | 8444（DSH 插件控制口）LISTENING by 24548 | supervisor 父进程（DSH host）仍活 |
| WER | `WerSvc` = Stopped；Application 近 7 天 1875 条、node.exe 0 条 | **无 WER ≠ 无原生崩溃** |
| System 日志 | 02:05–02:20 只有 Kernel-General 1/24 + Time-Service 35/37（02:09:45） | 无资源耗尽/无蓝屏 |
| 资源 | 内存 31.5GB 总 / 9.6GB 空闲；D 盘 476G 空闲 | 排除磁盘/内存耗尽 |
| 数据库 | metadata.db mtime 01:40:36；vectors.db 01:46:02 | 01:46 后无真实写入（空闲期，不等于死） |
| stderr | 021128.err 3.3KB：只有 experimental warning + 配额 WARN | 无 FATAL/segv/heap |
| rerank 历史 | 151 次有 warmup 行的实例中，149 次 1.6–9.7s / scores=32；今天最后两代 66.7s / 72.6s / scores=0 | **异常点唯一且强相关** |
| rerank 失败痕迹 | 今日全部 core 日志里 `load failed` / `worker crashed` / `infer timeout` 命中 **0 条** | 不是「没失败」，是失败路径不打日志（local.ts:293-298） |
| 模型文件 | `D:/TDB/data/models/reranker/Xenova/bge-reranker-base/onnx/model_quantized.onnx` 279MB，mtime 2026-10-14 11:27 | 排除「今天重新下载/损坏」；transformers.js 4.3.1 |

## 4. 方案 A —— 原样重启（不改一行配置）

**最小改动集：无文件改动。** 目标：先恢复可用性，用第 7 节观测脚本抓下一次死亡的秒级证据。

```powershell
# A1（推荐，最小动作）：只拉起 core，其余三服务已健康会被 skip
pwsh -NoProfile -File D:/TDB/etc/start-tdb.ps1
#   start-tdb.ps1:11 → Start-AllTdbServices（tdb-services.common.ps1:149-156）
#   已健康端口 skip；本脚本 fire-and-forget、无 watchdog —— 必须配第 7 节观测脚本
```

- **不要**直接 `pwsh -File D:/TDB/etc/start-tdb-supervised.ps1`：41952 仍活着并持有 state file，新实例会走
  takeover（:40-42 `taskkill /PID 41952 /T /F`）把 panel/proxy 一起杀掉。若确实要恢复自动重启，先由 DSH 侧
  （插件 lifecycle 开关）停掉 41952，再启 supervisor：
  `pwsh -NoProfile -File D:/TDB/etc/start-tdb-supervised.ps1 -ParentPid 24548 -MaxRestarts 3`
  （24548 = 当前 DSH host pid；参数表 :15-22）。
- 验收：`curl -s http://127.0.0.1:8420/health` 200，且日志出现 `Gateway listening on http://127.0.0.1:8420`
  （本轮实测 listen 在启动后 ~63s，因 metadata store pool 先就绪）+ 随后 `[warmup] boot warmup total=… (status=done)`。
- 已知风险：warmup S3 若仍 66–72s / scores=0，按 K1 高概率 0–5s 内再次静默死亡（第 2 节第 3、4 代）。
  所以 A 必须与观测脚本同跑。

## 5. 方案 B —— recall-only 降载重启（判据用，非默认）

**目的**：摘掉「LLM 侧持续失败（402/2067）」与「native rerank」两条负载，看 core 能否长存活，从而把
K1 与 K2/K3 分开。**最小改动集 = 3 行 yaml**（`MemoryCore/tdai-gateway.yaml`，git tracked）：

| 行 | 现值 | 改为 | 关闭的消费点（读码证据） |
| --- | --- | --- | --- |
| :576 | `memory.lifecycle.enabled: true` | `false` | **唯一真总闸**：MemoryCore/src/gateway/server.ts:2609 `if (lifecycle.enabled !== false && lifecycleStore)` → 才 `startLifecycleScheduler`（:2611-2633）。关掉 ⇒ consolidation / identity-discovery / anchor-growth / evolution / reflection / self_identity 扫描 + auto-adopt / forgetting 全部不起跑（lifecycle-scheduler.ts:243-264，:245 早退）。 |
| :664 | `skill.enabled: true` | `false` | skill worker 池闸：server.ts:3095-3099 `getResolvedSkillConfig()` 为 null → `[skill-worker-pool] … pool not started`；standalone 侧 :3228 抛 `SkillCore not enabled (standalone)` ⇒ `/v3/skill/conversation/add` 变 4xx/503。 |
| :359（仅 E1 实验用，可选） | `memory.recall.rerank.enabled: true` | `false` | server.ts:953-955 `warmRerank` 早退（S3 整步跳过）⇒ 启动不再有 66–72s ORT 批量推理；召回走降级原序（rerank 失败本来降级，不阻断主链路）。 |

**Plan B 不做什么（别误信）**：

- `memory.extraction.enabled=false` **不是**有效闸：全仓唯一消费点 MemoryCore/src/core/tdai-core.ts:253（只管 legacy
  manager）；gateway 路径的 StatefulPipelineManager 无条件建（server.ts:2500-2510）、PipelineWorker 无条件起
  （:2548-2572）、notifyPipeline 接线于 :1536-1544 ⇒ **关掉它 L1 仍会入队并真调 LLM**
  （core.runL1WithStore → tdai-core.ts:1123-1206）。
- `skill.extraction.enabled=false`（yaml:671）**不能用**：关掉只是让 extractor 不可用，队列条目照旧、worker 照旧
  consumeAgent → transient 无限 requeue（server.ts:3243-3247 注释原文即此语义），比开着更糟。
- config-override.json **关不了**这两个开关：白名单只有 llm / embedding / rerank / importancePenalty / worthiness /
  extraction(scenePoisonSplit, sceneBatchMaxChars)（MemoryCore/src/gateway/settings-override.ts；合并点
  src/gateway/config.ts:501-519）；env 只有 `TDAI_SKILL_ENABLED`（src/gateway/config.ts:616）且只用于**强制开启**。
  ⇒ Plan B 只能改 yaml（这也是本票不改 yaml、把 diff 交 Lead 执行的原因）。
- B 之后 `/v3/recall` 仍可用（召回/注入不受影响）；L1 抽取仍打 LLM（见上），要彻底停 LLM 须同时停写入面，不在本票范围。

**执行顺序（Lead 拍板后）**：
1. 备份：`mkdir -p D:/TDB/data/backup && cp MemoryCore/tdai-gateway.yaml D:/TDB/data/backup/tdai-gateway-$(date +%Y%m%d-%H%M%S).yaml`
2. 改上表三行（改前先 `grep -n "enabled: true" MemoryCore/tdai-gateway.yaml` 确认行号——并行改动会让行号漂移）
3. 重启 core（同 A1 命令），同跑第 7 节观测脚本

## 6. 回滚命令

```powershell
# 6.1 三行改回（Plan B 回滚）
#   MemoryCore/tdai-gateway.yaml:576 → memory.lifecycle.enabled: true
#   MemoryCore/tdai-gateway.yaml:664 → skill.enabled: true
#   MemoryCore/tdai-gateway.yaml:359 → memory.recall.rerank.enabled: true（若改过）
# 6.2 或用备份整体覆盖（最省事，等价于回到改动前）
cp D:/TDB/data/backup/tdai-gateway-<stamp>.yaml MemoryCore/tdai-gateway.yaml
# 6.3 回滚后必须重启 core 才生效（配置只在启动时读，无 --watch）
#     起：pwsh -NoProfile -File D:/TDB/etc/start-tdb.ps1
#     停：若 core 由 start-tdb.ps1 拉起（无 supervisor 守护），停 = taskkill /PID <core pid> /T /F
```

> `git restore -- MemoryCore/tdai-gateway.yaml` 也能回滚，但会把**别人**对该文件的未提交改动一起丢弃 —— 只在确认该文件无他人改动时使用，由 Lead 裁决。

## 7. 观测脚本用法（scratch/task106/watch-core.mjs，只读）

```bash
# 缺省：2000ms 一 tick，盯 8420/health + 最新 tdai-core-*.out.log 的新增标记行，Ctrl-C 收尾
node scratch/task106/watch-core.mjs
# 重启 core 时同跑（把 pid 一起盯上，进程消失立刻打 <<< PROCESS GONE >>>）
node scratch/task106/watch-core.mjs --pid <新 core pid> --interval 500
# 脚本化：只跑 5 分钟；退出码 2 = 观察到死亡
node scratch/task106/watch-core.mjs --duration 300 --interval 500; echo "exit=$?"
```

| 现象 | 判据 |
| --- | --- |
| `[boot]` 出现两条（`[rerank] startup warmup done` + `[warmup] boot warmup total`）后 health 仍 200 | 本次未复现「warmup 后静默死」 |
| 两条 `[boot]` 后 0–5s 内 `[health] FAIL` 且 `<<< PROCESS GONE >>>` | 复现，死亡紧贴 rerank 步骤 ⇒ K1 方向成立 |
| 关掉 rerank（Plan B 第三行）后仍同样复现 | 排除 K1 ⇒ 转 K2（AV 静默终止）/ K3，需 WerSvc + LocalDumps 或 AV 审计 |
| 进程仍在、health 200，但日志 T 之后完全静止 | 不是崩溃，是空转/阻塞（另案） |
| 进程消失但日志最后一行早于消失 >10s | 死前已有静默期，重点看 tee 日志与 stderr |

脚本不写任何文件、不重启服务、不改配置；日志务实读（增量 offset，首读回看最后 256KB），只打印标记行
（`[warmup]`/`[rerank]`/`ERROR`/`FATAL`/`shutdown`/`died` 等），不污染终端。

## 8. 未证实项（诚实边界）

1. **无崩溃栈**：WerSvc 停用、无 dump，K1 只是「时间耦合 + rerank 通路异常」的推断，**不是实证**。
2. **无 AV 审计**：奇安信天擎是否拦杀 node.exe 未查（需其控制台权限）。
3. **无包装层退出码**：cmd 退出码未落盘（结构性观测缺口）；可在启动脚本里落 `%ERRORLEVEL%` 补，但属改启动脚本，不在本票写权限内。
4. **本次未做活体验证**：按 Lead 指令不重启任何服务，Plan A/B 的实际存活曲线为空。
5. **402 配额真源**：MiniMax 配额耗尽已确认（err 里 402 + 2067 文案），但「配额耗尽与 89 分钟 63.9MB worker 忙循环是否互为因果」未证。
6. **rerank 为何今天从 2–10s 退化到 66–72s / scores=0** 未定根因（模型文件 mtime 未变，排除重新下载；
   候选：onnxruntime-node 原生初始化退化、CPU 节流、AV 实时扫描加载中的 279MB 模型）。判据见 §7 第 3 行。
7. **rerank 降级无日志**（观测缺口，建议另派小票）：MemoryCore/src/core/recall/rerank/local.ts:293-298
   `markFailed(reason)` 里 `void reason` 把原因丢弃，`killWorker` 也不打日志 ⇒ 生产上「rerank 静默降级」
   与「rerank 从未启用」无法区分。建议按一次 WARN + 观测计数落地（不在本票写权限内）。
8. **supervisor 日志刷屏**：预算用尽后每 2s 重复 `died` + `budget exhausted`（无时间戳前缀，105504 行 / 6.2MB）
   淹没真实事件，属 D:/TDB/etc/start-tdb-supervised.ps1:105-126 的观测缺陷，建议单独修（非本票范围）。
