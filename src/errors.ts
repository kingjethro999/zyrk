/**
 * Stable error codes and the one error type the CLI turns into output.
 *
 * The table in SPEC 29.1 is the contract. Codes beginning with ZYRK_ that are
 * not listed there are internal extensions; they follow the same rules:
 * name the failed action, name the subject, and carry a remedy.
 */

export const SPEC_ERROR_CODES = [
  "ZYRK_MANIFEST_INVALID",
  "ZYRK_LOCK_MISMATCH",
  "ZYRK_RESOLUTION_FAILED",
  "ZYRK_PEER_CONFLICT",
  "ZYRK_INTEGRITY_FAILED",
  "ZYRK_SIGNATURE_INVALID",
  "ZYRK_EXTRACTION_UNSAFE",
  "ZYRK_SCRIPT_BLOCKED",
  "ZYRK_BUILD_FAILED",
  "ZYRK_WORKSPACE_BUILD_CONTEXT_UNSUPPORTED",
  "ZYRK_OFFLINE_MISSING",
  "ZYRK_LINK_UNSUPPORTED",
  "ZYRK_STORE_CORRUPT",
  "ZYRK_PROJECT_LOCKED",
  "ZYRK_DISK_FULL",
  "ZYRK_DEPLOY_ESCAPE",
  "ZYRK_DEPLOY_NONRELOCATABLE",
  "ZYRK_PLATFORM_UNSUPPORTED",
  "ZYRK_REGISTRY_AUTH",
  "ZYRK_POLICY_DENIED",
  /** Global installation requested through zyrk; added by SPEC v1.2 §29.1. */
  "ZYRK_GLOBAL_INSTALL_UNSUPPORTED",
] as const;

export type SpecErrorCode = (typeof SPEC_ERROR_CODES)[number];

/** Internal extensions. Keep this list short and justified. */
export const INTERNAL_ERROR_CODES = [
  /** Bad invocation: unknown command, contradictory flags, missing argument. */
  "ZYRK_USAGE",
  /** A documented command or mode that has not been implemented yet. */
  "ZYRK_NOT_IMPLEMENTED",
  /** npm executable missing for an explicitly delegated command (D-3). */
  "ZYRK_NPM_UNAVAILABLE",
  /** Store root fails ownership/permission safety checks. */
  "ZYRK_STORE_UNSAFE",
  /** Store format marker missing or newer/older than this CLI understands. */
  "ZYRK_STORE_FORMAT_UNSUPPORTED",
  /**
   * A fetched artifact was refused before use: download exceeded the
   * configured size bound, or a bounded retry budget was exhausted on a
   * refusal-worthy response. Distinct from ZYRK_INTEGRITY_FAILED: nothing
   * was verified or accepted.
   */
  "ZYRK_FETCH_REFUSED",
  /**
   * Transport failure reaching the registry (DNS, TLS, connect, timeout,
   * HTTP 5xx) after bounded retries. Retryable later; not an integrity or
   * resolution verdict.
   */
  "ZYRK_FETCH_FAILED",
  /** Unexpected internal failure; always a bug. */
  "ZYRK_INTERNAL",
] as const;

export type InternalErrorCode = (typeof INTERNAL_ERROR_CODES)[number];

export type ErrorCode = SpecErrorCode | InternalErrorCode;

export type ZyrkErrorOptions = {
  /** Structured facts about the failure. Never include credentials. */
  detail?: Record<string, unknown>;
  /** One actionable line: what the user can do next. */
  remedy?: string;
  cause?: unknown;
};

export class ZyrkError extends Error {
  readonly code: ErrorCode;
  readonly detail: Record<string, unknown> | undefined;
  readonly remedy: string | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: ZyrkErrorOptions = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "ZyrkError";
    this.code = code;
    this.detail = options.detail;
    this.remedy = options.remedy;
  }
}

export function isZyrkError(error: unknown): error is ZyrkError {
  return error instanceof ZyrkError;
}

/**
 * Wrap an unknown thrown value. Node system errors get their code preserved
 * in `detail.errno` so disk-full and permission failures stay diagnosable
 * without dumping the environment.
 */
export function toZyrkError(
  error: unknown,
  fallbackMessage: string,
): ZyrkError {
  if (isZyrkError(error)) return error;

  const detail: Record<string, unknown> = {};
  let message = fallbackMessage;
  if (error instanceof Error) {
    message = error.message === "" ? fallbackMessage : error.message;
    const errno = (error as NodeJS.ErrnoException).code;
    if (typeof errno === "string") {
      detail.errno = errno;
      if (errno === "ENOSPC") {
        return new ZyrkError("ZYRK_DISK_FULL", message, {
          detail,
          cause: error,
        });
      }
      if (errno === "EACCES" || errno === "EPERM") {
        detail.errno = errno;
      }
    }
  }
  return new ZyrkError("ZYRK_INTERNAL", message, { detail, cause: error });
}

/**
 * Process exit status. SPEC 15.4 requires nonzero for integrity failure,
 * unresolved required dependencies, blocked required builds, and failed
 * required builds; 1 covers all of those. Usage errors use 2 so scripts can
 * tell "you called it wrong" from "the operation failed".
 */
export function exitCodeFor(error: ZyrkError): number {
  return error.code === "ZYRK_USAGE" ? 2 : 1;
}
