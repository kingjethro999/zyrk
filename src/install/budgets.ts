/** Public, bounded install timeout configuration. Node and byte limits stay intact. */
import { ZyrkError } from "../errors.ts";
import type { ResolverLimits } from "../resolve/resolver.ts";
import type { ExtractionLimits } from "../extract/tarball.ts";

function timeout(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  maximum = 900000,
): number {
  const raw = env[key];
  if (raw === undefined) return fallback;
  if (
    !/^[0-9]+$/.test(raw) ||
    !Number.isSafeInteger(Number(raw)) ||
    Number(raw) < 1 ||
    Number(raw) > maximum
  )
    throw new ZyrkError(
      "ZYRK_POLICY_DENIED",
      `Cannot configure install: ${key} must be an integer from 1 to ${maximum}.`,
      {
        remedy: `Set ${key} to a timeout in milliseconds from 1 to ${maximum}, or unset it to use the default.`,
      },
    );
  return Number(raw);
}
export function installBudgets(env: NodeJS.ProcessEnv): {
  resolveBudget: Partial<ResolverLimits>;
  extractBudget: Partial<ExtractionLimits>;
  fetchBudget: { deadlineMs: number };
} {
  return {
    resolveBudget: {
      deadlineMs: timeout(env, "ZYRK_RESOLVE_TIMEOUT_MS", 300000),
    },
    extractBudget: {
      maxDurationMs: timeout(env, "ZYRK_EXTRACT_TIMEOUT_MS", 120000),
    },
    fetchBudget: {
      deadlineMs: timeout(env, "ZYRK_FETCH_TIMEOUT_MS", 900000, 3600000),
    },
  };
}

/** Bound slow registry transfers while allowing large framework archives. */
export function registryRequestDeadline(env: NodeJS.ProcessEnv): number {
  return timeout(env, "ZYRK_REQUEST_TIMEOUT_MS", 900000, 3600000);
}
