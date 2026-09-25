# 工作流 B：灵魂组成重分析报告（v10 会话，2026-09-25）

- 基线：HEAD 373251a；四链判定证据全复用《工作流 A 深查判定总表》（2026-09-25-v10-workflow-a-deepcheck.md，commit 373251a），本文不重复四链表，只做「当前 vs 正确 vs 公式」组成级分析。
- 公式基准（母 spec §1.1）：下一刻的你 = f( 此刻的你←soul 两段常驻, 过去的记忆←relevant-memories 查询驱动, 当下的感受←锚 valence 派生+近期经历聚合 )。

## 一、灵魂四段组成五维矩阵（内容/提取/拼接/主语/人物说明）

| 段 | 内容（当前活体实证） | 提取工序 | 拼接实现 | 主语三层法 | 与公式差异 |
|---|---|---|---|---|---|
| soul-identity | 「我是谁」self_identity（主桶 version=57）、「我心中的他」identity（version=44）+core_value/strict_rule 槽行、价值锚行（theme 17）、重要的人行、我的品格行（M2 渲染门） | identity-discovery 双视角（enabled=true）+anchor-growth 三池+character-tension（M2） | soul-assembler 四小节+escapeXmlTags+F17 预算 600/900+truncateByLines 行边界截断 | 所=agent；内=双槽分明（self 第一人称/identity=用户）；功=agent | ✅ 与 §2.7 一致（含 M1/M2/v6 已批准增补） |
| soul-feeling | 驱动/审慎两清单+首要段（两端同键 F-U2）+近期基调行（M1 三档，meta.mood=positive 活体） | 无独立提取——派生渲染（锚 valence 聚合+mood-line computeMoodValence 单一源） | theme-only 收窄（R-B 红线：品格不入感受段，活体实证品格行独立在「我是谁」尾） | 派生非存储=防「存的状态」与「信的东西」双真相（设计关键选择） | ✅ |
| relevant-memories | 查询驱动行+五徽章链+`·触[价值]`/`·[通道]` 尾注 | L1 提取流水线（l0→l1 双时钟） | formatMemoryLine 单一源+三构造点透传 | 记忆行=agent 的记忆（内容多为用户），R-A/R14-bis 双红线封死自我强化 | ✅ |
| meta 对账段 | soulVersion/layered/双计数/sessionReused/mood | — | buildSoulPrefix 内部缓存闭环 | 系统对账 | ✅ |

## 二、换用户/换 agent 双测试（设计 §8.3 验收判据）真实数据实证

- **换 agent**（主 team 双桶）：agt-kfynybx0ly self_identity=「端到端真实链路验证/证据真实性纪律/取证先行闭环」vs agt-l5ugn6urg4=「SDD 子代理实施+验收+终审/提示词插件开发」——实质不同=通过；品格随关系分化（拍板）成立。
- **换用户**（同 agent ev17 跨 5 租户）：identity 槽各自持有对方没有的事实（ev17a 血压+慢跑医嘱 / ev17b「不喜欢叫老何」/ ev17c 美式+龙井+周三例会 / ev17e 老何禁忌+体检）；self_identity 同 agent 保留共性纪律（注入格式变更对照数据）且措辞各自演化——分化+共性双判据=通过。

## 三、缺口与差异登记（B 视角）

1. **⚠️（gated 重申呈报）人物说明数据面休眠**：设计有（§2.7 V6-1e④ person 行同构「label(role·方向)：description」）+渲染链在场（soul-assembler.ts:210 personDir+attrsOf 统一解析）+**生产 person 锚 8 active 全部 attrs_json={role,aliases} 零 description** → 每轮注入「何晨(同事·趋近)」无语义短句=「设计有、用户看不到」。回填=数据面写入，守 gated 边界等拍板；品格锚 description 同族（character 7 中仅 1，主桶 2 active 均无）。
2. **⚠️ QUOTA 超限的注入面后果**（A 总表 §六根因）：锚行 17 theme>名额 15——quotaEvict 注释自证「maxTotal 的第一性目的=soul-feeling 注入预算保护」，守卫被 interval 门饿死=F17 名额防线失效态，修复紧迫性+1（设计小节待拍板）。
3. 📝 Panel 展开边界与美观微项（G1/G3/G4/窄屏换行/提案卡风格）→ UI 线设计先行呈报；UI-3.2 维持 NEEDS_CONTEXT。

## 四、Panel UI 全量展示审计结论（硬令 2/3 口径）

身份双槽卡（IdentitySection）✅ · 锚三池 vtab+类型徽标+attrs 行内编辑（含 description 回写防丢）✅ · 记忆属性表 11 类行 ✅ · 三色 refs chips（🎯/👥/🧠）✅ · SoulFeelingBar 分区卡（M1 基调+阈值 tooltip）✅ · 召回日志段 ✅——存储属性三层体现面除 person/character description（数据休眠）外无「用户看不到」项。

## 五、结论

**当前 vs 正确 vs 公式：结构一致、无组成级缺口**；两处 ⚠️ 均为数据/运行面（personDesc 回填 gated+QUOTA 守卫解耦）而非组成缺陷；双测试真实数据通过。B 四链生产级判定全量复用 A 总表（13✅+1⚠️+2📝）。移交：UI 线微项设计先行呈报、任务 2 设计小节、C 材料继续复用本面。
