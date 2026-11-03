/**
 * #107 typecheck 门禁的纯函数层（无 IO，便于 node --test 直接覆盖）。
 *
 * 判据（2026-11-03 起的第三版）：按「文件 × 错误码」判，并对**名称解析码族**的
 * 同文件互换做一次显式 INFO 归并。演进史：
 *
 * 1) v1「文件 × 错误码」严格判 → 名称解析码会随 TS 版本/上下文漂移
 *    （TS2304 ↔ TS2552「Did you mean …」），同一行只换码就 FAIL，属误报；
 *    实测可复现：把两个无关文件的改动 stash 回 HEAD，generated/schemas.ts 的
 *    TS2552 从 8 退回 6、总数 200→202，门禁反而 PASS。
 * 2) v2「文件面积」判（2026-11-02）→ 消掉上述误报，却引入真漏洞：同一文件内
 *    一条错误消失、另一条新增，面积不变 ⇒ PASS。审查判为 MAJOR 门禁弱化。
 * 3) v3（本版）→ 恢复 (file, code) 粒度；只在同一文件内、且仅限
 *    NAME_RESOLUTION_CODES 族内做一增一减抵消（INFO：reclassified）。
 *    其它任何 (file, code) 的新增、或同文件非族内互换，一律 FAIL。
 *
 * 输出语义：
 *   - added：某 (file, code) 条数比基线多，或出现基线里没有的 (file, code)
 *            （FAIL；全局错误同样严格）；
 *   - removed：某 (file, code) 条数比基线少（只提示，可用 --update 收紧）；
 *   - reclassified：同文件名称解析族内互换且互相抵消的部分（INFO，不影响 exit code）；
 *   - globalErrors：仍严格（无位置信息的错误不允许静默增长）。
 */

/** <file>(<line>,<col>): error TSxxxx: <message> */
const DIAG_RE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
/** 无位置信息的全局错误（如 TS5055） */
const GLOBAL_RE = /^error (TS\d+): (.*)$/;

/**
 * 名称解析族：同一行源码在不同 TS 版本/上下文下会在这些码之间漂移，语义都是
 * 「这个名字解析不出来」，故允许同文件内互相抵消。扩表必须有同义的一手证据
 * （tsc 报错文本或实测复现），不得凭感觉加。
 */
export const NAME_RESOLUTION_CODES = Object.freeze(["TS2304", "TS2552", "TS2551"]);

export function sortObject(obj) {
  const out = {};
  for (const key of Object.keys(obj).sort()) out[key] = obj[key];
  return out;
}

/** byGroup（"file\0CODE" -> count）转普通对象，写基线用 */
export function groupAsObject(byGroup) {
  const out = {};
  for (const [key, count] of Object.entries(byGroup)) out[key] = count;
  return out;
}

/**
 * 解析 tsc --pretty false 的输出。
 * @param {string} output
 * @returns {{total:number,fileCount:number,globalErrors:number,byCode:Record<string,number>,byFile:Record<string,number>,byGroup:Record<string,number>,details:Array<{file:string,line:number,code:string,message:string}>}}
 */
export function parseDiagnostics(output) {
  const byFile = {};
  const byCode = {};
  const byGroup = {};
  const details = [];
  let globalErrors = 0;

  for (const raw of String(output).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = DIAG_RE.exec(line);
    if (m) {
      const file = m[1].split("\\").join("/");
      const code = m[4];
      byFile[file] = (byFile[file] || 0) + 1;
      byCode[code] = (byCode[code] || 0) + 1;
      const group = file + "\u0000" + code;
      byGroup[group] = (byGroup[group] || 0) + 1;
      details.push({ file, line: Number(m[2]), code, message: m[5] });
      continue;
    }
    const g = GLOBAL_RE.exec(line);
    if (g) {
      globalErrors += 1;
      details.push({ file: "<global>", line: 0, code: g[1], message: g[2] });
    }
  }

  return {
    total: details.length,
    fileCount: Object.keys(byFile).length,
    globalErrors,
    byCode: sortObject(byCode),
    byFile: sortObject(byFile),
    byGroup,
    details,
  };
}

/**
 * 按 (file, code) 比较当前快照与基线，名称解析族内的同文件互换单独归并。
 * @param {ReturnType<typeof parseDiagnostics>} current
 * @param {{byFile?:Record<string,number>,globalErrors?:number,groups?:Record<string,number>,byGroup?:Record<string,number>}} baseline
 * @returns {{
 *   added:Array<{file:string,code:string,before:number,after:number,newFile:boolean}>,
 *   removed:Array<{file:string,code:string,before:number,after:number}>,
 *   reclassified:Array<{file:string,before:Record<string,number>,after:Record<string,number>}>
 * }}
 */
export function compareDiagnostics(current, baseline) {
  const beforeFiles = baseline.byFile || {};
  const afterFiles = current.byFile || {};
  const added = [];
  const removed = [];
  const reclassified = [];

  const files = new Set([...Object.keys(beforeFiles), ...Object.keys(afterFiles)]);
  for (const file of [...files].sort()) {
    const bMix = codeMixOf(baseline, file);
    const aMix = codeMixOf(current, file);
    const newFile = (beforeFiles[file] || 0) === 0;
    const codes = [...new Set([...Object.keys(bMix), ...Object.keys(aMix)])].sort();

    const grew = [];
    const shrunk = [];
    for (const code of codes) {
      const b = bMix[code] || 0;
      const a = aMix[code] || 0;
      if (a > b) grew.push({ code, delta: a - b });
      else if (a < b) shrunk.push({ code, delta: b - a });
    }

    // 名称解析族内的互换抵消：同文件、族内、一增一减，按码序确定地配对。
    const familyGrow = grew.filter((g) => NAME_RESOLUTION_CODES.includes(g.code));
    const familyShrink = shrunk.filter((s) => NAME_RESOLUTION_CODES.includes(s.code));
    let reconciled = 0;
    if (familyGrow.length > 0 && familyShrink.length > 0) {
      for (const g of familyGrow) {
        for (const s of familyShrink) {
          if (g.delta === 0 || s.delta === 0) continue;
          const n = Math.min(g.delta, s.delta);
          g.delta -= n;
          s.delta -= n;
          reconciled += n;
        }
      }
    }
    if (reconciled > 0) reclassified.push({ file, before: bMix, after: aMix });

    for (const g of grew) {
      if (g.delta <= 0) continue;
      added.push({
        file,
        code: g.code,
        before: bMix[g.code] || 0,
        after: aMix[g.code] || 0,
        newFile,
      });
    }
    for (const s of shrunk) {
      if (s.delta <= 0) continue;
      removed.push({
        file,
        code: s.code,
        before: bMix[s.code] || 0,
        after: aMix[s.code] || 0,
      });
    }
  }

  const baseGlobal = baseline.globalErrors || 0;
  if (current.globalErrors > baseGlobal) {
    added.push({
      file: "<global>",
      code: "<global>",
      before: baseGlobal,
      after: current.globalErrors,
      newFile: false,
    });
  }

  return { added, removed, reclassified };
}

/** 从基线 groups 或当前 byGroup 还原某文件的「错误码 -> 条数」 */
function codeMixOf(snapshotOrBaseline, file) {
  const mix = {};
  const byGroup = snapshotOrBaseline.byGroup || snapshotOrBaseline.groups || {};
  const prefix = file + "\u0000";
  for (const [key, count] of Object.entries(byGroup)) {
    if (!key.startsWith(prefix)) continue;
    const code = key.slice(prefix.length);
    mix[code] = (mix[code] || 0) + count;
  }
  return sortObject(mix);
}
