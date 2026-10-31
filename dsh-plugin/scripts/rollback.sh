#!/usr/bin/env bash
# Roll @tdb/agemem-dsh back out of a dsh profile.
#
# Order matters and is the reverse of deploy.sh:
#   1. uninstall the package while package.json still lists it (pnpm needs the
#      dependency to exist — the old script restored package.json first, which
#      made `plugin remove` a silent no-op and left the tarball installed);
#   2. restore the package.json / pnpm-lock.yaml snapshots taken by deploy.sh;
#   3. drop the plugin's managed block from cordis.patch.yml *in place* (patch-
#      util knows where our block starts and ends, so edits made after the
#      deploy survive — the old script copied the whole pre-deploy file back and
#      silently threw them away);
#   4. delete only this package's directories, never the whole @tdb scope
#      (a sibling package in .pnpm/@tdb would have been collateral damage);
#   5. re-resolve the composition and assert the plugin id is gone.
#
# The running host is not restarted; it keeps whatever it mounted until you
# restart it.
#
# Usage:
#   bash scripts/rollback.sh             # restore the last deploy
#   bash scripts/rollback.sh <stamp>     # restore a specific deploy stamp
#   bash scripts/rollback.sh --dry-run
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${DSH_PROFILE:-desktop}"
DSH_BIN="${DSH_BIN:-D:/DSH/resources/runtime/cli/bin/dsh.cmd}"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE"
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"
PLUGIN_ID="tdb-agemem-dsh"
PKG_NAME="@tdb/agemem-dsh"
STATE_ROOT="$REPO_ROOT/.deploy"
PATCH_UTIL="$REPO_ROOT/scripts/patch-util.mjs"

DRY_RUN=0
STAMP=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,22p' "${BASH_SOURCE[0]}"; exit 0 ;;
    -*) echo "unknown option: $arg" >&2; exit 2 ;;
    *) STAMP="$arg" ;;
  esac
done

if [ -z "$STAMP" ]; then
  [ -f "$STATE_ROOT/last" ] || { echo "no deploy recorded in $STATE_ROOT/last" >&2; exit 1; }
  STAMP="$(cat "$STATE_ROOT/last")"
fi
STATE_DIR="$STATE_ROOT/$STAMP"
[ -d "$STATE_DIR" ] || { echo "state dir not found: $STATE_DIR" >&2; exit 1; }

say() { printf '== %s\n' "$*"; }
run() {
  if [ "$DRY_RUN" = "1" ]; then
    printf '   [dry-run] %s\n' "$*"
  else
    printf '   $ %s\n' "$*"
    "$@"
  fi
}

say "rollback stamp: $STAMP"
say "profile       : $PROFILE ($PROFILE_DIR)"
if [ ! -d "$PROFILE_DIR" ]; then
  # Nothing to restore, and creating it would hide a typo in DSH_PROFILE.
  echo "profile directory not found: $PROFILE_DIR" >&2
  exit 1
fi

say "1/5 uninstall the package (while package.json still lists it)"
if [ -f "$PROFILE_DIR/package.json" ] && grep -q "$PKG_NAME" "$PROFILE_DIR/package.json"; then
  run "$DSH_BIN" plugin --profile "$PROFILE" remove "$PKG_NAME" \
    || say "pnpm remove failed — continuing; step 4 deletes the directories and step 2 restores package.json"
else
  say "package already absent from package.json"
fi

say "2/5 restore package.json / pnpm-lock.yaml snapshots"
for name in package.json pnpm-lock.yaml; do
  if [ -f "$STATE_DIR/$name.bak" ]; then
    run cp "$STATE_DIR/$name.bak" "$PROFILE_DIR/$name"
  else
    say "no backup for $name — leaving it alone"
  fi
done

say "3/5 drop the managed block from cordis.patch.yml (in place)"
if [ "$DRY_RUN" = "1" ]; then
  printf '   [dry-run] node %s strip %s\n' "$PATCH_UTIL" "$PATCH_FILE"
elif [ -f "$PATCH_FILE" ]; then
  node "$PATCH_UTIL" strip "$PATCH_FILE" || {
    echo "could not remove the managed block; inspect $PATCH_FILE by hand" >&2
    exit 1
  }
else
  say "no patch file at $PATCH_FILE — nothing to strip"
fi

say "4/5 remove this package's directories only"
if [ "$DRY_RUN" = "1" ]; then
  printf '   [dry-run] rm -rf %s/node_modules/%s %s/node_modules/.pnpm/@tdb+agemem-dsh@*\n' \
    "$PROFILE_DIR" "$PKG_NAME" "$PROFILE_DIR"
else
  rm -rf "$PROFILE_DIR/node_modules/$PKG_NAME"
  # Targeted: only our own virtual-store entry. `rm -rf .pnpm/@tdb` used to take
  # any sibling @tdb/* package with it.
  for dir in "$PROFILE_DIR"/node_modules/.pnpm/@tdb+agemem-dsh@*; do
    [ -e "$dir" ] && rm -rf "$dir"
  done
  say "directories removed"
fi

say "5/5 verify the composition no longer references the plugin"
if [ "$DRY_RUN" = "1" ]; then
  printf '   [dry-run] %s --profile %s --dump-config\n' "$DSH_BIN" "$PROFILE"
else
  OUT="$STATE_DIR/dump-config-after-rollback.yml"
  "$DSH_BIN" --profile "$PROFILE" --dump-config > "$OUT" 2> "$STATE_DIR/dump-config-after-rollback.err" || {
    echo "dump-config failed after rollback; inspect $STATE_DIR/dump-config-after-rollback.err" >&2
    exit 1
  }
  if grep -q "$PLUGIN_ID" "$OUT"; then
    echo "$PLUGIN_ID is still referenced in $OUT — check $PATCH_FILE by hand" >&2
    exit 1
  fi
  say "verified: composition no longer contains $PLUGIN_ID ($OUT)"
fi

cat <<DONE

$([ "$DRY_RUN" = "1" ] && echo "DRY RUN — nothing was changed." || echo "Rolled back deploy $STAMP (state: $STATE_DIR)")
Restart the dsh host to unload the plugin from the running process.
DONE
