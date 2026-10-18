/** Public, bounded install timeout configuration. Node and byte limits stay intact. */
import { ZyrkError } from "../errors.ts";
import type { ResolverLimits } from "../resolve/resolver.ts";
import type { ExtractionLimits } from "../extract/tarball.ts";

function timeout(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
): number {
  const raw = env[key];
  if (raw === undefined) return fallback;
  if (
    !/^[0-9]+$/.test(raw) ||
    !Number.isSafeInteger(Number(raw)) ||
    Number(raw) < 1 ||
    Number(raw) > 900000
  )
    throw new ZyrkError(
      "ZYRK_POLICY_DENIED",
      `Cannot configure install: ${key} must be an integer from 1 to 900000.`,
      {
        remedy: `Set ${key} to a timeout in milliseconds from 1 to 900000, or unset it to use the default.`,
      },
    );
  return Number(raw);
}
export function installBudgets(env: NodeJS.ProcessEnv): {
  resolveBudget: Partial<ResolverLimits>;
  extractBudget: Partial<ExtractionLimits>;
} {
  return {
    resolveBudget: {
      deadlineMs: timeout(env, "ZYRK_RESOLVE_TIMEOUT_MS", 300000),
    },
    extractBudget: {
      maxDurationMs: timeout(env, "ZYRK_EXTRACT_TIMEOUT_MS", 120000),
    },
  };
}
