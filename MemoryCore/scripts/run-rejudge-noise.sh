#!/bin/bash
# 重判噪声检查（#159 跟票）：对既有报告按当前判分器重判，看判对率抖动。
# 只跑 bench-rejudge（不碰 runner 旗标，故无 --expect-config/--report-name 可言）。
# 数据目录（实为凭据 override 目录，bench 凭据链读它）不硬编码：
# TDAI_DATA_DIR / STORE_ROOT / TMPDIR 任一可覆盖。
cd "$(dirname "$0")/.." || exit 1
# 管道退出码默认取最后一段（tail）——不开 pipefail 时工具失败会被吞成 DONE。
set -o pipefail
S="${STORE_ROOT:-${TMPDIR:-/tmp}/tdagemem-bench}"
export TDAI_DATA_DIR="${TDAI_DATA_DIR:-$S/longmemeval-oracle-mvtavhl6}"
# 缺库别静默回落到 yaml 的 data.baseDir（会换 provider 却不报错）。
[ -d "$TDAI_DATA_DIR" ] || { echo "[rj] 沙箱库不存在: $TDAI_DATA_DIR（先跑一次 r146 建库，或设 TDAI_DATA_DIR）"; exit 2; }
L=.eval-data/bench
FAILED=0
for f in lme90-r146-r146v2-deep lme90-r146-r146v2-deep-factrows-v4 lme90-r146-r146c-base; do
  echo "[rj] $f $(date +%H:%M:%S)"
  rm -f "$L/$f-rj.json"   # 先删旧报告：否则本档失败时 -f 断言会被上一轮文件满足
  node --import tsx scripts/bench-rejudge.mjs "$L/$f.json" --out "$L/$f-rj.json" 2>&1 | tail -4 \
    || { echo "[rj] FAILED: $f（重判非 0）"; FAILED=$((FAILED+1)); }
  [ -f "$L/$f-rj.json" ] || { echo "[rj] FAILED: $f 未产出重判报告"; FAILED=$((FAILED+1)); }
done
[ "$FAILED" -ne 0 ] && { echo "[rj] 有 $FAILED 处失败"; exit 1; }
echo "[rj] DONE"
