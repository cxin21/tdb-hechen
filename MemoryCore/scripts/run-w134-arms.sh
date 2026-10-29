#!/bin/bash
# issue #134（写入治本）逐项独立档：**每档从 b1-off 基线库（$BASE）复制 + 只补写本档差异**。
#  - w1  = BASE + W1 事实键双写
#  - w2  = BASE + W2 写时 supersede（+validityNow=题目日期）
#  - w3  = BASE + W3 结论卡 + part_of 回捞
#  - w13 = W1 库复制 + W3（叠加档）
#  - combo = W1 库复制 + W2 + W3（全开）
# 门禁链：先跑抽样验收门禁（fact-extract-gate），再跑档，最后 bench-gates 判定。
cd "$(dirname "$0")/.." || exit 1
B="node --import tsx scripts/eval-memory-bench.mjs"
G="node --import tsx scripts/fact-extract-gate.mjs"
L=.eval-data/bench
# 可移植（#139 第7项）：不再硬编码 git-bash 路径；BASE 缺省指向本机实际存在的 b1-off 基线库。
TMP="${TMPDIR:-/tmp}"
STORE_ROOT="${STORE_ROOT:-$TMP/tdagemem-bench}"
# 旧名 longmemeval-oracle-mvphl2m1 已不在本机（/tmp 清理过），缺省改用 lme90-mm-b1off；
# 换机器/换数据集用 BASE_STORE 显式覆盖。
BASE="${BASE_STORE:-$STORE_ROOT/lme90-mm-b1off}"
W1STORE="$STORE_ROOT/lme90-w134-w1"
COMMON="--dataset longmemeval --manifest $L/lme-manifest.json --pace 150 --gen-limit 90 --recall-ks 1,3,5,10 --rerank-off --b1 --fact-model MiniMax-M2.7 --embed-interval-ms 1200"
FAILED=0
# #139 第7项：基线库缺失立刻非 0 退出（旧版会在 6 档里各自失败后才暴露）
if [ ! -d "$BASE" ]; then
  echo "[w134] 缺少基线库 $BASE（用 BASE_STORE=<path> 指定，或先跑一次 b1-off 灌库）"
  exit 1
fi
run() {
  local tag="$1"; shift
  echo "[w134] start $tag $(date +%H:%M:%S)"
  # #139 第7项：报告名钉死为 tag；没产出报告也算失败（旧版只看退出码，静默空档会过关）。
  $B "$@" --tag "$tag" --report-name "$tag" || { echo "[w134] FAILED: $tag"; FAILED=$((FAILED+1)); return 1; }
  [ -f "$L/$tag.json" ] || { echo "[w134] FAILED: $tag 未产出报告 $L/$tag.json"; FAILED=$((FAILED+1)); return 1; }
  echo "[w134] done $tag $(date +%H:%M:%S)"
}
fresh_from() {  # fresh_from <src> <dst>
  rm -rf "$2"
  cp -r "$1" "$2"
  echo "[w134] 复制库 $1 → $2"
}
gate_facts() {
  [ -f "$L/fact-gate.json" ] && return 0
  echo "[w134] 抽取抽样验收门禁..."
  $G --dataset longmemeval --manifest $L/lme-manifest.json --cache $L/facts-cache \
     --sample 40 --threshold 0.9 --concurrency 6 --out $L > $L/run-fact-gate.log 2>&1 || { echo "[w134] 抽样门禁 FAIL"; FAILED=$((FAILED+1)); }
  cp -f "$(ls -t $L/fact-gate-*.json 2>/dev/null | head -1)" "$L/fact-gate.json" 2>/dev/null || true
}
case "${1:-help}" in
  w1) gate_facts; fresh_from "$BASE" "$W1STORE"; run w1 $COMMON --keep --store "$W1STORE" --fact-dual-write ;;
  w2) gate_facts; fresh_from "$BASE" "$STORE_ROOT/lme90-w134-w2"; run w2 $COMMON --keep --store "$STORE_ROOT/lme90-w134-w2" --write-supersede --b2b-validity ;;
  # #139 第5项：W3 拆成 写入面 与 读侧回捞 两个独立开关——
  #   w3  = 只写入（结论卡落库 + part_of 链，读侧不改）
  #   w3b = 写入 + smallToBig 回捞 4 行（历史 w3b 档的真实语义）
  # 纯写档必须显式 --small-to-big-off：沙箱 yaml 以生产 yaml 为底（tdai-gateway.yaml
  # smallToBig.enabled=true），只写 --expect-config 断言会让生效值恒为 true → exit 2。
  w3) gate_facts; fresh_from "$BASE" "$STORE_ROOT/lme90-w134-w3"; run w3 $COMMON --keep --store "$STORE_ROOT/lme90-w134-w3" --conclusion-cards --small-to-big-off --expect-config "recall.smallToBig.enabled=false" ;;
  w3b) gate_facts; fresh_from "$BASE" "$STORE_ROOT/lme90-w134-w3b"; run w3b $COMMON --keep --store "$STORE_ROOT/lme90-w134-w3b" --conclusion-cards --small-to-big --small-to-big-max-extra 4 --expect-config "recall.smallToBig.enabled=true,recall.smallToBig.maxExtraLines=4" ;;
  # allon：三件全开（W1 键已在 w1 库中 + W2 失效标记 + W3 结论卡，回捞 4 行）
  allon) gate_facts; fresh_from "$W1STORE" "$STORE_ROOT/lme90-w134-allon"; run allon $COMMON --keep --store "$STORE_ROOT/lme90-w134-allon" --write-supersede --b2b-validity --conclusion-cards --small-to-big --small-to-big-max-extra 4 --expect-config "recall.smallToBig.enabled=true" ;;
  w13) gate_facts; fresh_from "$W1STORE" "$STORE_ROOT/lme90-w134-w13"; run w13 $COMMON --keep --store "$STORE_ROOT/lme90-w134-w13" --conclusion-cards --small-to-big --expect-config "recall.smallToBig.enabled=true" ;;
  combo) gate_facts; fresh_from "$W1STORE" "$STORE_ROOT/lme90-w134-combo"; run w-combo $COMMON --keep --store "$STORE_ROOT/lme90-w134-combo" --write-supersede --b2b-validity --conclusion-cards --small-to-big --expect-config "recall.smallToBig.enabled=true" ;;
  # 子档同样把失败传出去（旧版 all 里子脚本失败被吞，脚本仍打 OK）
  all) for m in w1 w2 w3 w3b w13 combo; do bash "$0" $m || FAILED=$((FAILED+1)); done ;;
  *) echo "用法: $0 {w1|w2|w3|w3b|w13|combo|all}"; exit 2 ;;
esac
if [ "$FAILED" -ne 0 ]; then echo "[w134] 有 $FAILED 处失败"; exit 1; fi
echo "[w134] OK"
