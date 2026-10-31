# dsh-plugin e2e report 4 — user key → identity resolution on a real host

Date: 2026-10-31 23:2x–23:3x (+08:00). Scope: task-51 v2 (mount-time identity resolution from
one user key) on a throwaway profile. Zero L0 / L2 writes (writeback disabled on purpose).
## Environment
- Profile: `agemem-e2e4` (created with `dsh.cmd --profile agemem-e2e4 --from-default-profile headless --dump-config`,
  EXIT 0, 386 lines), deleted after the run. Desktop profile was never mounted, never restarted.
- Deploy: `DSH_PROFILE=agemem-e2e4 bash scripts/deploy.sh --skip-tests --identity ,, --config-extra <abs>/cfg-writeback-off.yml`
  → managed entry with `teamId/agentId/userId = ""`, `writeback.enabled: false`, `apiKeyRef: TDAI_GATEWAY_APIKEY`.
  Installed build sha256 prefix **cc0c25cfa142** (repo == installed, checked by deploy).
- Runs: `E2E_PROFILE=agemem-e2e4 EXTRA_PATCH=enable-credentials.yml bash scratch/e2e2/run.sh …`
  (the extra patch adds `- id: credentials / disabled: false` — see host fact 1).
## Two real bugs found and fixed in this round
**B1 — mount-time seam lookup was one step too early (this is why desktop-style key resolution
would have silently produced no keys).**
- Symptom (run11): ready line at +228ms printed `identity=missing(teamId,agentId,userId),
  userKeySource=none, keySource=none, health=skipped(inert)`; every data call logged
  `/v3/core/read skipped, identity missing (teamId)`; volatile `{source:"none",injectedChars:0}`.
- Proof the seam itself is fine (run12 probe, +500ms): `credentials@500ms: typeof=object
  resolve=function`, `resolve TDAI_GATEWAY_APIKEY -> valueLen=64 source=file`,
  `resolve TDAI_USER_KEY -> valueLen=6 source=file`.
- Fix: `resolveCredential()` looks the service up **per call** and, the first time it is missing,
  waits up to `SEAM_WAIT_MS = 800` (25ms poll, unref'd timer); if it never appears it falls back to
  env and logs one debug line. Verified by a unit test that mounts the seam 50ms after `apply()`.

**B2 — `memory_recall` 的字段表形态让工具对模型不可用（原文因果已更正）**
- 症状串（**合成示例，非运行日志**；2026-11-01 诚实修正，见 `docs/ops/dsh-plugin-writeback-rootcause.md` §2）：`agemem: memory_recall registration failed {"code":"UNSUPPORTED_SCHEMA",
  "violations":["parameters.limit.required must be true when present"]}`。本机 `~/.dsh/agemem/` 只有两个 0 字节 outbox，无 `agemem.log`，该行不可复现。
- 机理（按代码，不看日志）：`ctx.tools.register` 只校验 output 形状 / timeoutMs / 保留名，**从不看 `parameters`**（抽出件 `scratch/dsh-plugin-probe/host/dsh-tools/lib/index.js:2974-2982`），把 `definition.parameters` 原样投影给模型（`:3136-3142`）⇒ register 路径**既不抛错也不可用**，「被宿主校验器拒绝」这个因果不成立；`required:false` 抛错只发生在 DSL 编译路（`:544-546` `authorError` → `JsonSchemaError`，文案 `:603`，编译入口 `:802-812`），条目插件不走它。
- 修复动作不变：`src/tools.ts` 直接产出完整 JSON Schema（`type:'object'` / `properties` / `required:['query']` / `additionalProperties:false`）+ 单测。
- Note: earlier headless runs resolved no `@deepseek-ai/dsh-tools` at all (identity fallback), so
  the bug was invisible until a composition actually registered the tool. Desktop is still on build
  2c72dbae5911 and will pick this fix up on its next deploy.
## Host facts learned (record in the runbook)
1. **headless disables credentials**: `dsh-headless/cordis.patch.yml` contains
   “One-shot jobs use launch-time credentials instead of the interactive store.” with
   `- id: credentials / disabled: true` (authorization, deepseek-account too). dsh-base enables it,
   dsh-web-app does not touch it ⇒ desktop resolves keys from the store, headless never does.
   Reproducing desktop's path needs the `credentials: disabled: false` overlay.
2. `credentials-local` skips the permission check on win32 (`if (process.platform === "win32") return;`),
   so a 644 `~/.dsh/.credentials.yaml` is accepted here; POSIX needs 600.
3. `credentials.resolve(ref)` → `{ value, source }` (`source: 'file' | 'env' | <dotenv name>`) or undefined.
4. `--session-id <new>` on a fresh session fails with `session "…" does not exist`; omit it.
## Evidence (real readings)
| # | Claim | Reading |
|---|---|---|
| 1 | identity resolved from the user key, keys from the credentials store | ready (+1810ms): `identity=resolved(user_key), userKeySource=credentials:TDAI_USER_KEY, keySource=credentials:TDAI_GATEWAY_APIKEY, health=ok, headPack=on,volatile=recall,writeback=off,skillFeed=off,tools=on, debug=on`; also `identity resolved from the user key {"teams":1,"agents":1}` at +1029ms (inside the 4s budget) |
| 2 | volatile still comes from /v3/recall, two independent runs | run13 `{recallMs:1789, cacheHit:false, prefetched:false, source:"recall", injectedChars:929, entriesKept:4}`; run14 `{recallMs:1609, source:"recall", injectedChars:906, entriesKept:4}` |
| 3 | sessions really used the memory | run13 answer cites the persona + "L2 scene index 14 blocks"; run14 answer recalls the 2026-10-21 / 2026-10-28 deployment preferences — both come from the injected pack |
| 4 | zero writes | `l0_conversations` rows for the three e2e session ids = **0**; `skill_buffer` has no file for them and no file newer than the run; `~/.dsh/agemem/outbox.jsonl` = 0 bytes, `outbox.dead.jsonl` = 0 bytes |
| 5 | invalid key ⇒ inert, session still answers | run15: **one** warn `the core rejected server.userKey (…not valid); memory stays inert for this process`, ready `identity=missing(teamId,agentId,userId), userKeySource=config, health=skipped(inert)`, volatile `{source:"none",injectedChars:0}`; the answer is “I can't see any injected memory … but I have memory_recall” — exactly the fail-open contract |
| 6 | no tool-schema rejection any more | `grep -c 'registration failed' run13/14/15.err` = 0 / 0 / 0 |
## Deviations / notes
- `deploy.sh` rewrote `refs.TDAI_GATEWAY_APIKEY` in `~/.dsh/.credentials.yaml` (its default). Same
  967 bytes as before and the `records:` block is untouched, but shared state was touched —
  `--no-store-key` is the flag for future throwaway profiles.
- `--config-extra` is resolved against the **repo root**, not `dsh-plugin/`; pass an absolute path.
- One run was wasted on the `--session-id` mistake (host fact 4).

## Reproduction
```bash
cd dsh-plugin && npx tsc -p tsconfig.json --noEmit && npx vitest run && npm run build
dsh.cmd --profile agemem-e2e4 --from-default-profile headless --dump-config > /tmp/create.out
node scratch/e2e2/make-patch4.mjs          # enable-credentials.yml / cfg-bad-userkey.yml
DSH_PROFILE=agemem-e2e4 bash scripts/deploy.sh --skip-tests --identity ,, --config-extra "$PWD/../scratch/e2e2/cfg-writeback-off.yml"
cd ../scratch/e2e2 && E2E_PROFILE=agemem-e2e4 EXTRA_PATCH=enable-credentials.yml bash run.sh run13.json run13.err --json '一句话说明能看到哪些记忆提示'
E2E_PROFILE=agemem-e2e4 EXTRA_PATCH=cfg-bad-userkey.yml bash run.sh run15.json run15.err --json '一句话说明你现在能看到记忆吗'
```

## Cleanup
- `rollback.sh` → “verified: composition no longer contains tdb-agemem-dsh”; e2e4 patch back to the `[]` seed; profile deleted.
- Overlay patches (`enable-credentials.yml`, `cfg-bad-userkey.yml`, `cfg-writeback-off.yml`) and the two
  `.deploy/` stamps of this round deleted (they carry a plaintext core key in `dump-config.yml`).
  `scratch/e2e2` now contains no 64-hex string.
- Desktop assertions after the run: `cordis.patch.yml` mtime **23:23:21**, `package.json` mtime **22:49:48**
  (both pre-date this smoke; hashes cf5379466089daec / b26c2b877ec0f34a), installed dist still
  **2c72dbae5911** — i.e. this round changed nothing there.

## Readings
- `npx tsc -p tsconfig.json --noEmit` → 0 · `npx vitest run` → **18 files / 281 tests passed** · `npm run build` → 0.
