#!/usr/bin/env bash
# #137（W1/C 事实键平行通道）配对档：原文键主索引 l1_vec 不动 + 事实短语键另写 l1_fact_vec，
# 召回侧按沙箱 yaml 的 recall.factChannel 融合（权重缺省 0.6）。
#  - control = b1off 基线库复制 + --fact-extract（只读事实缓存，不写通道）→ 配对控制组
#  - fc      = control + --fact-channel（分阶段写入：只对有事实的 turn 补写通道向量，零重灌）
#  - fc-norm = fc + --fusion normalized（dense 0.5 / bm25 0.2 / fact 0.3；#137 读侧融合新模式）
# 配对前提：同 manifest / 同 judge / 同 --gen-limit "$GEN"；每档从 BASE 复制库 → --store 复用零重灌。
# 事实抽取走 .eval-data/bench/facts-cache（--fact-model 必须与缓存同模型，否则重抽 = 全量 LLM 账单）。
#  fc-ro   = 在 fc 已灌好的库上**只重跑读侧**（--fact-channel-read-only，零 embedding 外呼）——
#            迭代融合权重/模式用；读侧代码有修复时要靠它把旧写库重新量一遍。
#
# 口径（issue #159 固化，方法论见 docs/optimization-results.md §15.7）：
#  - control/fc 的变量是 factChannel 自己，其余未声明机制显式关：--small-to-big-off /
#    --conclusion-layer-off / --validity-mode hard / fusion rrf / candidateK 32（本票 era）。
#  - 每档 --expect-config 断言 factChannel 与其余轴；--report-name = tag 且报告必须落盘。
#  - 路径：BASE 取 BASE_STORE，库根取 STORE_ROOT，缺省都是 STORE_ROOT 下的 tdagemem-bench 布局。
# 用法: bash scripts/run-r137-factchannel.sh {control|fc|fc-ro|fc-norm|all|one <extra-args...>}
# 先解析脚本绝对目录再 cd：all 模式要递归调用自身，相对 $0 会在 cd 后失效。
set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/lib/bench/arms.sh"
cd "$SCRIPT_DIR/.." || exit 1   # MemoryCore/
arms_init
# 检索-only 验证用：GEN_LIMIT=0 只比召回覆盖率，零生成/判分外呼（同 run-139-w3split.sh 口径）。
GEN="${GEN_LIMIT:-90}"

BASE="${BASE_STORE:-$ARMS_ROOT/lme90-mm-b1off}"
[ -d "$BASE" ] || { echo "[r137] 缺少基线库 $BASE（先跑 run-mm-baselines.sh b1off-mm 或指定 BASE_STORE）"; exit 1; }
# 库根缺省 = BASE 的父目录（别再拿 TEMP 猜——Windows 的 TEMP 与 /tmp 不是一个地方，
# 曾导致 fc-ro 找不到刚写好的库）
ROOT="${STORE_ROOT:-$(dirname "$BASE")}"

COMMON=(--dataset longmemeval --manifest "$L/lme-manifest.json" --keep --pace 150 --gen-limit "$GEN" --recall-ks 1,3,5,10 --rerank-off --b1 --candidate-k 32 --fact-model MiniMax-M2.7 --embed-interval-ms 1200 "${ARMS_OFF_ERA[@]}")
FC=(--fact-channel --fact-channel-weight 0.6 --fact-max-facts 5)
FCNORM='{"mode":"normalized","dense":0.5,"bm25":0.2,"fact":0.3}'
EXPECT_OFF="recall.candidateK=32,recall.fusion.mode=rrf,recall.rerank.enabled=false"
EXPECT_OFF="$EXPECT_OFF,$ARMS_EXPECT_OFF"

case "${1:-help}" in
  control)
    arms_fresh "$BASE" "$ROOT/lme90-r137-control"
    arms_run r137-control "${COMMON[@]}" --store "$ROOT/lme90-r137-control" --fusion "$ARMS_FUSION_RRF" \
      --expect-config "$EXPECT_OFF,recall.factChannel.enabled=false" ;;
  fc)
    arms_fresh "$BASE" "$ROOT/lme90-r137-fc"
    arms_run r137-fc "${COMMON[@]}" --store "$ROOT/lme90-r137-fc" "${FC[@]}" --fusion "$ARMS_FUSION_RRF" \
      --expect-config "$EXPECT_OFF,recall.factChannel.enabled=true,recall.factChannel.weight=0.6" ;;
  # fc-ro：复用 fc 写好的库，只重跑读侧（读侧代码改动后重测的正确姿势，零外呼）
  fc-ro)
    [ -d "$ROOT/lme90-r137-fc" ] || { echo "[r137] 缺 $ROOT/lme90-r137-fc（先跑 fc 档）"; exit 1; }
    arms_run r137-fc-ro "${COMMON[@]}" --store "$ROOT/lme90-r137-fc" "${FC[@]}" --fact-channel-read-only --fusion "$ARMS_FUSION_RRF" \
      --expect-config "$EXPECT_OFF,recall.factChannel.enabled=true,recall.factChannel.weight=0.6" ;;
  # fc-norm 与 fc 同写侧（都从 BASE 复制 + 分阶段写通道向量），只差读侧融合模式；
  # 通道表写入幂等，三档彼此独立、无运行顺序依赖。
  fc-norm)
    arms_fresh "$BASE" "$ROOT/lme90-r137-fc-norm"
    arms_run r137-fc-norm "${COMMON[@]}" --store "$ROOT/lme90-r137-fc-norm" "${FC[@]}" --fusion "$FCNORM" \
      --expect-config "$EXPECT_OFF,recall.factChannel.enabled=true,recall.factChannel.weight=0.6,recall.fusion.mode=normalized" ;;
  all)
    for m in control fc fc-ro fc-norm; do
      bash "$SCRIPT_DIR/$(basename "$0")" "$m" || arms_fail "子档 $m 失败"
    done
    ;;
  one)
    shift
    arms_fresh "$BASE" "$ROOT/lme90-r137-one"
    arms_run r137-one "${COMMON[@]}" --store "$ROOT/lme90-r137-one" --fusion "$ARMS_FUSION_RRF" --expect-config "$EXPECT_OFF,recall.factChannel.enabled=false" "$@"
    ;;
  *)
    echo "用法: $0 {control|fc|fc-ro|fc-norm|all|one <extra-args...>}"
    exit 2
    ;;
esac
arms_finish
echo "[r137] 配对比较: node scripts/bench-compare.mjs <control.json> <fc.json>"
