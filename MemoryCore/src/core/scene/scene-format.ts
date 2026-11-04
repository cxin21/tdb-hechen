/**
 * Scene Block file format: parse and format the META-delimited Markdown files.
 */

import { normalizeSceneKeywords } from "./scene-keywords.js";

export interface SceneBlockMeta {
  created: string;
  updated: string;
  summary: string;
  heat: number;
  /**
   * 触发词（缺口 B）：注入侧命中即条件必注入。
   * 缺省/空数组时 formatMeta 逐位等于旧六行格式（历史块不受影响）。
   */
  keywords?: string[];
}

export interface SceneBlock {
  filename: string;
  meta: SceneBlockMeta;
  content: string;
}

const META_START = "-----META-START-----";
const META_END = "-----META-END-----";

/**
 * Parse a Scene Block file into structured data.
 */
export function parseSceneBlock(raw: string, filename: string): SceneBlock {
  const startIdx = raw.indexOf(META_START);
  const endIdx = raw.indexOf(META_END);

  if (startIdx === -1 || endIdx === -1) {
    // No META section — treat entire file as content
    return {
      filename,
      meta: { created: "", updated: "", summary: "", heat: 0 },
      content: raw.trim(),
    };
  }

  const metaBlock = raw.slice(startIdx + META_START.length, endIdx).trim();
  const content = raw.slice(endIdx + META_END.length).trim();

  const keywords = extractMetaField(metaBlock, "keywords")
    .split(/[，,、]/)
    .map((k) => k.trim())
    .filter((k) => k.length > 0);

  const meta: SceneBlockMeta = {
    created: extractMetaField(metaBlock, "created"),
    updated: extractMetaField(metaBlock, "updated"),
    summary: extractMetaField(metaBlock, "summary"),
    heat: parseInt(extractMetaField(metaBlock, "heat"), 10) || 0,
    ...(keywords.length > 0 ? { keywords } : {}),
  };

  return { filename, meta, content };
}

/**
 * Format a Scene Block back into file content.
 */
export function formatSceneBlock(meta: SceneBlockMeta, content: string): string {
  return `${formatMeta(meta)}\n\n${content}`;
}

/**
 * Format the META section.
 */
export function formatMeta(meta: SceneBlockMeta): string {
  const keywords = normalizeSceneKeywords(meta.keywords);
  return [
    META_START,
    `created: ${meta.created}`,
    `updated: ${meta.updated}`,
    `summary: ${meta.summary}`,
    `heat: ${meta.heat}`,
    ...(keywords.length > 0 ? [`keywords: ${keywords.join("，")}`] : []),
    META_END,
  ].join("\n");
}

/**
 * 取 META 单字段值。
 * 分隔空白必须是 `[ \t]*` 而非 `\s*`：后者在值为空时会**跨行**吞掉下一行，
 * 生产后果是 `summary:` 为空时把 `heat: 74` 读成 summary、heat 归 0
 * （2026-11-03 修，RED 见 scene/__tests__/scene-format-meta.test.ts）。
 */
function extractMetaField(metaBlock: string, field: string): string {
  const re = new RegExp(`^${field}:[ \\t]*(.*)$`, "m");
  const m = metaBlock.match(re);
  return m ? m[1]!.trim() : "";
}
