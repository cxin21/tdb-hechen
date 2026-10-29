#!/bin/bash
# #135 R4/精排修复：rerank 保持开启，只修「剪枝过度 + 深池」两个使用问题。
# 前提结论（b0base-mm 复盘）：kept=1 的 27 题（30%）关掉 rerank 可 +35.2pp；kept>=4 的 38 题 rerank 是 -1.3pp（中性）
# -> 问题不在 rerank 本身，而在 minScore=-2/candidates=12 把证据剪到 1-2 行。
# 基线 = b0base（rerank 开）复制库，全开 R1/R2/R3 之后叠加精排修复档。
# 用法: bash scripts/run-r135-rerankfix-arms.sh [all|deep105|filter7|filter7deep|deep4|one <extra>]
cd "$(dirname "$0")/.." || exit 1
B="node --import tsx scripts/eval-memory-bench.mjs"
L=.eval-data/bench
TMPROOT="${TMPDIR:-/tmp}/tdagemem-bench"
BASE="/c/Users/Administrator/AppData/Local/Temp/tdagemem-bench/lme90-mm-b0base"
COMMON="--dataset longmemeval --manifest $L/lme-manifest.json --keep --pace 150 --gen-limit 90 --recall-ks 1,3,5,10 --b1 --candidate-k 32 --present-temporal"
FDEF='{"mode":"weighted","dense":0.4,"bm25":0.3,"recency":0.2,"validity":0.1,"recencyHalfLifeDays":30}'
FAILED=0
run() { local tag="$1"; shift; echo "[fix] start $tag $(date +%H:%M:%S)"; $B "$@" --tag "$tag" || { echo "[fix] FAILED $tag"; FAILED=$((FAILED+1)); }; echo "[fix] done $tag $(date +%H:%M:%S)"; }
fresh() { rm -rf "$2"; cp -r "$1" "$2"; echo "[fix] 复制库 $1 → $2"; }
deep105() { fresh "$BASE" "$TMPROOT/lme90-fix-deep105"; run rfix-deep105 $COMMON --store "$TMPROOT/lme90-fix-deep105" --fusion "$FDEF" --rerank-candidates 32 --rerank-minscore -10.5; }
deep4()   { fresh "$BASE" "$TMPROOT/lme90-fix-deep4";   run rfix-deep4   $COMMON --store "$TMPROOT/lme90-fix-deep4"   --fusion "$FDEF" --rerank-candidates 32 --rerank-minscore -4; }
filter7() { fresh "$BASE" "$TMPROOT/lme90-fix-filter7"; run rfix-filter7 $COMMON --store "$TMPROOT/lme90-fix-filter7" --fusion "$FDEF" --rerank-filter-only -7; }
# src 侧 R4（rerank.mode=filter）真实生效档：深池 32 + floor -7 + 保原序。
# 注意：旧的 filter7 只走 bench host 侧 --rerank-filter-only，需 --rerank-child-proc 才生效；本档直接测 src 配置。
filter7deep() { fresh "$BASE" "$TMPROOT/lme90-fix-filter7deep"; run rfix-filter7deep $COMMON --store "$TMPROOT/lme90-fix-filter7deep" --fusion "$FDEF" --rerank-candidates 32 --rerank-minscore -7 --rerank-mode filter; }
case "${1:-all}" in
  all) deep105; filter7; deep4 ;;
  filter7deep) filter7deep ;;
  deep105) deep105 ;;
  deep4) deep4 ;;
  filter7) filter7 ;;
  one) shift; fresh "$BASE" "$TMPROOT/lme90-fix-one"; run rfix-one $COMMON --store "$TMPROOT/lme90-fix-one" --fusion "$FDEF" "$@" ;;
  *) echo "用法: $0 [all|deep105|filter7|deep4|one <args>]"; exit 2 ;;
esac
[ "$FAILED" -ne 0 ] && { echo "[fix] 有 $FAILED 处失败"; exit 1; }
echo "[fix] OK"