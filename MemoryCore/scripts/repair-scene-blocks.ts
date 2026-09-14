/**
 * 存量场景块修复脚本（Task GOV-4，spec DS-SCENE-GOV-001 §4.3）。
 *
 * 用途：对生产 scene_blocks/*.md 超限块（正文码点 > maxBlockChars）执行 SceneGovernor
 * 同款治理（backup → 蒸馏 → validate → 写回 / 兜底），把存量 188K 块修复到上限内。
 *
 * 与 SceneGovernor（scene-governor.ts）的差异——仅一处：**分段蒸馏上下文约束**。
 * 存量块可能远超模型上下文窗口（实测 TDB团队-技术架构文档.md ≈19 万码点），无法整块
 * 塞进一次蒸馏调用。分段策略：
 *   ① 块正文按 `## ` 章节标题 + 固定码点窗口（--segment-chars，缺省 20K）切片；
 *   ② 逐片蒸馏（每片独立 LLM 调用，按 spec §4.1 保留优先级输出片级要点）；
 *   ③ 合并片级要点做最终蒸馏（30-40 词 summary + 蒸馏正文）；
 *   ④ META 头由代码组装（formatSceneBlock 单一源）：created/heat 取原块、updated 刷新、
 *      summary 取 LLM 输出——spec §4.2 ② 的「created 保留/updated 刷新/summary 重写/
 *      heat 保留」由代码保证而非 LLM 自觉。实际分段数记入报告。
 *
 * 纪律（与 spec §4.2 / GOV-3 逐条对齐）：
 * - 纯判定/兜底逻辑零重复实现：countBlockChars / needsGovernance / validateDistilled /
 *   hardCapFallback / metaChars 全部来自 scene-governance.ts 单一源。
 * - 蒸馏 LLM 失败/超时 → 该块保留原样 + report.errors 登记（不静默）。
 * - 写回前必有 backup（BackupManager.backupFile，复用 GOV-3 同款 category/tag 语义）。
 * - validate 不过 → N1 巨型 META 降级（metaChars+2 ≥ hardCapChars 时不写回）→ 否则
 *   hardCapFallback 码点安全兜底，零 U+FFFD。
 * - 只写块文件与 scene_index.json；不重启任何服务进程；不碰 vectors.db。
 *
 * 索引同步（Task GOV-4 第 3 项）：写回后直接调用 syncSceneIndex（scene-index.ts 单一源）
 * 重建 .metadata/scene_index.json。依据：运行中服务仅在 extract 批次末尾 sync 索引，
 * 注入侧 readSceneIndex 每轮直接读该文件——不刷新则注入侧继续读到旧 21K 截断 summary。
 *
 * 运行（MemoryCore 目录下）：
 *   node --import tsx scripts/repair-scene-blocks.ts            # dry-run（缺省，零写）
 *   node --import tsx scripts/repair-scene-blocks.ts --apply    # 真实修复 + 复扫 + 报告落盘
 *
 * 报告：MemoryCore/runs/repair-scene-blocks-<ts>.json（--apply 时写；dry-run 也写
 * same-shape 报告便于留痕，mode=dry-run）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import YAML from "yaml";

// 生产同构模块（tsx 直跑；单一源复用，禁第二份实现）
const { countBlockChars, needsGovernance, validateDistilled, hardCapFallback, metaChars } =
  await import("../src/core/scene/scene-governance.js");
const { parseSceneBlock, formatSceneBlock } = await import("../src/core/scene/scene-format.js");
const { syncSceneIndex } = await import("../src/core/scene/scene-index.js");
const { BackupManager } = await import("../src/utils/backup.js");
const { StandaloneLLMRunner } = await import("../src/adapters/standalone/llm-runner.js");
const { buildProfileIsolationScope } = await import("../src/core/profile/profile-sync.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORE_DIR = path.resolve(__dirname, "..");
const RUNS_DIR = path.join(CORE_DIR, "runs");
const PROD_YAML = path.join(CORE_DIR, "tdai-gateway.yaml"); // 只读（LLM 凭据回退源）
const TAG = "[repair-scene-blocks]";
const BACKUP_CATEGORY = "scene_governance"; // 与 SceneGovernor 同款
const BACKUP_MAX_KEEP = 10;

// ── CLI ─────────────────────────────────────────────────────────────
function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a.startsWith("--")) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${TAG} 参数 ${a} 缺值`);
      args[a.slice(2)] = v;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`用法：node --import tsx scripts/repair-scene-blocks.ts [--apply]
  缺省 dry-run：扫描 + 打印超限清单，零写。
  --apply：分段蒸馏修复 + backup + 写回 + 复扫 + scene_index 同步 + 报告落盘。
选项：
  --data-dir         生产 dataDir（缺省 D:/tdai-data，只写 profiles/<scope>/ 下的块与索引）
  --team / --agent   profile 隔离 scope（缺省 team-2j92u63hre / agt-2t81sh9zdz，与锚点评测同 scope）
  --max-block-chars  超限触发上限（缺省 8000，与 sceneGovernance.maxBlockChars 缺省一致）
  --hard-cap-chars   兜底硬截断上限（缺省 20000，与 sceneGovernance.hardCapChars 缺省一致）
  --segment-chars    分片码点窗口（缺省 6000；存量大块按 "## " 章节 + 此窗口切片。
                     依据 L1 实证：ark-code-latest 推理模型大 prompt 空输出的根因是
                     prompt 规模与推理输出预算竞争，降批量有效、提 maxTokens 无效）
  --segment-budget   每片蒸馏要点输出预算码点（缺省 1000）
  --timeout-ms       单次蒸馏 LLM 超时（缺省 120000）
  --max-tokens       单次蒸馏 maxOutputTokens（缺省 32768；推理模型思考 token 计入该预算）
  --segment-retries  每片蒸馏失败（空输出/超时/异常）重试次数（缺省 2）
  --seg-cache <path> 分片产出缓存 JSON（key=文件#片号#内容sha；重跑跳过已完成片，
                     只重试失败片——避免整块重烧 LLM 调用）`);
  process.exit(0);
}

const APPLY = args.apply === true;
const DATA_DIR = String(args["data-dir"] ?? "D:/tdai-data");
const TEAM = String(args.team ?? "team-2j92u63hre");
const AGENT = String(args.agent ?? "agt-2t81sh9zdz");
const MAX_BLOCK_CHARS = Number(args["max-block-chars"] ?? 8000);
// 终蒸馏提示预算（给 MAX_BLOCK_CHARS 留余量——LLM 对"≤8000"有 ~10% 超写倾向，实证 8877）
const FINAL_BUDGET = Number(args["final-budget"] ?? Math.max(0, MAX_BLOCK_CHARS - 400));
const HARD_CAP_CHARS = Number(args["hard-cap-chars"] ?? 20000);
const SEGMENT_CHARS = Number(args["segment-chars"] ?? 6000);
const SEGMENT_BUDGET = Number(args["segment-budget"] ?? 1000);
const TIMEOUT_MS = Number(args["timeout-ms"] ?? 120_000);
const MAX_TOKENS = Number(args["max-tokens"] ?? 32768);
const SEGMENT_RETRIES = Number(args["segment-retries"] ?? 2);
const SEG_CACHE_PATH = args["seg-cache"] ? path.resolve(String(args["seg-cache"])) : null;

/** 分片产出缓存（--seg-cache）：key = `file#idx#sha1(segmentText)`，重跑复用已完成片。 */
function loadSegCache(): Record<string, string> {
  if (!SEG_CACHE_PATH || !fs.existsSync(SEG_CACHE_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(SEG_CACHE_PATH, "utf-8")); } catch { return {}; }
}
function saveSegCache(cache: Record<string, string>): void {
  if (!SEG_CACHE_PATH) return;
  fs.mkdirSync(path.dirname(SEG_CACHE_PATH), { recursive: true });
  fs.writeFileSync(SEG_CACHE_PATH, JSON.stringify(cache, null, 2), "utf-8");
}
function segKey(file: string, idx: number, segText: string): string {
  return `${file}#${idx}#${segKeyHash(segText)}`;
}
function segKeyHash(s: string): string {
  // 轻量内容指纹（无 crypto 依赖循环）：首 64 码点 + 长度 + 尾 64 码点
  const pts = Array.from(s);
  return `${pts.slice(0, 64).join("")}…${pts.length}…${pts.slice(-64).join("")}`;
}

const log = (...a: unknown[]) => console.log(TAG, ...a);
const loud = (...a: unknown[]) => console.error(`${TAG}[LOUD]`, ...a);
const cpLen = (s: string) => Array.from(s).length;
const countUfffd = (s: string) => (s.match(/\uFFFD/g) ?? []).length;

/** 额度类失败标记（quota-blocked：原块保留、不刷重试、继续下一块）。 */
class QuotaBlockError extends Error {}

/** 额度/配额类错误（HTTP 429/402/403、rate limit 等）：不刷重试，quota-blocked 快速跳过。 */
function isQuotaError(msg: string): boolean {
  return /(^|[^0-9])(429|402|403)([^0-9]|$)/.test(msg)
    || /rate limit|too many requests|payment required|forbidden|quota|配额|额度/i.test(msg);
}

/**
 * 带重试 + 额度分类的 runner.run 封装（Task GOV-4 用户修正口径）：
 * 空输出/超时等 → 重试 SEGMENT_RETRIES 次；HTTP 429/402/403（额度/配额类）→ 不刷重试，
 * 返回 null 由调用方把该块标记 quota-blocked 并继续下一块（避免把额度烧在死磕上）。
 */
async function runWithRetry(
  runner: { run(p: { systemPrompt: string; prompt: string; timeoutMs?: number }): Promise<string> },
  params: { systemPrompt: string; prompt: string; timeoutMs?: number },
  label: string,
): Promise<string | null> {
  let lastErr = "";
  for (let attempt = 0; attempt <= SEGMENT_RETRIES; attempt++) {
    try {
      const r = await runner.run(params);
      if (r.trim().length > 0) return r;
      // 空输出（推理模型思考烧爆输出预算，finishReason=length）：按可重试失败处理
      lastErr = "empty output (finishReason=length, thinking budget exhausted?)";
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    if (isQuotaError(lastErr)) {
      loud(`${label}: quota/credit error, NOT retrying: ${lastErr}`);
      return null;
    }
    loud(`${label} attempt ${attempt + 1}/${SEGMENT_RETRIES + 1} failed: ${lastErr}`);
  }
  throw new Error(`${label} failed after ${SEGMENT_RETRIES + 1} attempts: ${lastErr}`);
}

// ── 生产路径定位（与 pipeline-factory scopedDataDirForScope / eval-layered-recall 同构）──
const scope = buildProfileIsolationScope({ teamId: TEAM, agentId: AGENT });
const profileDataDir = path.join(DATA_DIR, "profiles", encodeURIComponent(scope));
const blocksDir = path.join(profileDataDir, "scene_blocks");

// ── LLM runner（凭据 env 优先 > 只读 yaml llm 段，与 gateway 配置优先级同形）────────
function buildRunner(): { run(p: { systemPrompt: string; prompt: string; timeoutMs?: number }): Promise<string>; model: string } {
  const envBase = process.env.TDAI_LLM_BASE_URL?.trim();
  const envKey = process.env.TDAI_LLM_API_KEY?.trim();
  const envModel = process.env.TDAI_LLM_MODEL?.trim();
  let baseUrl = envBase, apiKey = envKey, model = envModel, credSource = "env:TDAI_LLM_*";
  if (!baseUrl || !apiKey || !model) {
    const cfg = YAML.parse(fs.readFileSync(PROD_YAML, "utf8")) as any; // 只读
    const llm = cfg?.llm ?? {};
    baseUrl ??= llm.baseUrl;
    apiKey ??= llm.apiKey;
    model ??= llm.model;
    credSource = "env 覆盖 + 只读 tdai-gateway.yaml llm 段回退";
  }
  if (!baseUrl || !apiKey || !model) throw new Error(`${TAG} LLM 凭据不全（env 与 yaml 均未配齐）`);
  log(`LLM: model=${model} credSource=${credSource}`);
  const runner = new StandaloneLLMRunner({
    config: { baseUrl: baseUrl!, apiKey: apiKey!, model: model!, maxTokens: MAX_TOKENS, timeoutMs: TIMEOUT_MS },
    logger: console as never,
  });
  return { run: (p) => runner.run(p), model: model! };
}

// ── §4.1 保留优先级（与 scene-governance.ts buildDistillPrompts 逐字同口径）──────────
const PRIORITY_TEXT = [
  "保留优先级（不可重构性优先，从高到低逐条执行，冲突时高优先级胜出）：",
  "1. 未闭合事项（待确认 / 矛盾点）：最高优先，必须完整保留——这些是 L1 原文里找不到的推理状态，丢失不可逆。",
  "2. 演变轨迹：偏好 / 观念变化的浓缩必须保留，同属不可重构。",
  "3. 时近性：近期决策结论（滚动窗口内）优先保留。",
  "4. 已闭合叙事：压缩为一句索引级结论即可，原文可查 L1 故可弃。",
].join("\n");

// ── 分片：正文按 `## ` 章节边界 + 码点窗口切片（确定性，单一实现）──────────────────
export function segmentBody(body: string, segmentChars: number): string[] {
  const lines = body.split(/\r?\n/);
  const segments: string[] = [];
  let cur: string[] = [];
  let curLen = 0;
  const flush = () => {
    if (cur.length > 0) segments.push(cur.join("\n"));
    cur = [];
    curLen = 0;
  };
  for (const line of lines) {
    const lineLen = cpLen(line) + 1;
    // 章节标题处优先收口（标题不是本片第一行时）
    if (curLen > 0 && curLen + lineLen > segmentChars) {
      const lastHeading = cur.map((l) => l.startsWith("## ")).lastIndexOf(true);
      if (lastHeading > 0) {
        segments.push(cur.slice(0, lastHeading).join("\n"));
        cur = cur.slice(lastHeading);
        curLen = cpLen(cur.join("\n")) + 1;
      } else {
        flush();
      }
    }
    // 单行超窗（ pathological 长行）：按码点窗口硬切
    if (lineLen > segmentChars) {
      flush();
      const pts = Array.from(line);
      for (let i = 0; i < pts.length; i += segmentChars) {
        segments.push(pts.slice(i, i + segmentChars).join(""));
      }
      continue;
    }
    cur.push(line);
    curLen += lineLen;
  }
  flush();
  return segments;
}

// ── 蒸馏 prompts ────────────────────────────────────────────────────
function segmentPrompt(seg: string, idx: number, total: number) {
  const systemPrompt = [
    "你是 L2 场景块分段蒸馏器。输入是一个超大场景块的第 idx/total 片（纯正文切片，无 META 头）。",
    "请按下方保留优先级把本片压缩为要点列表（保留片内 `## ` 章节标题行，要点用 - 列表）。",
    PRIORITY_TEXT,
    "",
    `输出硬约束：只输出要点列表本体，≤ ${SEGMENT_BUDGET} 字符（Unicode 码点），不要任何解释或代码围栏。`,
    "本片没有信息的内容（如重复句、纯过程叙事）直接丢弃。",
  ].join("\n");
  const userPrompt = [
    `以下是大块的第 ${idx}/${total} 片，请输出片级要点：`,
    "",
    "<segment>",
    seg,
    "</segment>",
  ].join("\n");
  return { systemPrompt, userPrompt };
}

function finalPrompt(mergedPoints: string) {
  const systemPrompt = [
    "你是 L2 场景块蒸馏编辑器。输入是一个超大场景块经分段蒸馏后的片级要点合集，请将其整合重写为一个精炼的完整场景块正文。",
    "",
    `总长硬约束：正文不得超过 ${FINAL_BUDGET} 字符（按 Unicode 码点计数，非字节数；验收上限 ${MAX_BLOCK_CHARS}，留余量）。`,
    "",
    PRIORITY_TEXT,
    "",
    "输出格式要求（严格遵守）：",
    `- 第一行必须是 "SUMMARY: <30-40 词的场景块摘要>"。`,
    "- 其后输出蒸馏后的正文（保持既有章节结构，仅章节内蒸馏精炼，不要发明新章节）。",
    "- 不要输出 META 头（-----META-START----- 等标记由系统负责组装）。",
    "- 只输出 SUMMARY 行与正文，不要任何解释或代码围栏。",
  ].join("\n");
  const userPrompt = [
    `以下为片级要点合集，请整合为 ≤ ${FINAL_BUDGET} 码点的完整场景块正文（含 SUMMARY 行）：`,
    "",
    "<segmented_points>",
    mergedPoints,
    "</segmented_points>",
  ].join("\n");
  return { systemPrompt, userPrompt };
}

// ── 重复句检查（Task GOV-4 复扫口径：两句各计数应为 1）────────────────────────────
const DUP_SENTENCES = ["超时/重试与 T4-T6 整体联调", "T1（DROP 重建）对既有存量数据"];
function dupCounts(text: string): Record<string, number> {
  return Object.fromEntries(DUP_SENTENCES.map((s) => [s, text.split(s).length - 1]));
}

// ── 主流程 ──────────────────────────────────────────────────────────
interface BlockReport {
  file: string;
  charsBefore: number;
  ufffdBefore: number;
  overLimit: boolean;
  action: "skipped" | "distilled" | "hardCapped" | "error" | "quotaBlocked";
  segments?: number;
  charsAfter?: number;
  deterministicTrim?: { from: number; to: number };
  ufffdAfter?: number;
  dupBefore?: Record<string, number>;
  dupAfter?: Record<string, number>;
  error?: string;
}

async function main(): Promise<void> {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const mode = APPLY ? "apply" : "dry-run";
  log(`mode=${mode} profileDataDir=${profileDataDir}`);
  log(`config: maxBlockChars=${MAX_BLOCK_CHARS} hardCapChars=${HARD_CAP_CHARS} segmentChars=${SEGMENT_CHARS} segmentBudget=${SEGMENT_BUDGET} timeoutMs=${TIMEOUT_MS}`);

  const files = fs.existsSync(blocksDir)
    ? fs.readdirSync(blocksDir).filter((f) => f.endsWith(".md"))
    : [];
  if (files.length === 0) throw new Error(`${TAG} scene_blocks 目录为空或不存在: ${blocksDir}`);

  const blocks: BlockReport[] = [];
  const runner = APPLY ? buildRunner() : null;
  const segCache = loadSegCache();
  if (SEG_CACHE_PATH) log(`seg-cache: ${SEG_CACHE_PATH} (${Object.keys(segCache).length} entries loaded)`);

  for (const file of files) {
    const abs = path.join(blocksDir, file);
    const raw = fs.readFileSync(abs, "utf-8");
    const charsBefore = countBlockChars(raw);
    const ufffdBefore = countUfffd(raw);
    const over = needsGovernance(raw, MAX_BLOCK_CHARS);
    log(`scan ${file}: bodyChars=${charsBefore} ufffd=${ufffdBefore} over=${over}`);
    if (!over) {
      blocks.push({ file, charsBefore, ufffdBefore, overLimit: false, action: "skipped" });
      continue;
    }
    if (!APPLY || !runner) {
      blocks.push({ file, charsBefore, ufffdBefore, overLimit: true, action: "skipped" });
      continue;
    }

    const rep: BlockReport = { file, charsBefore, ufffdBefore, overLimit: true, action: "error" };
    blocks.push(rep);
    try {
      const parsed = parseSceneBlock(raw, file);
      const body = parsed.content;

      // ① 分片
      const segments = segmentBody(body, SEGMENT_CHARS);
      rep.segments = segments.length;
      log(`  ${file}: segmented into ${segments.length} pieces (window=${SEGMENT_CHARS})`);

      // ② 逐片蒸馏：空输出/超时重试 SEGMENT_RETRIES 次；额度类（429/402/403）→
      //    该块 quota-blocked（原块保留），继续下一块。任一片最终失败 → 整块保留原样。
      const segPoints: string[] = [];
      for (let i = 0; i < segments.length; i++) {
        const segText = segments[i]!;
        const key = segKey(file, i, segText);
        const cached = segCache[key];
        if (typeof cached === "string" && cached.trim().length > 0) {
          segPoints.push(cached.trim());
          log(`  segment ${i + 1}/${segments.length}: ${cpLen(segText)} -> ${cpLen(cached)} chars (cache hit)`);
          continue;
        }
        const p = segmentPrompt(segText, i + 1, segments.length);
        let out: string | null;
        try {
          out = await runWithRetry(
            runner,
            { systemPrompt: p.systemPrompt, prompt: p.userPrompt, timeoutMs: TIMEOUT_MS },
            `${file} segment ${i + 1}/${segments.length}`,
          );
        } catch (err) {
          throw new Error(`segment ${i + 1}/${segments.length} distill failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (out === null) throw new QuotaBlockError(`segment ${i + 1}/${segments.length}: quota/credit error`);
        const trimmed = out.trim();
        segPoints.push(trimmed);
        segCache[key] = trimmed;
        saveSegCache(segCache);
        log(`  segment ${i + 1}/${segments.length}: ${cpLen(segText)} -> ${cpLen(trimmed)} chars`);
      }

      // ③ 合并终蒸馏（产出 SUMMARY 行 + 正文；META 由代码组装）
      const fp = finalPrompt(segPoints.join("\n\n"));
      const finalRaw = await runWithRetry(
        runner,
        { systemPrompt: fp.systemPrompt, prompt: fp.userPrompt, timeoutMs: TIMEOUT_MS },
        `${file} final distill`,
      );
      if (finalRaw === null) throw new QuotaBlockError("final distill: quota/credit error");
      const finalOut = finalRaw;
      const m = finalOut.match(/^SUMMARY:\s*(.+)$/m);
      const summary = (m?.[1] ?? parsed.meta.summary).trim();
      if (!m) loud(`${file}: 终蒸馏输出缺 SUMMARY 行，summary 沿用原块 META`);
      const newBody = finalOut.slice(m ? (m.index ?? 0) + m[0].length : 0).trim();
      if (newBody.length === 0) throw new Error("final distill produced empty body");
      const candidate = formatSceneBlock(
        {
          created: parsed.meta.created || new Date().toISOString(),
          updated: new Date().toISOString(),
          summary,
          heat: parsed.meta.heat,
        },
        newBody,
      );

      // ④ validate → backup → 写回 / N1 降级 / 兜底（SceneGovernor 同款判定顺序）
      rep.dupBefore = dupCounts(raw);
      if (validateDistilled(candidate, MAX_BLOCK_CHARS)) {
        await new BackupManager(path.join(profileDataDir, ".backup")).backupFile(
          abs, BACKUP_CATEGORY, path.basename(file, path.extname(file)), BACKUP_MAX_KEEP,
        );
        fs.writeFileSync(abs, candidate, "utf-8");
        rep.action = "distilled";
      } else {
        const metaLen = metaChars(candidate);
        if (metaLen > 0 && metaLen + 2 >= HARD_CAP_CHARS) {
          throw new Error(`META exceeds hardCap: header ${metaLen}(+2) >= hardCapChars ${HARD_CAP_CHARS}, would produce META-only block; original kept`);
        }
        const capped = hardCapFallback(candidate.trim().length > 0 ? candidate : raw, HARD_CAP_CHARS);
        loud(`${file}: distilled output failed validation (len=${cpLen(candidate)}), hard-capped to <=${HARD_CAP_CHARS} (fail-safe)`);
        await new BackupManager(path.join(profileDataDir, ".backup")).backupFile(
          abs, BACKUP_CATEGORY, path.basename(file, path.extname(file)), BACKUP_MAX_KEEP,
        );
        // 确定性收尾裁剪：修复脚本的验收线是 ≤ maxBlockChars（8000），兜底仍超限时
        // 按上限预算再做一次码点安全截断（hardCapFallback 单一源，零 U+FFFD）
        if (countBlockChars(capped) > MAX_BLOCK_CHARS) {
          const trimmed = hardCapFallback(capped, MAX_BLOCK_CHARS);
          loud(`${file}: still over maxBlockChars (${countBlockChars(capped)} > ${MAX_BLOCK_CHARS}), deterministic trim to <=${MAX_BLOCK_CHARS}`);
          fs.writeFileSync(abs, trimmed, "utf-8");
          rep.action = "hardCapped";
          // N2（GOV-4 复审）：确定性收尾裁剪专用字段——封死"只存 loud 日志"的静默通道
          rep.deterministicTrim = { from: countBlockChars(capped), to: countBlockChars(trimmed) };
        } else {
          fs.writeFileSync(abs, capped, "utf-8");
          rep.action = "hardCapped";
        }
      }
    } catch (err) {
      // 额度类失败：quota-blocked（原块保留，不刷重试不烧额度）；其余：原块保留 + loud
      if (err instanceof QuotaBlockError) {
        rep.action = "quotaBlocked";
        rep.error = err.message;
        loud(`${file}: QUOTA-BLOCKED, original block kept as-is: ${err.message}`);
      } else {
        rep.action = "error";
        rep.error = err instanceof Error ? err.message : String(err);
        loud(`${file}: repair failed, original block kept as-is: ${rep.error}`);
      }
    }

    // 复扫（无论成功失败，如实登记写回后状态）
    const after = fs.readFileSync(path.join(blocksDir, file), "utf-8");
    rep.charsAfter = countBlockChars(after);
    rep.ufffdAfter = countUfffd(after);
    rep.dupAfter = dupCounts(after);
    log(`rescan ${file}: bodyChars=${charsBefore}->${rep.charsAfter} ufffd=${ufffdBefore}->${rep.ufffdAfter} action=${rep.action}`);
  }

  // ── 全量复扫验收（≤上限 + 零 U+FFFD）──────────────────────────────
  const rescan = files.map((file) => {
    const after = fs.readFileSync(path.join(blocksDir, file), "utf-8");
    return {
      file,
      bodyChars: countBlockChars(after),
      withinLimit: countBlockChars(after) <= MAX_BLOCK_CHARS,
      ufffd: countUfffd(after),
      dupCounts: dupCounts(after),
    };
  });
  const allWithin = rescan.every((r) => r.withinLimit);
  const zeroUfffd = rescan.every((r) => r.ufffd === 0);
  log(`rescan verdict: allWithinLimit=${allWithin} zeroUfffd=${zeroUfffd}`);

  // ── 索引同步（--apply 且有写回时；依据见文件头注释）────────────────
  let indexSync: { performed: boolean; entries?: number; reason: string } = {
    performed: false,
    reason: APPLY
      ? "no distilled/hardCapped blocks (nothing changed)"
      : "dry-run（零写，索引不动）",
  };
  if (APPLY && blocks.some((b) => b.action === "distilled" || b.action === "hardCapped")) {
    const entries = await syncSceneIndex(profileDataDir);
    indexSync = {
      performed: true,
      entries: entries.length,
      reason: "写回后直接调用 syncSceneIndex 重建 .metadata/scene_index.json——运行中服务仅在 extract 批次末尾 sync，注入侧 readSceneIndex 每轮直读该文件，不刷新则继续读到旧截断 summary（scene-index.ts 单一源 rebuild 逻辑）",
    };
    log(`scene_index synced: ${entries.length} entries -> ${path.join(profileDataDir, ".metadata", "scene_index.json")}`);
  }

  const report = {
    ts,
    mode,
    gitSha: null as string | null,
    config: {
      dataDir: DATA_DIR, profileScope: scope, profileDataDir,
      maxBlockChars: MAX_BLOCK_CHARS, hardCapChars: HARD_CAP_CHARS,
      segmentChars: SEGMENT_CHARS, segmentBudget: SEGMENT_BUDGET, timeoutMs: TIMEOUT_MS,
      llmModel: runner?.model ?? null,
    },
    segmentationStrategy: "块正文按 `## ` 章节标题边界 + --segment-chars 码点窗口切片（超窗单行按码点硬切）→ 逐片蒸馏要点（spec §4.1 保留优先级）→ 合并片级要点终蒸馏 → 代码组装 META（created/heat 取原块、updated 刷新、summary 取 LLM SUMMARY 行）",
    blocks,
    rescan,
    verdict: {
      allWithinLimit: allWithin,
      zeroUfffd,
      quotaBlockedFiles: blocks.filter((b) => b.action === "quotaBlocked").map((b) => b.file),
      note: "quota-blocked = 额度类失败（429/402/403），原块保留、不刷重试；部分修复也算交付（用户裁决 2026-09-12）",
    },
    indexSync,
  };
  try {
    const { execSync } = await import("node:child_process");
    report.gitSha = execSync("git rev-parse HEAD", { cwd: CORE_DIR, encoding: "utf8" }).trim();
  } catch { report.gitSha = null; }

  fs.mkdirSync(RUNS_DIR, { recursive: true });
  const reportPath = path.join(RUNS_DIR, `repair-scene-blocks-${ts}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf-8");
  log(`report written: ${reportPath}`);

  if (APPLY) {
    const failed = blocks.filter((b) => b.action === "error");
    const quotaBlocked = blocks.filter((b) => b.action === "quotaBlocked");
    if (quotaBlocked.length > 0) {
      loud(`部分修复交付（quota-blocked）：${quotaBlocked.map((b) => b.file).join(", ")} 原样保留；其余块已按上限修复`);
    }
    const hardFail = failed.length > 0 || (!allWithin && quotaBlocked.length === 0) || (!zeroUfffd && quotaBlocked.length === 0);
    if (hardFail) {
      loud(`完成但有失败项：errors=${failed.length} allWithin=${allWithin} zeroUfffd=${zeroUfffd}`);
      process.exitCode = 2;
    }
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main().catch((err) => {
    loud("uncaught:", err instanceof Error ? err.stack : String(err));
    process.exitCode = 1;
  });
}
