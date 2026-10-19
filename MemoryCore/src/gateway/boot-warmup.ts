/**
 * #68（core 启动暖机化 / boot warmup）——把「全量重启后首召回 504 尖峰」的冷点
 * 移出关键路径的启动编排骨架。
 *
 * 冷点实测与方案裁决见 docs/research/2026-10-19-r5-boot-warmup-design.md：
 *   - S0 jieba/FTS 字典直载（listen 前唯一同步步，~50-100ms；此时 /health 尚不存在，
 *     不违反可用性约束）
 *   - S1 store 就绪有界等待（≤5s；超时仅 warn，非失败——可用性由 /health
 *     stores.vectorStore 表达，/v3/recall 按现状 503 直至就绪）
 *   - S2 query-expand 预热（动态 import 链 + ark origin 首连 + 首个 LLM 往返；
 *     LLM 未配 → no-op 非失败）
 *   - S3 rerank 真实档位预热（local=candidates 档真实长度样本；cloud=1×1 dummy）
 *
 * 非致命合同：任一步失败仅 warn + warmup.status=failed，服务照常起；/health 恒 200，
 * 仅增只读 warmup 段（只加字段不改旧字段）。不加 readiness 硬门控。
 *
 * 本模块保持零业务依赖（deps 全注入、状态机/计时/串行编排可单测）：
 * 单测注入假步骤（LLM 永不进单测），生产步骤实现见 gateway/server.ts getBootWarmup()。
 */
import type { HealthWarmupInfo } from "./types.js";
import type { Logger } from "../core/types.js";

export type WarmupStepKey = "jieba" | "storeReady" | "queryExpand" | "rerank";

/** S1 store 就绪有界等待上限（ms）——server 侧未覆写时的缺省。 */
export const DEFAULT_STORE_READY_TIMEOUT_MS = 5_000;

export interface BootWarmupDeps {
  logger: Logger;
  /** S0：同步 FTS 字典直载（listen 前）。抛错 → 记 failed，不阻断后续步骤。 */
  jiebaPreload: () => void;
  /** S1：有界等待 store 就绪。true=就绪；false=超时（非失败，仅 warn）。 */
  waitForStores: (timeoutMs: number) => Promise<boolean>;
  /** S2：query-expand 预热（尊重配置门；LLM 未配 → no-op）。 */
  queryExpandWarmup: () => Promise<void>;
  /** S3：rerank 真实档位预热（自记 [rerank] 日志行；尊重配置门 → no-op）。 */
  rerankWarmup: () => Promise<void>;
  /** S1 等待上限 ms（缺省 5000）。 */
  storeReadyTimeoutMs?: number;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 启动暖机状态机。
 *
 * 时序合同：runPreListen()（S0，同步）→ listen → runPostListen()（S1→S2→S3，
 * fire-and-forget 串行）。两者各自幂等（仅 boot 调用一次，重复调用为 no-op）。
 * 状态经 snapshot() 只读暴露给 /health（warming|done|failed + 各步耗时 + totalMs）。
 */
export class BootWarmup {
  private readonly _state: HealthWarmupInfo = { status: "warming", steps: {}, totalMs: 0 };
  private ranPre = false;
  private ranPost = false;
  /** 暖机 T0：S0 开始时刻（runPostListen 单独被调时取其自身开始时刻）。 */
  private bootT0: number | null = null;

  constructor(private readonly deps: BootWarmupDeps) {}

  /**
   * S0（listen 前同步执行，唯一同步步）：jieba/FTS 字典直载。
   * 同步返回（返回 void 而非 Promise）——调用方把它放在 listen 之前即得
   * 「S0 先于 listen、先于任何 /health」合同；失败仅 warn + status=failed，绝不抛出。
   */
  runPreListen(): void {
    if (this.ranPre) return;
    this.ranPre = true;
    this.bootT0 = Date.now();
    const t0 = Date.now();
    try {
      this.deps.jiebaPreload();
      this._state.steps.jiebaMs = Date.now() - t0;
      this.deps.logger.info(`[warmup] jieba done in ${this._state.steps.jiebaMs}ms`);
    } catch (err) {
      this._state.steps.jiebaMs = Date.now() - t0;
      this._state.status = "failed";
      this.deps.logger.warn(`[warmup] jieba step failed (non-fatal): ${errMsg(err)}`);
    }
  }

  /**
   * S1→S2→S3（listen 后 fire-and-forget 串行）：幂等，永不 reject。
   * 失败语义：某步抛错 → warn（含步骤名）+ status=failed，后续步骤仍执行
   * （步骤间互不依赖，预热价值独立）；S0 已失败时终态保持 failed（done 不覆盖 failed）。
   */
  runPostListen(): void {
    if (this.ranPost) return;
    this.ranPost = true;
    if (this.bootT0 === null) this.bootT0 = Date.now();
    void this.runChain().catch(() => undefined); // runChain 已自吞错误，此处双保险
  }

  /** /health warmup 段快照（防御性拷贝——消费方改不动内部状态）。 */
  snapshot(): HealthWarmupInfo {
    return { status: this._state.status, steps: { ...this._state.steps }, totalMs: this._state.totalMs };
  }

  private async runChain(): Promise<void> {
    let anyFailed = false;
    // S1：store 就绪有界等待（有界性由 dep 自身保证——生产实现是
    // TdaiCore.waitForStores(timeoutMs)；超时非失败，仅 warn）。
    const s1 = Date.now();
    try {
      const ready = await this.deps.waitForStores(
        this.deps.storeReadyTimeoutMs ?? DEFAULT_STORE_READY_TIMEOUT_MS,
      );
      this._state.steps.storeReadyMs = Date.now() - s1;
      if (ready) {
        this.deps.logger.info(`[warmup] store ready in ${this._state.steps.storeReadyMs}ms`);
      } else {
        this.deps.logger.warn(
          `[warmup] store not ready after ${this._state.steps.storeReadyMs}ms (bounded wait elapsed; /v3/recall 按现状 503 直至就绪)`,
        );
      }
    } catch (err) {
      this._state.steps.storeReadyMs = Date.now() - s1;
      anyFailed = true;
      this.deps.logger.warn(`[warmup] storeReady step failed (non-fatal): ${errMsg(err)}`);
    }

    // S2：query-expand 预热。
    const s2 = Date.now();
    try {
      await this.deps.queryExpandWarmup();
      this._state.steps.queryExpandMs = Date.now() - s2;
      this.deps.logger.info(`[warmup] query-expand done in ${this._state.steps.queryExpandMs}ms`);
    } catch (err) {
      this._state.steps.queryExpandMs = Date.now() - s2;
      anyFailed = true;
      this.deps.logger.warn(`[warmup] queryExpand step failed (non-fatal): ${errMsg(err)}`);
    }

    // S3：[rerank] startup warmup done 行由步骤实现自记（含 scores/docs 档位信息），
    // 这里只计时，不重复打行。
    const s3 = Date.now();
    try {
      await this.deps.rerankWarmup();
      this._state.steps.rerankMs = Date.now() - s3;
    } catch (err) {
      this._state.steps.rerankMs = Date.now() - s3;
      anyFailed = true;
      this.deps.logger.warn(`[warmup] rerank step failed (non-fatal): ${errMsg(err)}`);
    }

    // 非致命收口：任一步失败 → failed（S0 已 failed 时不被 done 覆盖）；
    // 全部成功 → done。total 行恒打（观测口径），runChain 永不 reject。
    if (anyFailed) {
      this._state.status = "failed";
    } else if (this._state.status !== "failed") {
      this._state.status = "done";
    }
    this._state.totalMs = Date.now() - (this.bootT0 ?? Date.now());
    this.deps.logger.info(
      `[warmup] boot warmup total=${this._state.totalMs}ms (status=${this._state.status})`,
    );
  }
}

/**
 * S3 cloud provider（siliconflow / dashscope）dummy 预热文档：1 query × 1 doc。
 * 云端精排无本地 worker 加载成本，预热目标是首连/鉴权/请求往返；真实档位批量
 * 推理只对 provider=local 有意义。
 */
export const RERANK_WARMUP_CLOUD_DOCS: readonly string[] = ["预热文档：云端精排 API 首连与鉴权。"];

/**
 * S3 本地档位预热文档（#68 档位升级）：真实召回 candidates 档
 * （memory.recall.rerank.candidates，config.ts 解析缺省 12、clamp [1,100]）。
 * 每条为 50-200 字真实长度中文样本（记忆域语料），把首批 12-doc 批量推理
 * （tokenize + ORT session 暖机）移出首召回关键路径。
 * 超出语料按模循环——批量规模才是预热目标，语料多样性无关紧要。
 */
const RERANK_WARMUP_CORPUS: readonly string[] = [
  "项目周会结论：本周完成网关鉴权模块的灰度发布，先在测试环境验证三天，再逐步放量到生产集群；部署期间保留上一版本镜像，出现异常可在十分钟内回滚，值班同学负责盯监控面板和告警群。",
  "用户偏好记录：汇报材料喜欢用一页纸摘要加附录明细的结构，标题要短，结论放在最前面；会议纪要发群后如果两小时内没人回复，就默认大家没有异议，可以直接推进下一步动作，不用反复催确认。",
  "踩坑记录：SQLite 在 WAL 模式下并发写仍可能触发 database is locked，高并发写入要收敛到单写线程或加重试退避；向量索引重建期间查询延迟会明显上升，尽量安排在凌晨低峰执行。",
  "团队约定：所有接口改动必须先更新接口文档再动代码，评审时以文档为准；涉及金额和权限的字段改动需要二次确认，测试用例必须覆盖越权场景，上线前由测试负责人在发布单上签字。",
  "客户背景：这家客户的采购流程要过三道审批，先部门负责人，再财务，最后分管副总；合同付款条款是验收后三十天付六成，质保期满付尾款，跟进时提前一周准备验收材料。",
  "技术决策：召回链路先走向量检索拿粗排候选，再用本地精排模型对候选做相关性打分，最后按分数截断返回；超时兜底策略是精排失败直接退回粗排顺序，宁可排序次优也不让请求失败。",
  "日程备忘：季度复盘定在下月十号下午两点，地点三号会议室；会前各小组提交数据看板截图和两个改进项，主持人提前一天把议程发到群里，会议产出要有明确的责任人和截止日期。",
  "知识条目：jieba 分词的搜索引擎模式会同时切出完整词和子词，索引侧和查询侧必须用同一种模式，否则召回会漏；停用词表保持精简，只收高频虚词，误杀实词会明显拉低召回率。",
  "风险清单：供应商的模型服务上周出现过两次超时，触发原因是对方网关限流；计划接入第二家供应商做互备，切换逻辑按错误率阈值自动触发，并在控制台暴露当前生效的供应商。",
  "学习笔记：transformers.js 首次批量推理要做两件事，一是模型权重加载，二是推理运行时会话的暖机；批量大小从一档升到十二档时延迟不是线性增长，预热要按真实批量跑一遍。",
  "项目背景：记忆系统要支持多租户隔离，检索按团队、用户、代理三个维度收窄，会话维度用于结论层缓存；跨租户数据严禁串池，测试环境专门准备了一套越权用例做回归。",
  "运维经验：服务重启后第一波请求延迟普遍偏高，原因包括字典加载、模型加载、连接池冷启动和 DNS 首连；对策是启动阶段逐项预热，并把各步骤耗时暴露到健康检查接口，便于观测。",
];

/** 生成 S3 本地档位预热文档：数量=candidates（缺省 12，clamp [1,100]），长度 50-200 字。 */
export function buildRerankWarmupDocs(candidates?: number): string[] {
  const raw = candidates ?? 12;
  const n = Number.isFinite(raw) ? Math.max(1, Math.min(100, Math.floor(raw))) : 12;
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(RERANK_WARMUP_CORPUS[i % RERANK_WARMUP_CORPUS.length]);
  return out;
}
