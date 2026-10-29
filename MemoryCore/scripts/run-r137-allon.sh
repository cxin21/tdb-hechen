#!/bin/bash
# #137 全开档（2026-10-27）：生产三开关全开 + W2 契约 + W3 结论卡(maxExtraLines=4) + soft 效期 + 深候选池，
# 跑 LME90 生成+判分（judge = 生产 config-override 的 llm，MiniMax-M3.1-Flash）。
#
# 写侧（一次性，约 18min）：事实通道向量 673 条 + W2 失效标记 + W3 结论卡（缓存命中，零 LLM）
# 读侧：recall.factChannel(0.6) + fusion.mode="normalized"(dense .5/bm25 .2/fact .3) + candidateK 32
# 精排：生产现值（enabled=true / candidates=12 / minScore=-2）——本档不做 #145 的深池修复。
#
# 用法: bash scripts/run-r137-allon.sh [tag]
#       RERANK_DEEP=1 bash scripts/run-r137-allon.sh r137-allon-deep   # 叠加 #145 深池(32/-10.5)
#       REUSE_STORE=1 ...                                            # 复用已写好的库（只重跑读侧）
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.." || exit 1
TAG="${1:-r137-allon}"
S="${STORE_ROOT:-/c/Users/Administrator/AppData/Local/Temp/tdagemem-bench}"
BASE="${BASE_STORE:-$S/lme90-mm-b1off}"
STORE="$S/lme90-r137-allon"
L=.eval-data/bench
[ -d "$BASE" ] || { echo "[allon] 缺少基线库 $BASE（先跑 run-r135-off-arms.sh allon 或指定 BASE_STORE）"; exit 1; }
if [ "${REUSE_STORE:-0}" != "1" ]; then
  rm -rf "$STORE"; cp -r "$BASE" "$STORE"; echo "[allon] 复制库 $BASE → $STORE"
fi
RERANK_ARGS=()
[ "${RERANK_DEEP:-0}" = "1" ] && RERANK_ARGS=(--rerank-candidates 32 --rerank-minscore -10.5)
node --import tsx scripts/eval-memory-bench.mjs \
  --dataset longmemeval --manifest "$L/lme-manifest.json" --keep --pace 150 --gen-limit 90 \
  --recall-ks 1,3,5,10 --b1 --candidate-k 32 \
  --fact-extract --fact-channel --fact-channel-weight 0.6 --fact-max-facts 5 \
  --write-supersede --conclusion-cards --conclusion-max-extra 4 --validity-mode soft \
  --fusion '{"mode":"normalized","dense":0.5,"bm25":0.2,"fact":0.3}' \
  --fact-model MiniMax-M2.7 --embed-interval-ms 1200 \
  --store "$STORE" --tag "$TAG" "${RERANK_ARGS[@]}"
