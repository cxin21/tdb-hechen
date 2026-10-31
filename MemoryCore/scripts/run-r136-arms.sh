#!/usr/bin/env bash
# issue #136（双时态属性契约 + 软失效）配对档：**每档从 b1-off 基线库（$BASE）复制 + 只补写本档差异**。
#  - card-soft = BASE + W2 supersede（cardinality 门 ON）+ 读侧软失效（recall.validity.mode=soft）
#  - card-hard = BASE + W2 supersede（cardinality 门 ON）+ 读侧硬失效（逐位现状，隔离"软失效"贡献）
#  - nogate-soft = BASE + W2 supersede（门 OFF，= #136 前"谓词一变就失效"）+ 软失效（隔离 cardinality 贡献）
#  - allon / newb = 上面 + 结论卡写侧（--conclusion-cards）+ 读侧回捞（--small-to-big maxExtra 4）
# 配对基线 = b1off-mm（同 manifest/同 judge）。
#
# 口径（issue #159 固化，方法论见 docs/optimization-results.md §15.7）：
#  - era 口径 candidateK 15 + rrf；factChannel 显式关；validity 逐档显式写（soft/hard 是本档变量）。
#  - 卡档必须把读侧 --small-to-big 显式打开：--conclusion-cards 只开写侧，不开读侧等于卡不注入。
#  - 每档 --expect-config 断言（含 conclusionLayer / smallToBig），--report-name = tag 且报告必须落盘。
#  - 路径走 STORE_ROOT，不写个人家目录。
set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/lib/bench/arms.sh"
cd "$SCRIPT_DIR/.." || exit 1   # MemoryCore/
arms_init
# 检索-only 验证用：GEN_LIMIT=0 只比召回覆盖率，零生成/判分外呼（同 run-139-w3split.sh 口径）。
GEN="${GEN_LIMIT:-90}"

BASE="${BASE_STORE:-$ARMS_ROOT/lme90-mm-b1off}"
[ -d "$BASE" ] || { echo "[r136] 缺少基线库 $BASE（先跑 run-mm-baselines.sh b1off-mm 或指定 BASE_STORE）"; exit 1; }

BASE_ARGS=(--dataset longmemeval --manifest "$L/lme-manifest.json" --keep --pace 150 --gen-limit "$GEN" --recall-ks 1,3,5,10 --rerank-off --b1 --fact-model MiniMax-M2.7 --embed-interval-ms 1200 --candidate-k 15 --fusion '{"mode":"rrf"}' --fact-channel-off)
EXPECT_COMMON="recall.candidateK=15,recall.fusion.mode=rrf,recall.rerank.enabled=false,recall.factChannel.enabled=false"
# 无卡档：结论层与读侧回捞都关（机制不在本档变量里）
PLAIN_OFF=(--small-to-big-off --conclusion-layer-off)
EXPECT_PLAIN="$EXPECT_COMMON,recall.smallToBig.enabled=false,recall.conclusionLayer.enabled=false"
# 卡档：写侧卡 + 读侧回捞（maxExtra 4，需要 conclusionLayer 注入）
CARD_ON=(--small-to-big --conclusion-max-extra 4 --conclusion-cards)
EXPECT_CARD="$EXPECT_COMMON,recall.smallToBig.enabled=true,recall.smallToBig.maxExtraLines=4,recall.conclusionLayer.enabled=true"

case "${1:-help}" in
  card-soft)
    arms_fresh "$BASE" "$ARMS_ROOT/lme90-r136-card-soft"
    arms_run r136-card-soft "${BASE_ARGS[@]}" "${PLAIN_OFF[@]}" --store "$ARMS_ROOT/lme90-r136-card-soft" --write-supersede --b2b-validity --validity-mode soft \
      --expect-config "$EXPECT_PLAIN,recall.validity.mode=soft" ;;
  card-soft-final)
    arms_fresh "$BASE" "$ARMS_ROOT/lme90-r136-card-soft"
    arms_run r136-cardsoft3 "${BASE_ARGS[@]}" "${PLAIN_OFF[@]}" --store "$ARMS_ROOT/lme90-r136-card-soft" --write-supersede --b2b-validity --validity-mode soft \
      --expect-config "$EXPECT_PLAIN,recall.validity.mode=soft" ;;
  allon)
    arms_fresh "$ARMS_ROOT/lme90-w134-w1" "$ARMS_ROOT/lme90-r136-allon"
    arms_run r136-allon "${BASE_ARGS[@]}" "${CARD_ON[@]}" --store "$ARMS_ROOT/lme90-r136-allon" --write-supersede --b2b-validity --validity-mode soft \
      --expect-config "$EXPECT_CARD,recall.validity.mode=soft" ;;
  newb)
    arms_fresh "$BASE" "$ARMS_ROOT/lme90-r136-newb"
    arms_run r136-newb "${BASE_ARGS[@]}" "${CARD_ON[@]}" --store "$ARMS_ROOT/lme90-r136-newb" --write-supersede --b2b-validity --validity-mode soft \
      --expect-config "$EXPECT_CARD,recall.validity.mode=soft" ;;
  card-hard)
    arms_fresh "$BASE" "$ARMS_ROOT/lme90-r136-card-hard"
    arms_run r136-card-hard "${BASE_ARGS[@]}" "${PLAIN_OFF[@]}" --store "$ARMS_ROOT/lme90-r136-card-hard" --write-supersede --b2b-validity --validity-mode hard \
      --expect-config "$EXPECT_PLAIN,recall.validity.mode=hard" ;;
  nogate-soft)
    arms_fresh "$BASE" "$ARMS_ROOT/lme90-r136-nogate-soft"
    arms_run r136-nogatesoft "${BASE_ARGS[@]}" "${PLAIN_OFF[@]}" --store "$ARMS_ROOT/lme90-r136-nogate-soft" --write-supersede --b2b-validity --validity-mode soft --supersede-cardinality off \
      --expect-config "$EXPECT_PLAIN,recall.validity.mode=soft" ;;
  # 子档在独立进程里各自 arms_finish；父进程必须收子进程退出码，否则批量跑照样假绿（#159）。
  all) for m in card-soft card-hard nogate-soft; do
         bash "$SCRIPT_DIR/$(basename "$0")" "$m" || arms_fail "子档 $m 失败"
       done ;;
  *) echo "用法: $0 {card-soft|card-soft-final|card-hard|nogate-soft|allon|all}"; exit 2 ;;
esac
arms_finish
