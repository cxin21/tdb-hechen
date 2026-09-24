# 灵魂演化层 M1 详细实施计划（S-FEEL-1 近期情绪基调行）——DS-SOUL-EVOLUTION-001 配套

- 日期：2026-09-24
- 状态：实施计划定稿（file:line 级别；上游=DS-SOUL-EVOLUTION-001 v3 @62f3eb1；用户令「写详细一点，我要在新的会话做」）
- 执行者纪律：新会话按本计划串行执行 S1→S10，每步读回验证；RED 先行；禁子代理；行为变更 A/B ≥10 组；全链缺省关断（enabled=false=逐位现状），生产租户启用=A/B 后逐项呈报

---

## §0 开工前核验清单（全部通过才动手）

1. `git -C /opt/tdai/td-agemem rev-parse --short HEAD` ≥ 62f3eb1（本计划基于该锚点），脏区=3 个未跟踪 eval labels（已知，非代码）。
2. 门禁基线：MemoryCore `npx vitest run`（**vitest v4，禁止 --reporter=basic**）=758/758；`tsc --noEmit -p tsconfig.typecheck.json`（**必须 -p 指定，-p . 会 TS5057 假 1 错**）=222；MemoryPanel `npx vitest run --reporter=basic`（v2.1.9 可用）=144/144；web tsc=2。
3. 云端技能拉取：td-agemem-tencent-deployment · td-agemem-webui-remote-patch-sop · td-agemem-soul-injection-anatomy · td-agemem-ev21-v7-handoff-notes。
4. 读 DS-SOUL-EVOLUTION-001 全文（§1/§7.1/§8 R-A/§10 IF-1/IF-2 为本计划依据）+ 母 spec §2.7。
5. 本机=Windows PowerShell：多行/含引号/含 `$(...)` 命令一律本地写脚本→scp→bash（内联必碎，三次实锚）。

## §1 改动总览

| # | 文件 | 动作 | 内容 |
|---|---|---|---|
| 1 | MemoryCore/src/core/store/types.ts | 修改 | IMemoryStore 增可选方法 recentAffectSignals?（IF-1） |
| 2 | MemoryCore/src/core/store/sqlite.ts | 修改 | recentAffectSignals 实现（只读 SQL） |
| 3 | MemoryCore/src/core/hooks/mood-line.ts | 新增 | 纯函数聚合（单一源）+类型 |
| 4 | MemoryCore/src/core/hooks/mood-line.test.ts | 新增 | RED ≥8 用例 |
| 5 | MemoryCore/src/core/hooks/soul-assembler.ts | 修改 | 感受段 mood 行 + buildSoulPrefix opts.moodTier + computeSoulVersion 可选第三参（IF-2） |
| 6 | MemoryCore/src/core/hooks/__tests__/soul-attr-inject.test.ts（或新建 mood 渲染测试） | 新增/修改 | 渲染守卫（缺省逐位快照断言） |
| 7 | MemoryCore/src/core/hooks/auto-recall.ts | 修改 | :671-680 调用点接 mood 计算+outcome 透传 |
| 8 | MemoryCore/src/gateway/v2-router.ts | 修改 | :1653-1669 meta 增 mood? |
| 9 | MemoryPanel/src/panel/http/routes/chat-memory.ts | 修改 | :1630 邻近新增 POST /chat-memory/mood 路由（透传 core） |
| 10 | MemoryPanel/web/src/pages/SoulPage/SoulFeelingBar.tsx + soul-page.css + i18n zh-CN/en-US | 修改 | 「近期基调」副行（三态徽标+tooltip） |
| 11 | MemoryCore/tdai-gateway.yaml（**gitignored 不入库**） | 配置 | memory.coreMemory.moodLine 段（M1 验收期仅测试租户开启） |

预计净增 ~300 行（含测试）。

## §2 实施步骤

### S1 store 接口与实现
- types.ts:727 listValues 声明之后追加：
  `recentAffectSignals?(tenant?: CoreTenant, opts?: { windowHours: number; maxSamples: number }): MaybePromise<Array<{ valence: number; arousal: number | null; occurred_at: string }>>`
  ——**可选签名**（ILogBackend debug? 先例）：缺实现时调用侧静默省略基调行。
- sqlite.ts:2418 listValues 方法之后追加实现；SQL：
  `SELECT valence, arousal, occurred_at FROM l1_records WHERE team_id=? AND user_id=? AND agent_id=? AND valence IS NOT NULL AND occurred_at >= ? ORDER BY occurred_at DESC LIMIT ?`
  （l1_records 列实锚：sqlite.ts:780-781 ALTER TABLE valence/arousal REAL）；窗口起点=now − windowHours×3600e3 ISO；租户三元组硬隔离（F18 同款）。
- 验收：sqlite store 单测（同租户隔离/NULL 排除/LIMIT）≥3 用例。

### S2 mood-line.ts 纯函数（RED 先行：先写测试再实现）
- 导出：`computeMoodTier(samples: Array<{valence:number; arousal:number|null; occurred_at:string}>, cfg: {minSamples:number; maxSamples:number; posThreshold:number; negThreshold:number; halfLifeHours:number; nowMs:number}): { tier: "positive"|"neutral"|"strained"|null; sampleCount: number }`
- 公式（spec §1.2 逐字）：w_i=2^(-age_hours_i/halfLifeHours)；mood_valence=clamp(Σ(v·w)/Σw)；三档映射 ±0.15。
- RED 用例（≥8）：①空数组→null；②样本数<minSamples→null；③全部 valence NULL 过滤后不足→null；④半衰期加权正确性（构造 2 样本手算期望值，±0.001 容差）；⑤+0.15 恰等→positive（边界含）；⑥-0.15 恰等→strained；⑦clamp（全 ±1 样本不越界）；⑧同输入两次调用逐字节同输出（确定性）。
- nowMs 必须注入参数（禁 Date.now() 内联——确定性可测）。

### S3 soul-assembler 接线
- 先读 buildSoulPrefix 当前完整签名与 :671-680 调用形态，**mood 以 opts 字段传入（opts.moodTier）不新增位置参数**（第 3 参已有占位，防歧义）。
- computeSoulVersion（:83-89）：增可选第三参 `moodTier?: string`——payload 增 `m: moodTier ?? null`；**缺省 undefined 时 payload 与现状逐位一致**（快照守卫测试断言）。
- 感受段（:231-233 feel.push 区域）：mood 行作为 soul-feeling 块内最后一行（feel.push 之一）：`近期基调：${tierLabel}（近 ${sampleCount} 条经历的情感聚合）`——tierLabel 映射 偏积极/平稳/偏承压；opts.moodTier 缺省/negative-sample 省略=不 push。
- 守卫测试：buildSoulPrefix 不传 moodTier → 输出与既有快照逐字节一致；传 strained → 行在场且 `</soul-feeling>` 前最后一行。

### S4 auto-recall.ts 调用点（:671-680）
- moodLine.enabled（config）为 false → 完全跳过（零行为差异）。
- enabled 且 store.recentAffectSignals 在场 → 取样本→computeMoodTier→结果同时传 buildSoulPrefix opts.moodTier 与 outcome（`outcome.mood = tier 串`，与 soulVersion 同路径透传）。
- config 解析：新配置走 env-config.ts 统一入口（resolveMaxBodyBytes 模式；禁裸 process.env+网络动词字面量——OpenClaw 扫描器规避模式）。yaml 段：`memory.coreMemory.moodLine.{enabled,windowHours:72,maxSamples:20,minSamples:5,posThreshold:0.15,negThreshold:-0.15,halfLifeHours:48}`（缺省 enabled=false）。

### S5 v2-router 出参（:1653-1669）
- meta 类型增 `mood?: string`；返回块增 `mood: outcome.mood`（undefined 时 JSON 序列化自然省略——核对 successEnvelope 对 undefined 字段行为，若保留键则用条件展开）。

### S6 BFF 路由（:1630 values/list 之后）
- POST `/chat-memory/mood` body:{block_id}：取实例配置的 gateway endpoint+api_key（同 values/list 取用方式），调 core `POST /v3/recall`？**否**——mood 不应要求完整召回。core 侧若无独立 mood 端点，M1 先行方案：**BFF 不新增端点，S-UI 的近期基调行从 /v3/recall meta.mood 消费的路径不存在（UI 不调 recall）→ 降级方案=BFF 直连 core 新端点 `POST /v3/memory/mood`**（v2-router 新 handler：三元组头取租户→store.recentAffectSignals→computeMoodTier→返回 {tier,sampleCount}；enabled=false 时返回 {tier:null}）。二选一在 S4 完成后按实现便利裁决，裁决记录进 CHANGELOG。
- ACL：与 values/list 同款（owner 借用语义 :1693 注释先例）。

### S7 UI（SoulFeelingBar.tsx v2 分区卡）
- cols 网格之后追加全宽副行：`<div className="_soul-mood">` 三态徽标（积极=绿/平稳=灰/承压=橙，复用 _soul-pill 配色变量）+ 文案 + tooltip（阈值/窗口/样本数——信息完整性：判定依据可见）；tier=null 不渲染（宁缺毋滥）。
- BFF 调用挂 load() 同一 useEffect；i18n 四键：soul.mood.title 近期基调/积极/平稳/承压（zh+en）。
- CSS：`._soul-mood { display:flex; align-items:center; gap:8px; padding:6px 10px; background:var(--soul-fill-muted); border-radius:6px; font-size:var(--soul-fz-meta); }` 追加于 V7 方案A v2 块之后（纯追加+标记守卫）。

### S8 配置启用纪律
- tdai-gateway.yaml（600 权限、gitignored、改动不入 git）M1 验收期仅对**测试租户**场景验证（本地/隔离租户探针）；生产租户（team-kcjjqzkxks）enabled=true 属行为变更启用=**A/B 全部通过后逐项呈报拍板**（gated 纪律）。
- 重启后必须以新代码行为特征验证补丁真已加载（meta.mood 字段出现=mood 代码在场；旧无字段=未生效——tdai 身份内嵌 sudo 假重启教训）。

### S9 A/B 协议（≥10 组，构造语料）
- 隔离租户（x-tdai-* 三元组头+Bearer sk-mem，三头缺一 401——sha256 空串哈希陷阱见部署技能）播种 L1：`/v3/conversation/add` 中英混合+显式情感语料（python urllib 直发，heredoc 中文会吞）→等待提取（150-200s）→node:sqlite readOnly 核 l1 valence 落值。
- 分组：偏正 3（valence 0.5~0.9 多条）/偏负 3（-0.5~-0.9）/中性 3（|v|<0.15 附近）/边界 1（恰 ±0.15）/降级 1（<5 条样本→基调省略）。
- 对照：enabled=false 注入块与基线逐字节 diff=0；enabled=true mood 行在场且档位符合公式手算；KB：档位翻转频率（对同窗追加样本观察）；负增益（含 KV 抖动）诚实登记回退。

### S10 门禁与收口
- core vitest ≥768（758+新增）/tsc 222 持平/panel vitest ≥146/web tsc 2/build ✓+bundle 断言（mood 徽标类名）/tdai-core+tdai-panel 双重启（ubuntu 外层身份）+新代码特征验证/密钥扫描 `\bsk-[A-Za-z0-9]` 词边界（task-ledger 假阳性教训）/CHANGELOG/台账四态。
- 长会话输出劣化即诚实重建（宁可 BLOCKED 不出假活）。

## §3 M2 spike 计划（S-CHAR-2 燃料实测，与 M1 可并行）

- T2 证据分裂可测：SQL——core_values（state=active）逐锚经 coreRefs/identityRefs 反查 L1 的 valence 分布（node:sqlite readOnly；vec0/fts 影子表过滤先例），统计正负证据各 ≥2 的锚数。
- T1 演化反向**不可直接测**（无结构化史表，O14 裁决维持）——spike 范围=T2+对 5 条人工候选抽验；T1 检测器实现推迟到 M2 正式立项（upsertCore 时点 diff，见 spec §2.2）。
- 报告模板：锚名/正证据数/负证据数/是否达 minInstances/结论（燃料够→立项呈报；不够→登记不启用）。

## §4 M3 outline（依赖明示，不提前）

narrative 蒸馏门 narr-gate.ts + 双视角 prompt 第三字段 + 槽尾行——依赖 M1（mood 行证明蒸馏类行可安全入 soulVersion 体系）与 M2（品格锚提供叙事素材）；实施计划在 M1/M2 收口后另写。

## §5 环境铁律与本会话新增教训（违反即停工）

1. ssh 多行含引号/`$(...)` 一律本地脚本→scp→bash（本会话三次内联翻车实锚）。
2. 本地文件 UTF-8 **无 BOM**（BOM 挂 bash、ASCII 毁中文）；Python bytes 字面量内 `\uXXXX` 不解码（原样落盘事故实锚），含中文一律 str.encode("utf-8")。
3. install 落位必须 `sudo install -o tdai -g tdai`（漏 sudo=Permission denied ABORT，零损伤重跑先例）。
4. git commit 中文一律 `-F` 文件（UTF-8 无 BOM）；push 前 `git show --stat HEAD` 对账；密钥扫描 `\bsk-` 词边界（task-ledger 假阳性教训）。
5. MemoryCore vitest v4：禁 --reporter=basic；typecheck 必须 `-p tsconfig.typecheck.json`。
6. 断言范围精确：soul 全文含锚行全量描述，感受段断言须 match `<soul-feeling>…</soul-feeling>`（「out 含后续」假象教训）。
7. 破坏性/数据面操作只读或呈报；测试数据只增不删；gated 勿抢跑；登记≠真实——待办采信前先现场核验。
8. 部署重启=ubuntu 外层身份+新代码行为特征验证（meta.mood 字段在场=mood 代码已加载）。