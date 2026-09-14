/**
 * Ambient type declaration for the optional `@context-proxy/cost-guard`
 * git submodule (`packages/cost-guard/`).
 *
 * The submodule is intentionally NOT a hard checkout dependency (open-source
 * users may clone without `--recurse-submodules`), and its dynamic import in
 * `src/storage/factory.ts` is wrapped in try/catch with a graceful fallback.
 * The tsconfig `paths` mapping only resolves when the submodule directory
 * exists, so `tsc` must not depend on it either — this declaration provides
 * the minimal surface consumed by the main repo, typed from the authoritative
 * structural contracts in `src/storage/cos-types.ts` (CosLikeBackend /
 * KernelStsCosOptions — see docs/design/2026-07-11-cos-submodule-extraction-plan.md
 * §4.2 决策 1 + §4.4).
 *
 * Type-only: affects no runtime module resolution.
 */
declare module "@context-proxy/cost-guard" {
  import type { CosLikeBackend, KernelStsCosOptions } from "../storage/cos-types.js";

  export function openKernelStsCosBackend(opts: KernelStsCosOptions): CosLikeBackend;
}
