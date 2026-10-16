/**
 * Stable error codes and the one error type the CLI turns into output.
 *
 * The table in SPEC 29.1 is the contract. Codes beginning with NEXU_ that are
 * not listed there are internal extensions; they follow the same rules:
 * name the failed action, name the subject, and carry a remedy.
 */

export const SPEC_ERROR_CODES = [
  "NEXU_MANIFEST_INVALID",
  "NEXU_LOCK_MISMATCH",
  "NEXU_RESOLUTION_FAILED",
  "NEXU_PEER_CONFLICT",
  "NEXU_INTEGRITY_FAILED",
  "NEXU_SIGNATURE_INVALID",
  "NEXU_EXTRACTION_UNSAFE",
  "NEXU_SCRIPT_BLOCKED",
  "NEXU_BUILD_FAILED",
  "NEXU_WORKSPACE_BUILD_CONTEXT_UNSUPPORTED",
  "NEXU_OFFLINE_MISSING",
  "NEXU_LINK_UNSUPPORTED",
  "NEXU_STORE_CORRUPT",
  "NEXU_PROJECT_LOCKED",
  "NEXU_DISK_FULL",
  "NEXU_DEPLOY_ESCAPE",
  "NEXU_DEPLOY_NONRELOCATABLE",
  "NEXU_PLATFORM_UNSUPPORTED",
  "NEXU_REGISTRY_AUTH",
  "NEXU_POLICY_DENIED",
  /** Global installation requested through nexu; added by SPEC v1.2 §29.1. */
  "NEXU_GLOBAL_INSTALL_UNSUPPORTED",
] as const;

export type SpecErrorCode = (typeof SPEC_ERROR_CODES)[number];

/** Internal extensions. Keep this list short and justified. */
export const INTERNAL_ERROR_CODES = [
  /** Bad invocation: unknown command, contradictory flags, missing argument. */
  "NEXU_USAGE",
  /** A documented command or mode that has not been implemented yet. */
  "NEXU_NOT_IMPLEMENTED",
  /** npm executable missing for an explicitly delegated command (D-3). */
  "NEXU_NPM_UNAVAILABLE",
  /** Store root fails ownership/permission safety checks. */
  "NEXU_STORE_UNSAFE",
  /** Store format marker missing or newer/older than this CLI understands. */
  "NEXU_STORE_FORMAT_UNSUPPORTED",
  /**
   * A fetched artifact was refused before use: download exceeded the
   * configured size bound, or a bounded retry budget was exhausted on a
   * refusal-worthy response. Distinct from NEXU_INTEGRITY_FAILED: nothing
   * was verified or accepted.
   */
  "NEXU_FETCH_REFUSED",
  /**
   * Transport failure reaching the registry (DNS, TLS, connect, timeout,
   * HTTP 5xx) after bounded retries. Retryable later; not an integrity or
   * resolution verdict.
   */
  "NEXU_FETCH_FAILED",
  /** Unexpected internal failure; always a bug. */
  "NEXU_INTERNAL",
] as const;

export type InternalErrorCode = (typeof INTERNAL_ERROR_CODES)[number];

export type ErrorCode = SpecErrorCode | InternalErrorCode;

export type NexuErrorOptions = {
  /** Structured facts about the failure. Never include credentials. */
  detail?: Record<string, unknown>;
  /** One actionable line: what the user can do next. */
  remedy?: string;
  cause?: unknown;
};

export class NexuError extends Error {
  readonly code: ErrorCode;
  readonly detail: Record<string, unknown> | undefined;
  readonly remedy: string | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: NexuErrorOptions = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "NexuError";
    this.code = code;
    this.detail = options.detail;
    this.remedy = options.remedy;
  }
}

export function isNexuError(error: unknown): error is NexuError {
  return error instanceof NexuError;
}

/**
 * Wrap an unknown thrown value. Node system errors get their code preserved
 * in `detail.errno` so disk-full and permission failures stay diagnosable
 * without dumping the environment.
 */
export function toNexuError(
  error: unknown,
  fallbackMessage: string,
): NexuError {
  if (isNexuError(error)) return error;

  const detail: Record<string, unknown> = {};
  let message = fallbackMessage;
  if (error instanceof Error) {
    message = error.message === "" ? fallbackMessage : error.message;
    const errno = (error as NodeJS.ErrnoException).code;
    if (typeof errno === "string") {
      detail.errno = errno;
      if (errno === "ENOSPC") {
        return new NexuError("NEXU_DISK_FULL", message, {
          detail,
          cause: error,
        });
      }
      if (errno === "EACCES" || errno === "EPERM") {
        detail.errno = errno;
      }
    }
  }
  return new NexuError("NEXU_INTERNAL", message, { detail, cause: error });
}

/**
 * Process exit status. SPEC 15.4 requires nonzero for integrity failure,
 * unresolved required dependencies, blocked required builds, and failed
 * required builds; 1 covers all of those. Usage errors use 2 so scripts can
 * tell "you called it wrong" from "the operation failed".
 */
export function exitCodeFor(error: NexuError): number {
  return error.code === "NEXU_USAGE" ? 2 : 1;
}
