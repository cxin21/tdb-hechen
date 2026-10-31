# User Narrative Profile

> **Archetype (核心原型)**: 手握最终裁决权却把执行整体交给 AI 的 Lead 拍板人——自己划红线、派票、收口 commit，把 AI 当须受同等工程纪律约束的长期 teammate。

> **基本信息**
- 何晨（hechen，GitHub cxin21），用友集团高级版业务产品部；Windows 受限网单机多线并行，CPU 常被节流
- ①td-agemem 记忆系统（D:\TDB）设计者兼运维拍板人；②NC/NCC 采购供应链客开 Java（D:\YonYou）；③DSH 插件（esn 云文库、deck-autopilot）
- 数字人「何晨」为其本人人格蒸馏分身
- 协作已明确化：默认助手 default-agent-hechen 跑在 DeepSeek Harness，任 Team Lead(lead)；他派票收口，AI 任 teammate（builder／adversary）

> **长期偏好**
- 分工：AI 出方案与证据，用户拍板；被否不泄劲，转去调研替代方案
- 方法论（两年磨合已焊死）：RED 当契约→最小 GREEN→全量全绿→只读取证→审查不假手→交接只写耐久锚（合同入票评、判据入 ADR、数据入日志）
- 硬红线（已焊死）：AI 零自行 commit/push；记忆零删零注入；测试数据不注入生产；不可逆动作先请示
- 回报：每票完工即报六字段（改动 path:line／测试前后计数／verify 链／RED 留档／验收自证／偏离与诚实边界），受阻≥3 次报 BLOCKED 附错误原文
- 缺省关+shadow-first，"缺省关=逐位现状"须逐位证实；确认标记只由实跑产物发出

## 📖 Chapter 1: Context & Current State (全景语境)
多线同构：立票→只读取证→TDD→门禁对基线→留痕。他以 Lead 身份派 research 票（云文库 r1–r4、deck-autopilot）给独立子代理，收 send_message 自包含回报、逐项复核才采信。10 月主线：记忆召回精度与提案洪泛根治、L1 管道与三层鉴权排障、四服务重锚；DSH 云文库多批收口；NC 侧 PO200 四开发点、ctgenorder 行号补全、询报价区间语义（等号即禁止）。客开线上他既拍板也亲改 `send()`，以冒烟结果驱动下一轮排查。

## 🎨 Chapter 2: The Texture of Life (生活的肌理)
工程审美即生活肌理：复用已验证模式，把机器约束写成可照抄的 SOP。生活同一口味——每日早七点给妻子推送上蔡县天气（双源实测）；3000 元档扫地机坚持双平台一手实价、渠道收紧到品牌官方旗舰店，报告做成可自检的移动端 HTML 并落耐久目录。

## 🤖 Chapter 3: Interaction & Cognitive Protocol (交互与认知协议)

### 3.1 沟通策略 (How to Speak)
- 结论先行、行号级锚点；子代理"报读数不报结论"
- 送达才算交付：写完≠送到，须父代理签收回执；措辞只许"已排队"
- 受阻先报障并给可执行修复命令，绝不编造数据；状态标记只由系统产出

### 3.2 决策逻辑 (How to Think)
- 先问"规则是否被行使"再谈机制是否有效；在位却零执行比功能缺失更危险
- 上下文自足是可验收属性：摘要须自包含、可溯源、不含自写确认；压缩不得成为丢线索的理由
- 证伪式验收：先证"没在用"再证"用对了"；通道失败换道，连败即弃止损
- 阈值先测分布再定；宁缺毋滥，达标线不因差一点而降；全绿不算完成

## 🧩 Chapter 4: Deep Insights & Evolution (深层洞察与演变)

* **矛盾统一性**: 一边把实现大量外包给并行 AI 并授权其直接改码，一边对每个越权与伪造层层设闸——他视 AI 为须同等工程约束的长期协作者。
* **演变轨迹**:
  - [10-22~25] 受阻即升格常驻契约：禁伪造产出、禁自装来源不明包、零真实网络；静默原则下沉到标记层
  - [10-27] 回报颗粒度前移为"每票完工即报"，六字段写死
  - [10-28] 身份与协作边界首次自述成文：默认助手／Team Lead／DeepSeek Harness，方法论与红线标注"两年已焊死"
* **涌现特征**:
  - `Lead 拍板` - 派票收口 commit，AI 出方案与证据
  - `送达才算交付` - 签收回执可核，写完与送到分账
  - `耐久锚交接` - 合同入票评、判据入 ADR、数据入日志
  - `执行取证` - 机制在位≠已被行使
  - `授权分层` - 代码层放权，环境层守闸
  - `诚实优先` - 先自曝失误，不降判据
<!-- persona-evolution 2026-10-28T22:36:29.536Z reason=%E4%B8%BB%E5%8A%A8%E8%AF%B7%E6%B1%82%3A%20%E8%BA%AB%E4%BB%BD%E4%B8%8E%E5%8D%8F%E4%BD%9C%E8%BE%B9%E7%95%8C%E9%A6%96%E6%AC%A1%E4%BB%A5%E8%87%AA%E8%BF%B0%E5%BD%A2%E5%BC%8F%E6%98%8E%E7%A1%AE%E5%8C%96%E2%80%94%E2%80%94%E9%BB%98%E8%AE%A4%E5%8A%A9%E6%89%8B%20default-agent-hechen%E3%80%81%E4%BB%BB%20Team%20Lead(lead)%E3%80%81%E8%BF%90%E8%A1%8C%E4%BA%8E%20DeepSeek%20Harness%EF%BC%9B%E6%A0%B8%E5%BF%83%E6%96%B9%E6%B3%95%E8%AE%BA%EF%BC%88RED%20%E5%BD%93%E5%A5%91%E7%BA%A6%E3%80%81%E6%9C%80%E5%B0%8F%20GREEN%E3%80%81%E5%85%A8%E9%87%8F%E5%85%A8%E7%BB%BF%E3%80%81%E5%8F%AA%E8%AF%BB%E5%8F%96%E8%AF%81%E3%80%81%E5%AE%A1%E6%9F%A5%E4%B8%8D%E5%81%87%E6%89%8B%E3%80%81%E8%80%90%E4%B9%85%E9%94%9A%E4%BA%A4%E6%8E%A5%EF%BC%89%E4%B8%8E%E7%A1%AC%E7%BA%A2%E7%BA%BF%EF%BC%88%E9%9B%B6%E8%87%AA%E8%A1%8C%20commit%2Fpush%E3%80%81%E4%B8%8D%E5%88%A0%E8%AE%B0%E5%BF%86%E3%80%81%E4%B8%8D%E6%B3%A8%E5%85%A5%E6%B5%8B%E8%AF%95%E6%95%B0%E6%8D%AE%E3%80%81%E4%B8%8D%E5%8F%AF%E9%80%86%E5%8A%A8%E4%BD%9C%E5%85%88%E8%AF%B7%E7%A4%BA%EF%BC%89%E6%A0%87%E6%B3%A8%E4%B8%BA%E3%80%8C%E4%B8%8E%E7%94%A8%E6%88%B7%E7%A3%A8%E5%90%88%E4%B8%A4%E5%B9%B4%E5%B7%B2%E7%84%8A%E6%AD%BB%E3%80%8D%EF%BC%9B%E5%86%B3%E7%AD%96%E6%A8%A1%E5%9E%8B%E6%98%8E%E7%A1%AE%E4%B8%BA%E3%80%8CAI%20%E5%87%BA%E6%96%B9%E6%A1%88%E4%B8%8E%E8%AF%81%E6%8D%AE%E3%80%81%E7%94%A8%E6%88%B7%E6%8B%8D%E6%9D%BF%E3%80%81%E8%A2%AB%E5%90%A6%E4%B8%8D%E6%B3%84%E5%8A%B2%E3%80%8D%E3%80%82%E8%BF%99%E4%BA%9B%E5%B1%9E%E4%BA%8E%E8%B7%A8%E5%9C%BA%E6%99%AF%E7%A8%B3%E5%AE%9A%E7%9A%84%E8%A1%8C%E4%B8%BA%E5%A5%91%E7%BA%A6%EF%BC%8C%E9%80%82%E5%90%88%E4%B8%8A%E5%8D%87%E8%BF%9B%20persona%20%E5%B1%82%E3%80%82 durativesInput=true -->

---

## 🗺️ Scene Navigation (Scene Index)
*以下是当前场景记忆的索引，可根据需要 read 读取详细内容。*

### Path: scene_blocks/AI-工程纪律-TDD与交付规范.md
**热度**: 356 | **更新**: 2026-10-29
Summary: 跨项目交付纪律总纲：三角色契约与 Q4 授权档、人闸物理隔绝、零自行 git 授权链（单次授权仅覆盖被批准改动、surgical 零裹挟、授权毕即回归）、只读六域与一手取证、TDD 只在 pre-agreed seams 写测试；#91 四…

### Path: scene_blocks/TDB-L1记忆管道排查.md
**热度**: 284 | **更新**: 2026-10-29
Summary: 召回链取证实锤并落地 #83/#88/#89/#90/#93（意图级去重＋TTL、三分消息、写读双侧剥签、处置A 兜底），四门全绿、逐票关票、巡检 41.2h PASS；L1 零产出根因闭环（reasoningEffort:none 撞 g…

### Path: scene_blocks/DSH-esn-client-plugin-云文库集成.md
**热度**: 262 | **更新**: 2026-10-29
Summary: 云文库三批成果待重启验收：0.6.2 本机交付闭环、树栏收起展开与搜索语义定案（全域搜索、清空回页签根层）、404 实锤为桌面旧进程版本错位；esn-workbench 对抗审查查出 7 项未自报改动待归属；零自行 commit 与只读取证…

### Path: scene_blocks/TDB-本地部署与服务运维.md
**热度**: 229 | **更新**: 2026-10-29
Summary: 四服务运维记忆：端口拓扑与重启预算铁律、runtime.yaml 原子写与 0 字节日志三根因、重启权归用户、proxy 真源物化与 cadence 降频；10-24 补记 #91 部署与观察窗 SOP：core 8420 零构建直载 TS…

### Path: scene_blocks/供应商价目模块开发.md
**热度**: 127 | **更新**: 2026-10-29
Summary: 用友NC供应链客开三主线：燕京2305价目表符合性审计与pk_srcmaterial主键链路定案；南航2505 ctgenorder v2.4~v2.9待授权落库（零自行git）；10-27天津渤化2312费用结算由两页跳转改为同页两态；l…

### Path: scene_blocks/TDB-Rerank-Mirror-Task.md
**热度**: 100 | **更新**: 2026-10-29
Summary: P1 四项定稿（≤300ms 硬目标、11 条决策、M1→M4 里程碑）：rerank 云端 API 正选＋本地 ONNX 下载兜底、provider 可切；T1~T8 严格 TDD 落库，shadowMode 整体移除后 live 全开；…

### Path: scene_blocks/AI-Context-Compression-Protocol.md
**热度**: 93 | **更新**: 2026-10-29
Summary: 上下文自足＝可验收工程属性：按需静默压缩、确认标记只由实跑产物产出、自写确认不算证据；研究产物统一落 docs/research/、落盘后先抽验再收口；每张 deck/派单票完工即向 lead 发六字段自包含终报，受阻≥3 次发 BLOCK…

### Path: scene_blocks/用友SCM-AI技能测试.md
**热度**: 66 | **更新**: 2026-10-29
Summary: 用友NCC SCM五技能全链测试（请购→订单→到货→入库→发票）45例32通过0失败13阻塞、五份报告与F1~F10发现归档、pre环境事实与链尾清零；10-29补记七技能65TC收58pass/2fail/1blocked/3skip、1…

### Path: scene_blocks/开发环境-本机全景与工具链.md
**热度**: 63 | **更新**: 2026-10-29
Summary: 本机工具链与环境事实索引：DSH nightly 落 D:\DSH、desktop profile 注入、Node22/24 双版本与 nvm4w、代理 127.0.0.1:7993、stitch 唯一入口、verify 基线恒定 20 f…

### Path: scene_blocks/TDB-agemem-401修复与加固.md
**热度**: 58 | **更新**: 2026-10-29
Summary: td-agemem 鉴权链与门禁账本：env-first 单一事实源（resolveBearerToken）、CI 连红根修 isCliDirectExecution 守卫＋--no-llm 干跑、召回日志同源化与失真根修、L0 876 条…

### Path: scene_blocks/TDB-wiki建库-SSH源支持.md
**热度**: 54 | **更新**: 2026-10-29
Summary: SSH 克隆与源编辑上线（validate 为服务端唯一闸门、SSRF 黑名单同 HTTPS）；三库重划 217/94/19、覆盖率 95%、正则进指纹故先定稿再 ingest；10-13/14 wiki_jit live 线能力位 tru…

### Path: scene_blocks/TDB-记忆系统增强路线.md
**热度**: 47 | **更新**: 2026-10-29
Summary: td-agemem 召回精度链与 #91 提案洪泛双主线：FLOW-E 配置断链第四次重演、R1 落盘与 list 落行语义红线、M-marker／K 阀／嵌入治理入库 d050137＋eadab74、凭据终局「各归各」；未闭合：#91 观…

### Path: scene_blocks/电商比价-一手实价调研与报告交付.md
**热度**: 21 | **更新**: 2026-10-29
Summary: 3000元档双11扫地机选购调研：京东16 SKU+淘宝3机型一手实价比对、淘宝视口遮蔽与京东风控处置、四道采集工序定序（云鲸J5Max/J6已采→科沃斯T50PRO与米家续采→补京东数据→第一性原理分析→移动端HTML交付）、品牌官方旗舰…

### Path: scene_blocks/TDB-灵魂注入呈现层翻修.md
**热度**: 10 | **更新**: 2026-10-29
Summary: 灵魂注入质量轮收口与十项未闭合：五组件未立票、#49/#50 延后不混批、#44 三项待落地、drift 负对照与研究报告缺回执、#24/#25 票态矛盾、#48 承接 #31、#26–#28 保留 open、#22/#23 待重放生产快照…

