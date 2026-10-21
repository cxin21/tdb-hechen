# 崩溃处置与收尾讨论包（底稿，2026-10-21 整理）

> 按用户指示（m02089「问题先记录最后再整理和我讨论」）预先整理的统一讨论底稿。讨论时点由用户定，本文先备好。

## 一、崩溃死因（已闭环，见台账）
- **定性**：外部强制终止（taskkill /F 形态）——执行中戛然而止，无 WER/无 System 2004/Job Object 已移除/watchdog 无 kill 路径/tee.log 最后行正常 DEBUG，全排除有实证；凶手不可定位
- **直接前因**：LLM 端点超时风暴（20:37 起，间歇持续到 21:38+）→ dedup LLM 硬编码 300s 超时逐个吃满 → 并行任务堆积（watchdog elapsed 峰值 414s）→ 高 CPU/内存
- **两实例重演**：164（20:55 崩）与 32516（21:31-21:38 同模式）互证

## 二、#79 药方草案（scout 笔记已备料）
- **A1**：dedup/extraction LLM timeoutMs 可配置化（config-first 缺省 300_000=逐位现状；l1-dedup.ts:280/:297 实锤硬编码；embed 路 :341 已有可配先例可镜像）
- **A2**：风暴中快降级（batchDedup 超时→storeAllDirectly 已存在 :521，等待随 A1 缩短，不丢数据只绕判重）
- **B**：并发背压（pipeline 任务上限排队）
- 验收链：RED→GREEN→三门（vitest-core 对账/typecheck 243/proxy 绿）→对抗审查→surgical commit+push
- **R-A 核查点**：只动超时与并发，零情绪数据进召回

## 三、待你拍板的决策点
0. **351 码点存量行处置**（m_1792017241926_2d8206，8-21 无门时代 capture 产卡、今日被 update 触碰仍超长）：与 D2 存量处置同域——A 维持不动（数据完整优先）/B 总验收后统一归档处置/C 若 #79 立项连带做 update 路径长度审计
1. **崩溃处置**：A 立 #79 TDD 根修（建议）/B 背压并入同票/C 保守观察（预算剩 1）/D 先推进口径 A 采样
2. **重锚时机**：全量重锚恢复预算（restartsUsed=2/3，单服务 taskkill 被 SOP 禁止）——建议与 #79 落地部署一次重启两得；会杀 proxy 8096 中断本会话，须明确授权
3. **D2/D3/conclusionContract**：三键已生效（第一批卡 180/146/194 实证）；存量 work_fact 空 occurred_at（84.3%）回填写库与否=时间锚 fallback 已覆盖，建议不回填（零写库可逆）
4. **F4=#78**：small-to-big 原子召回+父块回链——待观察窗数据+你的拍板（scout 笔记 l1_links 4748 边、双缺口已证）

## 四、观察窗判据进度（截至 21:56）
- ①rejected 零行（300 门从未拒卡，few-shot 拆条引导生效）✓ 持续
- ②新卡 ≤300 码点：**新增行 9/9 逐张实证**（180/146/194/259/169/225/130/168/167/165 中 9 张新建行，readOnly 探针 card-recheck.mjs；另 3 张走 dedup update 路径保留旧行，其中 1 张 8-21 无门时代存量卡 351 码点被触碰→见决策点 0）✓
- ③golden 三键复跑（runs/2026-10-20T13-41-53.json）：**hitRate 0.667/0.75 逐位持平基线+no red cards**——14d 半衰对 0-7d 库龄（衰减 0.71-0.95）+timeProx 回退未改命中面，初判过 ✓
- ④空召回/噪音对照：golden 口径 emptyRecall **0** vs 06-11 归档 0.111（复放口径内改善）；precisionProxy 0.182 下行系行数增长摊薄+数据演进（同 Batch C 先例口径）；T4 活体 59.5%/77.7% 对照待总验收口径 A 采样
- 风暴近况：间歇持续（32516 存活 cpu 1429s@21:56，LLM 超时仍烧但 12 卡合规产出未受阻；21:46 拍 triggered=0 属 rRef 未达正常等待）

## 五、总验收方案（已落盘待执行）
- 口径 A：活体标注有效信息率 ≥40%（T4 复刻，journal 采样过滤 sessionReused，n≥30，用户抽样复核 ≥10 条；基线 26.5%）
- 口径 B：golden no red cards + hitRate 不低于 0.667/0.75
- 时点：观察窗 1 天 + 活体标注 2-3 天

## 六、用户侧待办（零擅动项）
1. ~~userkey=hechen 口径确认~~ **已撤销（2026-10-20 23:40 用户指正+复测定性）**：hechen 用户身份全程正常（memory-bridge 全 200 实证）；401 真因=鉴权面错配——/dsh/default/v3/recall 从 Authorization: Bearer 取 user_key（MemoryProxy/src/tdai/identity.ts:16，sk-mem- 形态），当时测试用 userkey 头/body（missing）或误用 core 网关 key TDAI_GATEWAY_API_KEY 当 Bearer（invalid），均非 hechen 口径问题，无需用户动作
2. ~~TDAI_GATEWAY_API_KEY 轮换~~ **用户拍板搁置（2026-10-20 23:36）：只在本机跑，风险面可控**
3. ~~全量重锚授权~~ 用户 22:30 已自行完成（restartsUsed 清零）

## 七、建议路线
A+B 立 #79 →（等你拍板）合同→TDD→三门→commit/push→授权重锚部署一次生效→观察窗收尾③④→总验收（口径 A+B）→#77/#76 关票→F4=#78 拍板。
