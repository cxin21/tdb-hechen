#!/bin/bash
cd "$(dirname "$0")/.." || exit 1
export TDAI_DATA_DIR=C:/Users/Administrator/AppData/Local/Temp/tdagemem-bench/longmemeval-oracle-mvtavhl6
L=.eval-data/bench
for f in lme90-r146-r146v2-deep lme90-r146-r146v2-deep-factrows-v4 lme90-r146-r146c-base; do
  echo "[rj] $f $(date +%H:%M:%S)"
  node --import tsx scripts/bench-rejudge.mjs "$L/$f.json" --out "$L/$f-rj.json" 2>&1 | tail -4
done
echo "[rj] DONE"
