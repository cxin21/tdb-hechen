/**
 * SceneGovernor — L2 场景块治理执行器（Task GOV-3，spec DS-SCENE-GOV-001 §4.2）。
 *
 * 职责：extract 批次完成后扫描 scene_blocks/*.md，对超限块（正文码点 > maxBlockChars）
 * 触发独立蒸馏 LLM pass；蒸馏产出合格 → 写回前 backup → 写回；产出仍不合格 →
 * 码点安全硬截断兜底（hardCapFallback）写回；蒸馏失败/超时 → 原块保留 + loud 日志。
 *
 * 纪律：
 * - 纯判定逻辑全部来自 Task GOV-2 scene-governance.ts 纯函数（零重复实现）。
 * - storage(COS)/本地 fs 双模式分流写法沿用 scene-extractor.ts Phase 5 cleanup 的
 *   `this.storage ? ... : fs` 模式；backup 本地模式复用 utils/backup.ts 的
 *   BackupManager.backupFile，storage 模式用 storage.copyFile 做最小等效快照
 *   （服务模式的目录级快照/恢复由 storage backend 自身负责，与 extractor 的 bm 语义一致）。
 * - fail-safe：单块治理异常绝不外抛阻断 extract 主流程——原块保留 + loud warn +
 *   report.errors 登记（不静默降级）；enabled=false 时逐位现状 no-op。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { BackupManager } from "../../utils/backup.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { StoragePaths } from "../storage/types.js";
import type { Logger } from "../types.js";
import type { SceneGovernanceConfig } from "../../config.js";
import {
  buildDistillPrompts,
  countBlockChars,
  hardCapFallback,
  metaChars,
  needsGovernance,
  validateDistilled,
} from "./scene-governance.js";

/**
 * 治理专用 LLM runner 最小接口（结构化子集）。
 * SceneExtractor 持有的 LLMRunner 天然满足该形状（enableTools 与否不影响纯文本蒸馏）。
 */
export interface SceneGovernorRunner {
  run(params: { systemPrompt: string; prompt: string; timeoutMs?: number }): Promise<string>;
}

/** 治理结果报告（每轮 govern 汇总，供调用方日志与验收）。 */
export interface GovernReport {
  /** 枚举到的 scene_blocks/*.md 总数（enabled=false 时为 0）。 */
  scanned: number;
  /** 蒸馏成功写回的文件名（相对 scene_blocks/）。 */
  distilled: string[];
  /** 蒸馏产出不合格、经 hardCapFallback 兜底写回的文件名。 */
  hardCapped: string[];
  /** 不超限 / 空文件而放行的文件名。 */
  skipped: string[];
  /** 治理失败登记（原块保留）："<file>: <reason>"。 */
  errors: string[];
}

export interface SceneGovernorOptions {
  runner: SceneGovernorRunner;
  logger?: Logger;
}

export interface GovernOptions {
  dataDir: string;
  storage?: StorageAdapter;
  config: SceneGovernanceConfig;
}

const TAG = "[memory-tdai] [scene-governor]";
/** 写回前 backup 的类别（落盘在 <dataDir>/.backup/scene_governance/ 或 .backup/scene_governance/ key 前缀）。 */
const BACKUP_CATEGORY = "scene_governance";
/** 本地模式 backup 保留份数（BackupManager 自动剪枝）。 */
const BACKUP_MAX_KEEP = 10;

export class SceneGovernor {
  private readonly runner: SceneGovernorRunner;
  private readonly logger: Logger | undefined;

  constructor(opts: SceneGovernorOptions) {
    this.runner = opts.runner;
    this.logger = opts.logger;
  }

  /**
   * 治理一轮 scene_blocks/。enabled=false 直接返回空报告（逐位现状）。
   * 单块异常在块级 catch 内消化（原块保留 + errors 登记），绝不外抛。
   */
  async govern(opts: GovernOptions): Promise<GovernReport> {
    const { dataDir, storage, config } = opts;
    const report: GovernReport = { scanned: 0, distilled: [], hardCapped: [], skipped: [], errors: [] };

    // enabled=false：生产缺省路径，零 IO 零 LLM 调用，行为与现状逐位一致
    if (!config.enabled) return report;

    // 枚举 scene_blocks/*.md（分流写法沿用 scene-extractor Phase 5 cleanup）
    let files: string[];
    if (storage) {
      files = await storage.readdirNames(StoragePaths.sceneBlocksDir, ".md");
    } else {
      const blocksDir = path.join(dataDir, "scene_blocks");
      files = (await fs.readdir(blocksDir).catch(() => [] as string[])).filter((f) => f.endsWith(".md"));
    }
    report.scanned = files.length;
    if (files.length === 0) return report;

    for (const file of files) {
      try {
        await this.governOne(file, opts, report);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // fail-safe：原块保留 + loud，不静默
        this.logger?.warn(`${TAG} govern(${file}) failed, original block kept as-is: ${msg}`);
        report.errors.push(`${file}: ${msg}`);
      }
    }
    return report;
  }

  /** 治理单个块：skip 判定 → 蒸馏 → validate → backup → 写回 / 兜底。 */
  private async governOne(file: string, opts: GovernOptions, report: GovernReport): Promise<void> {
    const { dataDir, storage, config } = opts;
    const raw = await this.readBlock(file, dataDir, storage);
    if (raw === null || raw.trim().length === 0) {
      // 空文件（extract Phase 5 cleanup 已兜底删除，这里防御性放行）
      report.skipped.push(file);
      return;
    }

    if (!needsGovernance(raw, config.maxBlockChars)) {
      report.skipped.push(file);
      return;
    }

    // 蒸馏 pass：独立 LLM 调用（读原块 + §4.1 选择策略 prompt）
    const { systemPrompt, userPrompt } = buildDistillPrompts(raw, config.maxBlockChars);
    let out: string;
    try {
      out = await this.runner.run({
        systemPrompt,
        prompt: userPrompt,
        // distillTimeoutMs 经 GOV-1 clamp 非负；0 视为「不显式限时」→ 交给 runner 缺省
        timeoutMs: config.distillTimeoutMs > 0 ? config.distillTimeoutMs : undefined,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 蒸馏失败/超时：跳过本轮治理（保留原块）+ loud；下轮批次再触发
      this.logger?.warn(`${TAG} distill runner failed for ${file}, original block kept (non-fatal): ${msg}`);
      report.errors.push(`${file}: distill failed: ${msg}`);
      return;
    }

    // backup → 写回：蒸馏产出合格（≤ maxBlockChars + 有 META + 非空正文）
    if (validateDistilled(out, config.maxBlockChars)) {
      await this.backupBlock(file, dataDir, storage);
      await this.writeBlock(file, out, dataDir, storage);
      report.distilled.push(file);
      return;
    }

    // 兜底：产出不合格（仍超限 / 无 META / 空正文 / 含 U+FFFD）→ 码点安全硬截断。
    // 输入取产出本体（spec §4.2 ④「产出后复扫仍超限」）；产出为空时退化截原块
    //（保 META 头完整，绝不写回空文件）。
    const fallbackInput = out.trim().length > 0 ? out : raw;

    // N1/F-1 降级路径（同一处收口）：hardCapFallback 只会产出 META-only 文件时降级——
    // 不写回、原块保留、errors 登记 + loud warn。META-only 产物将被 extract Phase 5
    // cleanup 判「无正文」静默删除（= 变相清块），两种触发体：
    // - N1：META 头本身 ≥ hardCapChars（bodyBudget ≤ 0；现实触发体：21,660 字 summary 的存量块）；
    // - F-1：蒸馏产出为「合法 META 头 + 空/全空白正文」且头长 < hardCap−2（validateDistilled
    //   因 bodyNonEmpty 拒收后兜底判定放过 → truncateConclusionContent("") 直返空串）。
    // headerChars 口径与 hardCapFallback 一致（+2 = "\n\n"）；body 判空口径与
    // countBlockChars/validateDistilled 同族（排除 META 头及其后空白行）。
    const metaLen = metaChars(fallbackInput);
    const hardCapBudget = Math.floor(config.hardCapChars);
    const bodyEmpty = countBlockChars(fallbackInput) === 0;
    if (metaLen > 0 && (metaLen + 2 >= hardCapBudget || bodyEmpty)) {
      const reason = bodyEmpty
        ? `distilled body empty: fallback would produce META-only block (header ${metaLen} < hardCapChars ${config.hardCapChars} but body empty); original block kept`
        : `META exceeds hardCap: header ${metaLen}(+2 separator) >= hardCapChars ${config.hardCapChars}, hard-cap fallback would produce META-only block; original block kept`;
      this.logger?.warn(`${TAG} ${file}: ${reason} (fail-safe, loud)`);
      report.errors.push(`${file}: ${reason}`);
      return;
    }

    const capped = hardCapFallback(fallbackInput, config.hardCapChars);
    this.logger?.warn(
      `${TAG} distilled output for ${file} failed validation (len=${Array.from(out).length}), hard-capped to <=${config.hardCapChars} chars (fail-safe, loud)`,
    );
    await this.backupBlock(file, dataDir, storage);
    await this.writeBlock(file, capped, dataDir, storage);
    report.hardCapped.push(file);
  }

  /** 读块：storage key `scene_blocks/<file>` 或本地 `<dataDir>/scene_blocks/<file>`。 */
  private async readBlock(file: string, dataDir: string, storage?: StorageAdapter): Promise<string | null> {
    if (storage) {
      return storage.readFile(`${StoragePaths.sceneBlocksDir}${file}`);
    }
    try {
      return await fs.readFile(path.join(dataDir, "scene_blocks", file), "utf-8");
    } catch {
      return null;
    }
  }

  /**
   * 写回前 backup（spec §4.2 ③）：本地模式复用 BackupManager.backupFile（时间戳快照 +
   * 自动剪枝）；storage 模式用 storage.copyFile 写 `.backup/scene_governance/<ts>_<file>`。
   * backup 失败视为该块治理失败（宁可不动原块，也不无快照写回）——异常上抛由 govern 消化。
   */
  private async backupBlock(file: string, dataDir: string, storage?: StorageAdapter): Promise<void> {
    if (storage) {
      const backupKey = `${StoragePaths.backupDir}${BACKUP_CATEGORY}/${Date.now()}_${file}`;
      await storage.copyFile(`${StoragePaths.sceneBlocksDir}${file}`, backupKey);
      return;
    }
    const bm = new BackupManager(path.join(dataDir, ".backup"));
    // N3：tag 编入源文件名——同秒治理多个块时快照名互不相同，不互相覆盖
    //（与 storage 模式 `<ts>_<file>` 的命名语义对齐）。
    await bm.backupFile(
      path.join(dataDir, "scene_blocks", file),
      BACKUP_CATEGORY,
      path.basename(file, path.extname(file)),
      BACKUP_MAX_KEEP,
    );
  }

  /** 写回块文件（保留 META created 由蒸馏输出自带）。 */
  private async writeBlock(file: string, content: string, dataDir: string, storage?: StorageAdapter): Promise<void> {
    if (storage) {
      await storage.writeFile(`${StoragePaths.sceneBlocksDir}${file}`, content);
      return;
    }
    await fs.writeFile(path.join(dataDir, "scene_blocks", file), content, "utf-8");
  }
}
