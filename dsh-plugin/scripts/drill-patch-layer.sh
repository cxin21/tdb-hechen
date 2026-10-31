#!/usr/bin/env bash
# Drill: prove the patch-layer half of a deploy/rollback round trip, without
# installing anything and without touching the profile you actually run.
#
# deploy.sh has two halves — pnpm install, and "one managed block in the
# profile's cordis.patch.yml". Only the second half is exercised here, because
# that is the half that silently breaks: a duplicated block, a block with a
# stale config, or a rollback that eats a hand edit.
#
# What it asserts:
#   1. upsert writes exactly one plugin entry and dsh resolves it (dump-config);
#   2. a second upsert with different config REPLACES the entry (upgrade
#      semantics: still one entry, new value) rather than appending a second;
#   3. strip removes the block, keeps every other entry, and leaves the file
#      resolvable.
#
# Usage:  bash scripts/drill-patch-layer.sh [profile]     (default: desktop)
# The throwaway profile is ~/.dsh/profiles/<profile>-drill and is removed at the
# end (kept on failure so you can inspect it).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_PROFILE="${1:-${DSH_PROFILE:-desktop}}"
DSH_BIN="${DSH_BIN:-D:/DSH/resources/runtime/cli/bin/dsh.cmd}"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
SRC_DIR="$DSH_HOME_DIR/profiles/$SRC_PROFILE"
DRILL="${SRC_PROFILE}-drill"
DRILL_DIR="$DSH_HOME_DIR/profiles/$DRILL"
PATCH="$DRILL_DIR/cordis.patch.yml"
TMP="$(mktemp -d)"

cleanup() {
  local code=$?
  rm -rf "$TMP"
  if [ "$code" -eq 0 ]; then rm -rf "$DRILL_DIR"; else
    echo "drill failed — left $DRILL_DIR for inspection" >&2
  fi
  exit "$code"
}
trap cleanup EXIT

[ -d "$SRC_DIR" ] || { echo "source profile not found: $SRC_DIR" >&2; exit 1; }
[ -f "$SRC_DIR/cordis.patch.yml" ] || { echo "source profile has no patch file: $SRC_DIR" >&2; exit 1; }
command -v node >/dev/null || { echo "node is required" >&2; exit 1; }

echo "== preparing $DRILL_DIR from $SRC_DIR"
rm -rf "$DRILL_DIR"
mkdir -p "$DRILL_DIR"
cp "$SRC_DIR/package.json" "$DRILL_DIR/package.json"
cp "$SRC_DIR/cordis.patch.yml" "$PATCH"
BASE_IDS="$(grep -c '^- id:' "$PATCH" || true)"
echo "   baseline entries: $BASE_IDS"

entry() {
  cat <<YAML
- insert:
    - id: tdb-agemem-dsh
      name: ./node_modules/@tdb/agemem-dsh/dist/index.js
      config:
        server:
          baseUrl: "http://127.0.0.1:8420"
          serviceId: "default"
          teamId: "team-drill"
          agentId: "agt-drill"
          userId: "usr-drill"
        volatile:
          maxChars: $1
YAML
}

echo "== 1/3 first upsert"
entry 800 > "$TMP/e1.yml"
node "$REPO_ROOT/scripts/patch-util.mjs" upsert "$PATCH" "$TMP/e1.yml"
n="$(grep -c 'id: tdb-agemem-dsh' "$PATCH")"
[ "$n" = "1" ] || { echo "expected exactly 1 plugin entry, found $n" >&2; exit 1; }
"$DSH_BIN" --profile "$DRILL" --dump-config > "$TMP/dump1.yml" 2> "$TMP/dump1.err" || {
  echo "dump-config failed on the first upsert (see $TMP/dump1.err)" >&2; exit 1; }
grep -q 'id: tdb-agemem-dsh' "$TMP/dump1.yml" || { echo "dump-config does not contain the plugin" >&2; exit 1; }
grep -q 'maxChars: 800' "$TMP/dump1.yml" || { echo "dump-config lost volatile.maxChars" >&2; exit 1; }
echo "   resolved: 1 entry, volatile.maxChars=800 visible in dump-config"

echo "== 2/3 second upsert (upgrade, different config)"
entry 9999 > "$TMP/e2.yml"
node "$REPO_ROOT/scripts/patch-util.mjs" upsert "$PATCH" "$TMP/e2.yml"
n="$(grep -c 'id: tdb-agemem-dsh' "$PATCH")"
[ "$n" = "1" ] || { echo "upgrade appended a second entry ($n found)" >&2; exit 1; }
grep -q 'maxChars: 9999' "$PATCH" || { echo "upgrade did not replace the config" >&2; exit 1; }
grep -q 'maxChars: 800' "$PATCH" && { echo "stale config value survived the upgrade" >&2; exit 1; }
"$DSH_BIN" --profile "$DRILL" --dump-config > "$TMP/dump2.yml" 2> "$TMP/dump2.err" || {
  echo "dump-config failed after the upgrade (see $TMP/dump2.err)" >&2; exit 1; }
grep -q 'maxChars: 9999' "$TMP/dump2.yml" || { echo "upgraded config not resolved" >&2; exit 1; }
echo "   upgrade replaced the entry in place"

echo "== 3/3 strip"
node "$REPO_ROOT/scripts/patch-util.mjs" strip "$PATCH"
grep -q 'tdb-agemem-dsh' "$PATCH" && { echo "strip left plugin references behind" >&2; exit 1; }
after="$(grep -c '^- id:' "$PATCH" || true)"
[ "$after" = "$BASE_IDS" ] || { echo "strip changed other entries: $BASE_IDS -> $after" >&2; exit 1; }
"$DSH_BIN" --profile "$DRILL" --dump-config > "$TMP/dump3.yml" 2> "$TMP/dump3.err" || {
  echo "dump-config failed after strip (see $TMP/dump3.err)" >&2; exit 1; }
grep -q 'tdb-agemem-dsh' "$TMP/dump3.yml" && { echo "composition still references the plugin" >&2; exit 1; }
echo "   stripped; $after other entries intact; composition clean"

echo
echo "DRILL PASSED (source profile: $SRC_PROFILE)"
