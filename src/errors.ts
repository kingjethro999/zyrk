/**
 * Stable error codes and the one error type the CLI turns into output.
 *
 * The table in SPEC 29.1 is the contract. Codes beginning with SNPM_ that are
 * not listed there are internal extensions; they follow the same rules:
 * name the failed action, name the subject, and carry a remedy.
 */

export const SPEC_ERROR_CODES = [
  "SNPM_MANIFEST_INVALID",
  "SNPM_LOCK_MISMATCH",
  "SNPM_RESOLUTION_FAILED",
  "SNPM_PEER_CONFLICT",
  "SNPM_INTEGRITY_FAILED",
  "SNPM_SIGNATURE_INVALID",
  "SNPM_EXTRACTION_UNSAFE",
  "SNPM_SCRIPT_BLOCKED",
  "SNPM_BUILD_FAILED",
  "SNPM_WORKSPACE_BUILD_CONTEXT_UNSUPPORTED",
  "SNPM_OFFLINE_MISSING",
  "SNPM_LINK_UNSUPPORTED",
  "SNPM_STORE_CORRUPT",
  "SNPM_PROJECT_LOCKED",
  "SNPM_DISK_FULL",
  "SNPM_DEPLOY_ESCAPE",
  "SNPM_DEPLOY_NONRELOCATABLE",
  "SNPM_PLATFORM_UNSUPPORTED",
  "SNPM_REGISTRY_AUTH",
  "SNPM_POLICY_DENIED",
  /** Global installation requested through snpm; added by SPEC v1.2 §29.1. */
  "SNPM_GLOBAL_INSTALL_UNSUPPORTED",
] as const;

export type SpecErrorCode = (typeof SPEC_ERROR_CODES)[number];

/** Internal extensions. Keep this list short and justified. */
export const INTERNAL_ERROR_CODES = [
  /** Bad invocation: unknown command, contradictory flags, missing argument. */
  "SNPM_USAGE",
  /** A documented command or mode that has not been implemented yet. */
  "SNPM_NOT_IMPLEMENTED",
  /** Store root fails ownership/permission safety checks. */
  "SNPM_STORE_UNSAFE",
  /** Store format marker missing or newer/older than this CLI understands. */
  "SNPM_STORE_FORMAT_UNSUPPORTED",
  /**
   * A fetched artifact was refused before use: download exceeded the
   * configured size bound, or a bounded retry budget was exhausted on a
   * refusal-worthy response. Distinct from SNPM_INTEGRITY_FAILED: nothing
   * was verified or accepted.
   */
  "SNPM_FETCH_REFUSED",
  /**
   * Transport failure reaching the registry (DNS, TLS, connect, timeout,
   * HTTP 5xx) after bounded retries. Retryable later; not an integrity or
   * resolution verdict.
   */
  "SNPM_FETCH_FAILED",
  /** Unexpected internal failure; always a bug. */
  "SNPM_INTERNAL",
] as const;

export type InternalErrorCode = (typeof INTERNAL_ERROR_CODES)[number];

export type ErrorCode = SpecErrorCode | InternalErrorCode;

export type SnpmErrorOptions = {
  /** Structured facts about the failure. Never include credentials. */
  detail?: Record<string, unknown>;
  /** One actionable line: what the user can do next. */
  remedy?: string;
  cause?: unknown;
};

export class SnpmError extends Error {
  readonly code: ErrorCode;
  readonly detail: Record<string, unknown> | undefined;
  readonly remedy: string | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: SnpmErrorOptions = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "SnpmError";
    this.code = code;
    this.detail = options.detail;
    this.remedy = options.remedy;
  }
}

export function isSnpmError(error: unknown): error is SnpmError {
  return error instanceof SnpmError;
}

/**
 * Wrap an unknown thrown value. Node system errors get their code preserved
 * in `detail.errno` so disk-full and permission failures stay diagnosable
 * without dumping the environment.
 */
export function toSnpmError(
  error: unknown,
  fallbackMessage: string,
): SnpmError {
  if (isSnpmError(error)) return error;

  const detail: Record<string, unknown> = {};
  let message = fallbackMessage;
  if (error instanceof Error) {
    message = error.message === "" ? fallbackMessage : error.message;
    const errno = (error as NodeJS.ErrnoException).code;
    if (typeof errno === "string") {
      detail.errno = errno;
      if (errno === "ENOSPC") {
        return new SnpmError("SNPM_DISK_FULL", message, {
          detail,
          cause: error,
        });
      }
      if (errno === "EACCES" || errno === "EPERM") {
        detail.errno = errno;
      }
    }
  }
  return new SnpmError("SNPM_INTERNAL", message, { detail, cause: error });
}

/**
 * Process exit status. SPEC 15.4 requires nonzero for integrity failure,
 * unresolved required dependencies, blocked required builds, and failed
 * required builds; 1 covers all of those. Usage errors use 2 so scripts can
 * tell "you called it wrong" from "the operation failed".
 */
export function exitCodeFor(error: SnpmError): number {
  return error.code === "SNPM_USAGE" ? 2 : 1;
}
