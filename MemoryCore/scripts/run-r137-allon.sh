#!/usr/bin/env bash
# #137 全开档（2026-10-27）：生产三开关全开 + W2 契约 + W3 结论卡(maxExtraLines=4) + soft 效期 + 深候选池，
# 跑 LME90 生成+判分（judge = 生产 config-override 的 llm，MiniMax-M3.1-Flash）。
#
# 写侧（一次性，约 18min）：事实通道向量 673 条 + W2 失效标记 + W3 结论卡（缓存命中，零 LLM）
# 读侧：recall.factChannel(0.6) + fusion.mode="normalized"(dense .5/bm25 .2/fact .3) + candidateK 32
# 精排：本档两档显式钉住——缺省 12/−2（10-27 era），RERANK_DEEP=1 叠 #145 深池 32/−10.5。
#      （生产 yaml 现在是 candidates 32 / minScore 走 provider 缺省，不钉就会被继承，两档不可比。）
#
# 口径（issue #159 固化，方法论见 docs/optimization-results.md §15.7）：
#  - 这是"全开"档，所以 factChannel / smallToBig / conclusionLayer / validity soft 都显式开并断言；
#    写侧卡必须配读侧 --small-to-big，否则 --conclusion-cards 只是写进库、不注入。
#  - --expect-config 在灌库前比对；--report-name = tag 且报告必须落盘，路径走 STORE_ROOT。
# 用法: bash scripts/run-r137-allon.sh [tag]
#       RERANK_DEEP=1 bash scripts/run-r137-allon.sh r137-allon-deep   # 叠加 #145 深池(32/-10.5)
#       REUSE_STORE=1 ...                                            # 复用已写好的库（只重跑读侧）
set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/lib/bench/arms.sh"
cd "$SCRIPT_DIR/.." || exit 1   # MemoryCore/
arms_init
# 检索-only 验证用：GEN_LIMIT=0 只比召回覆盖率，零生成/判分外呼（同 run-139-w3split.sh 口径）。
GEN="${GEN_LIMIT:-90}"

TAG="${1:-r137-allon}"
BASE="${BASE_STORE:-$ARMS_ROOT/lme90-mm-b1off}"
STORE="$ARMS_ROOT/lme90-r137-allon"
[ -d "$BASE" ] || { echo "[allon] 缺少基线库 $BASE（先跑 run-r135-off-arms.sh allon 或指定 BASE_STORE）"; exit 1; }
if [ "${REUSE_STORE:-0}" != "1" ]; then
  arms_fresh "$BASE" "$STORE"
fi

EXPECT="recall.factChannel.enabled=true,recall.factChannel.weight=0.6"
EXPECT="$EXPECT,recall.smallToBig.enabled=true,recall.smallToBig.maxExtraLines=4"
EXPECT="$EXPECT,recall.conclusionLayer.enabled=true,recall.validity.mode=soft"
EXPECT="$EXPECT,recall.candidateK=32,recall.fusion.mode=normalized,recall.rerank.enabled=true"
RERANK_ARGS=(--rerank-candidates 12 --rerank-minscore -2)
EXPECT_RERANK="recall.rerank.candidates=12,recall.rerank.minScore=-2"
if [ "${RERANK_DEEP:-0}" = "1" ]; then
  RERANK_ARGS=(--rerank-candidates 32 --rerank-minscore -10.5)
  EXPECT_RERANK="recall.rerank.candidates=32,recall.rerank.minScore=-10.5"
fi

arms_run "$TAG" \
  --dataset longmemeval --manifest "$L/lme-manifest.json" --keep --pace 150 --gen-limit "$GEN" \
  --recall-ks 1,3,5,10 --b1 --candidate-k 32 \
  --fact-extract --fact-channel --fact-channel-weight 0.6 --fact-max-facts 5 \
  --write-supersede --conclusion-cards --small-to-big --conclusion-max-extra 4 --validity-mode soft \
  --fusion '{"mode":"normalized","dense":0.5,"bm25":0.2,"fact":0.3}' \
  --fact-model MiniMax-M2.7 --embed-interval-ms 1200 \
  --store "$STORE" "${RERANK_ARGS[@]}" --expect-config "$EXPECT,$EXPECT_RERANK"
arms_finish
