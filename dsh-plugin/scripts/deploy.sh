#!/usr/bin/env bash
# Deploy @tdb/agemem-dsh into a dsh profile via the official plugin command.
#
# Non-destructive by construction:
#   * everything this script writes outside the repo is a pnpm install into the
#     profile directory plus one insert row in the profile's patch file;
#   * the profile's package.json / pnpm-lock.yaml / cordis.patch.yml are copied
#     into <repo>/dsh-plugin/.deploy/<stamp>/ BEFORE anything changes, and
#     scripts/rollback.sh restores exactly those copies;
#   * nothing here restarts the running GUI host — the plugin only takes effect
#     after you restart it yourself.
#
# Usage:
#   bash scripts/deploy.sh              # build, test, pack, install, verify
#   bash scripts/deploy.sh --dry-run    # print the plan, change nothing
#   bash scripts/deploy.sh --skip-tests # build + install only
#
# The plugin is inert until it knows *which* memory identity to use: the core
# isolates memory by (team_id, agent_id, user_id), and an install must never
# guess or inherit the author's identity. This script therefore writes that
# identity and the core URL into the profile's patch entry (config is replaced
# wholesale by the loader, so it lives here and not in the package). With an
# empty identity the plugin loads, mounts and does nothing — that is the
# intended safe default, not a failure.
#
# THE CORE KEY NEVER GOES INTO THE PATCH. A patch file is copied around, dumped
# by --dump-config and grepped by every troubleshooting session, so the script
# stores the value in the host credentials store (~/.dsh/.credentials.yaml, the
# same seam the host resolves server.apiKeyRef through) and writes only the ref
# NAME into the patch. env[REF] still works as a runtime fallback.
#
# Env overrides:
#   DSH_PROFILE (default desktop)  DSH_BIN (default D:/DSH/resources/runtime/cli/bin/dsh.cmd)
#   DSH_HOME    (default ~/.dsh)  TSC_BIN / VITEST_BIN for the local toolchain
#   TDB_CORE_BASE_URL  (default http://127.0.0.1:8420)
#   TDB_CORE_API_KEY   (default: server.apiKey read from ../MemoryCore/tdai-gateway.yaml,
#                       which only exists on the core's own machine)
#   TDB_API_KEY_REF    (default TDAI_GATEWAY_APIKEY) credentials ref / env var name
#   TDB_TEAM_ID / TDB_AGENT_ID / TDB_USER_ID  memory isolation identity
# Flags: --identity team,agent,user   --base-url URL   --api-key KEY
#        --api-key-ref REF   --inline-key   --no-store-key
#        (both "flag value" and "flag=value" spellings are accepted)
#   --api-key KEY      the core's server key; stored under --api-key-ref
#   --api-key-ref REF  name in the credentials store (default TDAI_GATEWAY_APIKEY)
#   --inline-key       write the value into the patch (legacy, plaintext; warns)
#   --no-store-key     do not touch the credentials store; the ref must already
#                      resolve there or in env[REF], otherwise the run aborts
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The live host runs the `desktop` profile (DSH_PROFILE=desktop, its bundles carry
# dsh-context etc.); `web` is the shipped template. Override for another profile.
PROFILE="${DSH_PROFILE:-desktop}"
DSH_BIN="${DSH_BIN:-D:/DSH/resources/runtime/cli/bin/dsh.cmd}"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE"
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"
PLUGIN_ID="tdb-agemem-dsh"
PKG_NAME="@tdb/agemem-dsh"
ENTRY="./node_modules/$PKG_NAME/dist/index.js"
STAMP="$(date +%Y%m%d-%H%M%S)"
STATE_ROOT="$REPO_ROOT/.deploy"
STATE_DIR="$STATE_ROOT/$STAMP"
ARTIFACTS="$REPO_ROOT/artifacts"
TARBALL="$ARTIFACTS/$PLUGIN_ID-$(node -p "require('$REPO_ROOT/package.json').version" 2>/dev/null || echo 0.1.0).tgz"

DRY_RUN=0
SKIP_TESTS=0
CORE_BASE_URL="${TDB_CORE_BASE_URL:-}"
CORE_KEY="${TDB_CORE_API_KEY:-}"
TEAM_ID="${TDB_TEAM_ID:-}"
AGENT_ID="${TDB_AGENT_ID:-}"
USER_ID="${TDB_USER_ID:-}"
SERVICE_ID="${TDB_SERVICE_ID:-default}"
# Name of the credentials ref (and the env var fallback) that carries the
# core server key. The VALUE is never written into the patch.
API_KEY_REF="${TDB_API_KEY_REF:-TDAI_GATEWAY_APIKEY}"
INLINE_KEY=0
STORE_KEY=1
KEY_STORED=0
# Optional YAML fragment appended verbatim under `config:` (indented by the
# script), for keys this script does not model: writeback.skillFeed,
# volatile.maxChars, headPack.enabled, paths.*, debug … Without it an operator
# could not turn the L2 feed off on a profile that already has MemoryProxy
# writing the same identity.
CONFIG_EXTRA=""
# Accept both spellings ("--identity a,b,c" and "--identity=a,b,c"): the usage
# block above documents the space form, and callers copy it verbatim.
while [ "$#" -gt 0 ]; do
  arg="$1"
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --skip-tests) SKIP_TESTS=1 ;;
    --base-url=*) CORE_BASE_URL="${arg#*=}" ;;
    --base-url) shift; CORE_BASE_URL="${1:-}" ;;
    --api-key=*) CORE_KEY="${arg#*=}" ;;
    --api-key) shift; CORE_KEY="${1:-}" ;;
    --api-key-ref=*) API_KEY_REF="${arg#*=}" ;;
    --api-key-ref) shift; API_KEY_REF="${1:-}" ;;
    --inline-key) INLINE_KEY=1 ;;
    --no-store-key) STORE_KEY=0 ;;
    --identity=*)
      IFS=',' read -r TEAM_ID AGENT_ID USER_ID <<< "${arg#*=}"
      ;;
    --identity)
      shift
      IFS=',' read -r TEAM_ID AGENT_ID USER_ID <<< "${1:-}"
      ;;
    --config-extra=*) CONFIG_EXTRA="${arg#*=}" ;;
    --config-extra) shift; CONFIG_EXTRA="${1:-}" ;;
    -h|--help) sed -n '2,50p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
  shift
done

# Defaults that keep the local standalone deployment working out of the box.
CORE_BASE_URL="${CORE_BASE_URL:-http://127.0.0.1:8420}"
IS_LOCAL_CORE=0
if printf '%s' "$CORE_BASE_URL" | grep -Eq '^https?://(127\.0\.0\.1|localhost|\[::1\])([:/]|$)'; then
  IS_LOCAL_CORE=1
fi
# Only a LOCAL core key can come from the checkout: on a cross-host deploy
# ../MemoryCore/tdai-gateway.yaml belongs to another machine and another secret.
if [ -z "$CORE_KEY" ] && [ "$IS_LOCAL_CORE" = "1" ] && [ -f "$REPO_ROOT/../MemoryCore/tdai-gateway.yaml" ]; then
  # First quoted apiKey in the file is server.apiKey (the llm/apiKey lines below
  # it are ${ENV} placeholders). Quote it or the key stays empty on purpose.
  CORE_KEY="$(sed -n 's/^[[:space:]]*apiKey:[[:space:]]*"\([^"$]*\)".*/\1/p' \
    "$REPO_ROOT/../MemoryCore/tdai-gateway.yaml" | head -1)"
fi

# --- Where does the core key come from? ------------------------------------
# Two layers of credentials, never mixed:
#   Authorization     = the core's own server key (64 hex, gateway layer)
#   x-tdai-user-key   = a short user key (identity layer; not written here)
# A profile patch is dumped by --dump-config and copied around, so the key
# VALUE goes into the host credentials store and the patch carries only the
# ref NAME.
CREDENTIALS_FILE="$DSH_HOME_DIR/.credentials.yaml"
CREDENTIALS_UTIL="$REPO_ROOT/scripts/credentials-util.mjs"
# IS_LOCAL_CORE was computed above; it also gates the local yaml read, because a
# remote core has a different key and picking up the local one installs a plugin
# that 401s on every turn.
REF_HAS_KEY=0
if [ -f "$CREDENTIALS_FILE" ] && node "$CREDENTIALS_UTIL" has "$CREDENTIALS_FILE" "$API_KEY_REF" >/dev/null 2>&1; then
  REF_HAS_KEY=1
fi
ENV_HAS_KEY=0
if [ -n "${!API_KEY_REF:-}" ]; then ENV_HAS_KEY=1; fi

# Never silently install an inert, unauthenticated plugin. On a cross-host
# deploy the local tdai-gateway.yaml does not exist at all, so the old silent
# "no key" fallback installed a plugin that answered 401 on every turn.
if [ "$INLINE_KEY" = "1" ] && [ -z "$CORE_KEY" ]; then
  echo "--inline-key needs a key value: pass --api-key or set TDB_CORE_API_KEY" >&2
  exit 2
fi
if [ -z "$CORE_KEY" ] && [ "$REF_HAS_KEY" = "0" ] && [ "$ENV_HAS_KEY" = "0" ]; then
  {
    echo "cannot resolve the core API key for $CORE_BASE_URL"
    echo "  tried: --api-key / TDB_CORE_API_KEY / ../MemoryCore/tdai-gateway.yaml (local core only)"
    echo "         credentials ref $API_KEY_REF in $CREDENTIALS_FILE"
    echo "         env $API_KEY_REF"
    echo "  fix  : bash scripts/deploy.sh --api-key <core server.apiKey>  # stored under the ref, never in the patch"
    echo "         printf '%s' <key> | node scripts/credentials-util.mjs set $CREDENTIALS_FILE $API_KEY_REF"
    echo "         export $API_KEY_REF=<key>"
    if [ "$IS_LOCAL_CORE" = "0" ]; then
      echo "  note : cross-host core ($CORE_BASE_URL) — tdai-gateway.yaml lives on the core machine."
      echo "         TLS is not implemented yet; see README cross-host section."
    fi
  } >&2
  if [ "$DRY_RUN" = "1" ]; then
    printf '   [dry-run] would abort here; continuing so the plan can be inspected\n'
  else
    exit 2
  fi
fi

say() { printf '== %s\n' "$*"; }
run() {
  if [ "$DRY_RUN" = "1" ]; then
    printf '   [dry-run] %s\n' "$*"
  else
    printf '   $ %s\n' "$*"
    "$@"
  fi
}

say "profile     : $PROFILE ($PROFILE_DIR)"
say "patch file  : $PATCH_FILE"
say "state dir   : $STATE_DIR"
say "tarball     : $TARBALL"
say "core        : $CORE_BASE_URL (service $SERVICE_ID)"
say "api key     : $([ -n "$CORE_KEY" ] && { [ "$INLINE_KEY" = "1" ] && echo "set (${#CORE_KEY} chars, written INLINE into the patch)" || echo "set (${#CORE_KEY} chars, will be stored under $API_KEY_REF)"; } || { [ "$INLINE_KEY" = "1" ] && echo "MISSING — --inline-key needs --api-key or TDB_CORE_API_KEY"; } || { [ "$STORE_KEY" = "1" ] && echo "not read here: the host resolves the ref $API_KEY_REF at runtime (credentials, then env)"; } || echo "not managed here (--no-store-key): the host must already have $API_KEY_REF")"
say "identity    : team=$TEAM_ID agent=$AGENT_ID user=$USER_ID"
if [ -z "$TEAM_ID" ] || [ -z "$AGENT_ID" ] || [ -z "$USER_ID" ]; then
  printf '   !! identity incomplete: the plugin mounts but stays INERT (no read, no write).\n'
  printf '      Pass --identity team,agent,user (or TDB_TEAM_ID/TDB_AGENT_ID/TDB_USER_ID)\n'
  printf '      using the values the core stored your memory under.\n'
fi

[ -d "$PROFILE_DIR" ] || { echo "profile not initialized: $PROFILE_DIR" >&2; exit 1; }
[ -f "$PROFILE_DIR/package.json" ] || { echo "missing $PROFILE_DIR/package.json" >&2; exit 1; }
[ -f "$REPO_ROOT/package.json" ] || { echo "run this from the dsh-plugin package" >&2; exit 1; }

# Re-running on an already-deployed profile must UPGRADE (new tarball, new
# config) rather than silently succeed. The old behaviour exited 0 here, which
# made "deploy the fix" a no-op that looked like success.
UPGRADE=0
if [ -f "$PATCH_FILE" ] && node "$REPO_ROOT/scripts/patch-util.mjs" has "$PATCH_FILE" | grep -qx yes; then
  UPGRADE=1
  say "patch entry already present: this run UPGRADES it (tarball + config replaced)"
fi
if [ -n "$CONFIG_EXTRA" ] && [ ! -f "$CONFIG_EXTRA" ]; then
  echo "--config-extra file not found: $CONFIG_EXTRA" >&2
  exit 1
fi

say "1/6 build"
if [ -x "$REPO_ROOT/node_modules/.bin/tsc" ]; then
  run "$REPO_ROOT/node_modules/.bin/tsc" -p "$REPO_ROOT/tsconfig.json"
elif [ -n "${TSC_BIN:-}" ]; then
  run "$TSC_BIN" -p "$REPO_ROOT/tsconfig.json"
elif [ -x "$REPO_ROOT/../MemoryCore/node_modules/typescript/bin/tsc" ]; then
  run node "$REPO_ROOT/../MemoryCore/node_modules/typescript/bin/tsc" -p "$REPO_ROOT/tsconfig.json"
else
  echo "no tsc available: install dev dependencies (pnpm install) or set TSC_BIN" >&2
  exit 1
fi
[ "$DRY_RUN" = "1" ] || [ -f "$REPO_ROOT/dist/index.js" ] || { echo "build produced no dist/index.js" >&2; exit 1; }

if [ "$SKIP_TESTS" = "0" ]; then
  say "2/6 test"
  if [ -x "$REPO_ROOT/node_modules/.bin/vitest" ]; then
    run "$REPO_ROOT/node_modules/.bin/vitest" run
  elif [ -n "${VITEST_BIN:-}" ]; then
    run node "$VITEST_BIN" run
  elif [ -x "$REPO_ROOT/../MemoryCore/node_modules/vitest/vitest.mjs" ]; then
    run node "$REPO_ROOT/../MemoryCore/node_modules/vitest/vitest.mjs" run
  else
    echo "no vitest available: skipping tests is NOT allowed silently; pass --skip-tests to opt out" >&2
    exit 1
  fi
else
  say "2/6 test skipped (--skip-tests)"
fi

say "3/6 pack"
run mkdir -p "$ARTIFACTS"
# npm/pnpm tarball convention: every entry sits under a single "package/"
# prefix, and the installer strips that one leading component. Packing the
# files at the archive root instead makes pnpm flatten "dist/index.js" to
# "index.js" inside the virtual store, so the installed entry cannot be loaded.
if [ "$DRY_RUN" = "1" ]; then
  printf '   [dry-run] tar -czf %s -C <staging>/ package.json dist README.md\n' "$TARBALL"
else
  rm -f "$TARBALL"
  STAGE="$(mktemp -d)"
  mkdir -p "$STAGE/package"
  cp "$REPO_ROOT/package.json" "$STAGE/package/package.json"
  # Ship exactly what package.json `files` declares. This used to be a hardcoded
  # "dist + README.md", which silently dropped the browser half (client/) and the
  # bundle-patch overlay (cordis.bundle.yml) even though both were declared: the
  # installer then rejected the package with
  #   failed to read overlay .../cordis.bundle.yml: ENOENT
  # and rolled the whole install back. Fail loudly when a declared path is gone.
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    if [ -e "$REPO_ROOT/$entry" ]; then
      cp -R "$REPO_ROOT/$entry" "$STAGE/package/$entry"
    else
      echo "package.json files[] lists '$entry' but it does not exist — refusing to pack a partial plugin" >&2
      exit 1
    fi
  done <<< "$(node -e 'const p=require(process.argv[1]);for (const f of p.files || []) console.log(f)' "$REPO_ROOT/package.json")"
  tar -czf "$TARBALL" -C "$STAGE" package
  rm -rf "$STAGE"
  ls -l "$TARBALL"
fi

say "4/6 back up profile files"
run mkdir -p "$STATE_DIR"
for name in package.json pnpm-lock.yaml cordis.patch.yml; do
  if [ -f "$PROFILE_DIR/$name" ]; then
    run cp "$PROFILE_DIR/$name" "$STATE_DIR/$name.bak"
  fi
done

# Store the key BEFORE touching anything outside the repo: if the host store
# cannot be written we can still exit cleanly. The value goes to stdin (never
# argv, so it cannot show up in ps or shell history) and the patch only ever
# carries the ref NAME. A fresh install would otherwise be inert or 401.
if [ "$INLINE_KEY" != "1" ] && [ "$STORE_KEY" = "1" ] && [ -n "$CORE_KEY" ]; then
  say "4/6b store the core key under credentials ref $API_KEY_REF (value never printed)"
  if [ -f "$CREDENTIALS_FILE" ]; then
    run cp "$CREDENTIALS_FILE" "$STATE_DIR/credentials.yaml.bak"
  fi
  if [ "$DRY_RUN" = "1" ]; then
    printf '   [dry-run] printf <key> | node scripts/credentials-util.mjs set %s %s\n' "$CREDENTIALS_FILE" "$API_KEY_REF"
  else
    if printf '%s' "$CORE_KEY" | node "$CREDENTIALS_UTIL" set "$CREDENTIALS_FILE" "$API_KEY_REF"; then
      KEY_STORED=1
    else
      echo "could not write the key into $CREDENTIALS_FILE" >&2
      echo "  fix: store it yourself, or deploy with --inline-key (patch carries the secret)" >&2
      exit 1
    fi
  fi
else
  say "4/6b no local key to store (inline mode, --no-store-key, or the ref already resolves); the patch carries the ref only"
fi

say "5/6 install with the official plugin command"
# pnpm runs as a Windows process: a git-bash path (/d/...) would resolve to
# C:\d\..., so hand it a mixed Windows path (D:/...).
TARBALL_SPEC="file:$TARBALL"
if command -v cygpath >/dev/null 2>&1; then
  TARBALL_SPEC="file:$(cygpath -m "$TARBALL")"
fi
run "$DSH_BIN" plugin --profile "$PROFILE" add "$TARBALL_SPEC"

# pnpm keys a file: dependency by its tarball PATH + version, not by content, so
# re-running this script with the same version leaves the PREVIOUS build in
# node_modules and every later check still passes ("dist entry: present"). That
# already shipped a stale build once (the apiKeyRef change sat in the repo while
# the profile kept running the old dist). Compare the packed entry with what is
# actually installed and force-refresh once instead of trusting the install.
ensure_installed_build_matches() {
  local local_sum installed_sum installed_entry short_local short_installed
  installed_entry="$PROFILE_DIR/node_modules/$PKG_NAME/dist/index.js"
  [ -f "$installed_entry" ] || abort_deploy "installed entry not found: node_modules/$PKG_NAME/dist/index.js"
  local_sum=$(node -e 'const c=require("crypto"),f=require("fs");process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' "$REPO_ROOT/dist/index.js")
  installed_sum=$(node -e 'const c=require("crypto"),f=require("fs");process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' "$installed_entry")
  short_local=$(printf '%s' "$local_sum" | cut -c1-12)
  short_installed=$(printf '%s' "$installed_sum" | cut -c1-12)
  if [ "$local_sum" = "$installed_sum" ]; then
    say "installed build: fresh (sha256 $short_local)"
    return 0
  fi
  say "installed build: STALE (installed $short_installed != packed $short_local) — forcing one reinstall"
  rm -rf "$PROFILE_DIR/node_modules/$PKG_NAME"
  run "$DSH_BIN" plugin --profile "$PROFILE" add "$TARBALL_SPEC"
  installed_sum=$(node -e 'const c=require("crypto"),f=require("fs");process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' "$installed_entry")
  if [ "$installed_sum" != "$local_sum" ]; then
    abort_deploy "installed build still stale after reinstall"
  fi
  say "installed build: refreshed (sha256 $short_local)"
}
ensure_installed_build_matches

say "6/6 write the managed patch entry and verify"
# The loader replaces a patch entry's config wholesale (never deep-merges), so
# this block is the whole plugin configuration for this profile. One renderer
# for both the dry run and the real write, so the printed plan cannot drift
# from what is actually written.
render_entry() {
  echo ""
  echo "- insert:"
  echo "    - id: $PLUGIN_ID"
  echo "      name: $ENTRY"
  echo "      config:"
  echo "        server:"
  echo "          baseUrl: \"$CORE_BASE_URL\""
  echo "          serviceId: \"$SERVICE_ID\""
  # The patch is dumped by --dump-config and copied between machines, so by
  # default it carries only the ref NAME; the value lives in the host
  # credentials store (or the env fallback). --inline-key opts back in for
  # hosts without a credentials store.
  if [ "$INLINE_KEY" = "1" ] && [ -n "$CORE_KEY" ]; then
    echo "          apiKey: \"$CORE_KEY\""
  else
    echo "          apiKeyRef: \"$API_KEY_REF\""
  fi
  echo "          teamId: \"$TEAM_ID\""
  echo "          agentId: \"$AGENT_ID\""
  echo "          userId: \"$USER_ID\""
  # Operator-supplied keys (writeback.skillFeed, volatile.maxChars, debug …).
  # Indented by 8 spaces to sit under `config:`; the fragment is YAML, not a
  # list, so a stray "- " line here is a user error we surface instead of
  # silently writing a broken patch.
  if [ -n "$CONFIG_EXTRA" ]; then
    grep -v '^[[:space:]]*$' "$CONFIG_EXTRA" | sed 's/^/        /'
  fi
}

# Undo everything this run did, in the reverse order it was done. Called on any
# post-install failure so a failed deploy never leaves an installed package or a
# dangling patch entry behind (the old script left orphans and exited 1).
abort_deploy() {
  echo "deploy failed: $1" >&2
  echo "rolling back this run (stamp $STAMP)…" >&2
  if [ -f "$PATCH_FILE" ]; then
    node "$REPO_ROOT/scripts/patch-util.mjs" strip "$PATCH_FILE" || true
  fi
  for name in package.json pnpm-lock.yaml cordis.patch.yml; do
    if [ -f "$STATE_DIR/$name.bak" ]; then
      cp "$STATE_DIR/$name.bak" "$PROFILE_DIR/$name"
    fi
  done
  # Only the ref this run wrote is rolled back; other refs stay untouched.
  if [ "$KEY_STORED" = "1" ] && [ -f "$STATE_DIR/credentials.yaml.bak" ]; then
    cp "$STATE_DIR/credentials.yaml.bak" "$CREDENTIALS_FILE"
    echo "restored $CREDENTIALS_FILE (kept the ref if it existed before)" >&2
  fi
  "$DSH_BIN" plugin --profile "$PROFILE" remove "$PKG_NAME" >/dev/null 2>&1 || true
  rm -rf "$PROFILE_DIR/node_modules/$PKG_NAME" 2>/dev/null || true
  exit 1
}

# Some profiles cannot be resolved by the CLI at all: the Electron app owns them
# ("error: profile \"desktop\" is managed exclusively by the Electron application"),
# so --dump-config refuses. That profile is exactly the one the user runs, so a
# refusal must not abort the deploy. Verify the file-level facts instead and say
# plainly that composition is resolved by the app at its next startup.
verify_app_managed() {
  node "$REPO_ROOT/scripts/patch-util.mjs" has "$PATCH_FILE" >/dev/null \
    || abort_deploy "managed block missing from $PATCH_FILE"
  [ -f "$PROFILE_DIR/node_modules/$PKG_NAME/dist/index.js" ] \
    || abort_deploy "installed entry not found: node_modules/$PKG_NAME/dist/index.js"
  node -e 'const p = require(process.argv[1]); const d = p.dependencies || {}; process.exit(d[process.argv[2]] ? 0 : 1)' \
    "$PROFILE_DIR/package.json" "$PKG_NAME" \
    || abort_deploy "package.json does not list $PKG_NAME as a dependency"
  say "app-managed profile: CLI --dump-config unavailable, verified by file facts"
  say "  patch block: present | dist entry: present | package.json dep: present"
  say "  composition is resolved by the app at startup — after restart run: node scripts/verify-installed.mjs"
}

if [ "$DRY_RUN" = "1" ]; then
  printf '   [dry-run] would %s the managed block in %s (api key masked):\n' \
    "$([ "$UPGRADE" = "1" ] && echo replace || echo append)" "$PATCH_FILE"
  render_entry | sed -E 's/(apiKey: ")([^"]{8})[^"]*([^"]{4})"/\1\2…\3"/' | sed 's/^/   | /'
  printf '   [dry-run] %s --profile %s --dump-config > %s/dump-config.yml\n' "$DSH_BIN" "$PROFILE" "$STATE_DIR"
  printf '   [dry-run]   (if the profile is app-managed this refuses; the script then verifies\n'
  printf '   [dry-run]    patch block + dist entry + package.json dep instead of aborting)\n'
else
  if [ ! -f "$PATCH_FILE" ]; then
    printf '# Your patch layer for this dsh profile.\n' > "$PATCH_FILE"
  fi
  # A freshly initialized profile ships an empty flow sequence as its whole
  # document ("[]"). Appending a block-style entry after that line is invalid
  # YAML, so drop the bare empty-array line before appending.
  if grep -qx '\[\]' "$PATCH_FILE"; then
    grep -vx '\[\]' "$PATCH_FILE" > "$PATCH_FILE.tmp"
    mv "$PATCH_FILE.tmp" "$PATCH_FILE"
  fi
  render_entry > "$STATE_DIR/entry.yml"
  # Record the stamp BEFORE verifying: rollback.sh needs a state dir to exist
  # even when the verification below fails (that was how a failed deploy used to
  # become an unrecoverable orphan).
  printf '%s\n' "$STAMP" > "$STATE_ROOT/last"
  ln -sfn "$STAMP" "$STATE_ROOT/current" 2>/dev/null || true
  node "$REPO_ROOT/scripts/patch-util.mjs" upsert "$PATCH_FILE" "$STATE_DIR/entry.yml" || abort_deploy "could not write the patch entry"
  if "$DSH_BIN" --profile "$PROFILE" --dump-config > "$STATE_DIR/dump-config.yml" 2> "$STATE_DIR/dump-config.err"; then
    grep -q "$PLUGIN_ID" "$STATE_DIR/dump-config.yml" \
      || abort_deploy "dump-config does not contain $PLUGIN_ID"
    say "dump-config contains $PLUGIN_ID — composition resolved ($([ "$UPGRADE" = "1" ] && echo upgraded || echo installed))"
  elif grep -q 'managed exclusively by the Electron application' "$STATE_DIR/dump-config.err" 2>/dev/null; then
    verify_app_managed
  else
    abort_deploy "dump-config failed (see $STATE_DIR/dump-config.err)"
  fi
fi

cat <<DONE

$([ "$DRY_RUN" = "1" ] && echo "DRY RUN — nothing was written." || echo "Deployed state stamped: $STAMP")
Core key:   $([ "$INLINE_KEY" = "1" ] && echo "inline in the patch (--inline-key)" || { [ "$STORE_KEY" = "1" ] && echo "credentials ref $API_KEY_REF — the patch carries the ref only" || echo "not stored (--no-store-key): set the ref yourself"; })
Backups:    $STATE_DIR
Evidence:   $STATE_DIR/dump-config.yml
Rollback:   bash scripts/rollback.sh
Next step:  restart the dsh host (this session's GUI) so the plugin mounts.
            Until then the running host is untouched.
DONE
