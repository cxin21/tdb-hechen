/**
 * 人格文件里两段「硬约束」的落地点（Round13 A3 复核 CP2）。
 *
 * 提示词一直写着「用户核心特征 ≤100 字、核心叙事 ≤400 字，硬约束」，
 * 但写出侧没有任何校验：LLM 写多长就存多长，于是「硬约束」只是愿望。
 * 这里把两段按字符（码点）截断，并把截断事实回给调用方写日志——
 * 让提示词里的数字与代码里的数字是同一个数字。
 */
export const PERSONA_SECTION_MAX_CHARS = { coreTraits: 100, coreNarrative: 400 } as const;

export interface PersonaClampResult {
  text: string;
  clamped: Array<{ heading: string; before: number; after: number }>;
}

const HEADINGS: Array<{ key: keyof typeof PERSONA_SECTION_MAX_CHARS; re: RegExp }> = [
  { key: "coreTraits", re: /^##\s*(?:用户核心特征|User Core Traits)\s*$/i },
  { key: "coreNarrative", re: /^##\s*(?:核心叙事|Core Narrative)\s*$/i },
];

export function clampPersonaSections(text: string): PersonaClampResult {
  const lines = text.split("\n");
  const clamped: PersonaClampResult["clamped"] = [];
  for (const { key, re } of HEADINGS) {
    const start = lines.findIndex((line) => re.test(line.trim()));
    if (start < 0) continue;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i += 1) {
      if (/^#{1,6}\s/.test(lines[i]!.trim())) {
        end = i;
        break;
      }
    }
    const body = lines.slice(start + 1, end).join("\n").trim();
    const chars = Array.from(body);
    const max = PERSONA_SECTION_MAX_CHARS[key];
    if (chars.length <= max) continue;
    const cut = chars
      .slice(0, max - 1)
      .join("")
      .replace(/[，、；：,\s]+$/u, "");
    const head = lines[start]!.trim();
    lines.splice(start + 1, end - start - 1, `${cut}…`, "");
    clamped.push({ heading: head, before: chars.length, after: Array.from(`${cut}…`).length });
  }
  return { text: lines.join("\n"), clamped };
}
