<div align="center">

# TDB · TencentDB Agent Memory（hechen 定制版）

**基于腾讯开源 [TencentCloud/TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) v2.0.1 的深度定制 fork**

原仓库 · [English](./docs/upstream/README.en.md) · [简体中文（原文档）](./README_CN.md) · [安装指南](./INSTALL_CN.md)

</div>

---

## 这是什么

先说原仓库：**TencentDB Agent Memory** 是腾讯开源的 Agent 记忆系统——给 Agent 一个能记住人和事的大脑（L0-L3 四级记忆）、一个会积累经验的 Skill 库、一张同时看懂文档和代码的知识地图，以及一个由人掌握的团队记忆面板（Memory Hub）。四个模块协同工作：

| 模块 | 职责 |
|---|---|
| MemoryCore | 记忆核心：L0-L3 记忆、召回、元数据、Skill 抽取（网关 :8420） |
| MemoryProxy | 注入管线：多客户端接入、上下文注入、记忆/知识/Skill 注入（:8096） |
| MemoryKnowledge | 知识服务：wiki / code-graph 摄取与检索（:8421） |
| MemoryPanel | TMC 管控台：用户/团队/Agent/知识源管理（:8123） |

本仓库在其基础上做了**私有部署落地 + 记忆质量深度定制**，以"实证裁决"为纪律：每一项召回/排序类改动都带同语料 A/B 评测（golden corpus）和裁决记录，降精度即关断，绝不无据合入。部署形态为腾讯云 systemd 四服务原生直跑，部署手册见 [`deploy/tencent-cloud/DEPLOY.md`](./deploy/tencent-cloud/DEPLOY.md)。

## 与上游 v2.0.1 的差异总览

> 基线：上游 tag `v2.0.1`（2026-08-25）。截至 2026-09-14 的文件级 diff：**新增 131 文件、修改 937 文件、删除 0 文件**（不含 node_modules / 运行时配置）。所有变更登记在 [CHANGELOG.md](./CHANGELOG.md) 的 `[Unreleased]` 段，每项带设计文档编号（DS-xxx / P 系列任务号）。

### 一、记忆召回与排序（MemoryCore）

| 改动 | 说明 |
|---|---|
| ✚ `/v3/recall` 核心单点合并召回 | DS-RECALL-MERGE-001。九通道检索 + R7 分层 + 预算切分 + 幂等结论层收敛为一条组装路径 `performLayeredRecall`，端点返回块与 auto-recall 钩子逐位一致；`memory.recall.v3Recall` 配置开关 |
| ✚ R7 分层召回 · 结论层 | `conclusionLayer`：经验层之上产出结论层，CAL C1 截断 + 幂等结论缓存 |
| ✚ 结构感知九通道召回 + RV2-2 精排 | 完整实现（R1-R9 通道、compositeScore 精排），并按 golden A/B 实证**裁决关断**（结构信号 on 0.325 / off 0.345，降精度即退役），能力保留、配置一键可重开；现行验收线 P@5 ≥ 0.325 |
| ✚ E1-E3 性能缓存 | query 向量 60s 复用、价值锚缓存、同 session 同 query 注入块 5 分钟复用 |
| ✚ 真记忆 G–M 全家 | 记忆图 `links`（similar/evolve 建边）、`coreMemory` 写入口信任边界 + 价值锚种子、`lifecycle` 巩固/遗忘周期调度、`search.neighborExpand` 重构式回忆（图邻居扩展） |

### 二、记忆可信性（M1-M4 修复系列）

| 改动 | 说明 |
|---|---|
| ✚ M3 网关鉴权必填 | **行为变更（无兼容期）**：MemoryCore 不再"无 key 放行"，未配置时启动生成临时密钥并 loud 打印；跨进程调用方三处同源，否则一律 401。含数据库迁移回滚预案 |
| ✚ T12 core 租户化 / T14 租户隔离 | 元数据与记忆检索按 (team, user, agent, task) 严格收窄，闭合租户隔离红线 |
| ✚ M4 语义补全 | T15/T16/T17/T17.5：subject 归组策略门（llm/lexical）、行映射根治等 |
| ✚ M1 数据止血 + S1/S2 小件清零 | P0 级修复与类型层清理 |
| ✚ C1-C4 第三档 | 价值信号全链流动，router 退役 |

### 三、注入管线与知识召回（MemoryProxy / MemoryKnowledge）

| 改动 | 说明 |
|---|---|
| ✚ `TdaiL1RecallInjector` 瘦传输 | 改调 `/v3/recall` 直接前插现成块；404/5xx/超时自动降级旧路（`/v3/atomic/search` 自行组装）+ loud 日志，防静默降级 |
| ✚ 场景块治理 `sceneGovernance` | 提取批次后块体超限触发 LLM 蒸馏重写（6000 码点/片 + seg-cache），失败硬截断兜底（DS-SCENE-GOV-001） |
| ✚ wiki 自动召回 `wikiRecall` | WikiRecallInjector：相对归一门控 + 绝对相关门控（absScore）+ typeWeights 结构页降权 + 跨库软定域；domainRouter 经 C3 实验默认退役 |
| ✚ wikiRecall 调参实证 | minInjectNormScore 0.6、minInjectAbsScore 1.5 等经 golden 实测校准 |

### 四、运维、部署与仓库治理

| 改动 | 说明 |
|---|---|
| ✚ 腾讯云部署资产 | `deploy/tencent-cloud/`：init-server.sh、systemd 四服务、Caddyfile 模板、cloud yaml 模板（`${}` 占位符派生生产配置）、CLOUD-DIFF、DEPLOY.md 实战手册 |
| ✚ `creditReport.enabled` 总开关 | Credit 计费上报整链短路开关（缺省 true = 逐位现状；upstream 非 TokenHub 时 CreditDelta 恒 0，建议关闭） |
| ✚ MemoryCore `pi-plugin` | 新增插件宿主 |
| ✚ 评估 harness 与验证脚本 | MemoryCore/scripts 下 50+ 个 verify/audit/eval 脚本：golden 评估、漂移重锚协议、逐任务验证（t1-t21） |
| ✚ docs/ | superpowers（specs / plans / reviews / evals）设计-审查-评估全链文档 + tdai-v2-technical-ops.md |

### 仓库治理（不入库清单）

含真实密钥的运行时配置（`tdai-gateway*.yaml`、`MemoryPanel/config/metadata-instances.json`）、硬编码密钥的本地运维脚本、评估产物 `runs/`（语料含私有记忆内容）均已在 `.gitignore` 排除；生产配置从 `deploy/tencent-cloud/config/` 占位符模板派生。

## 同步上游

上游演进到新版本时：clone 对应 tag → 按本表与 CHANGELOG `[Unreleased]` 逐项重放 → 重跑 golden 评估（召回/排序语义变更必须重锚）→ 更新 CHANGELOG。回滚 = `git checkout` 上一 tag + restart，数据卷不受影响。

## License

跟随原仓库 [MIT License](./LICENSE)。所有上游版权与商标归腾讯/TencentCloud 所有；本 fork 的定制部分同样以 MIT 提供。
