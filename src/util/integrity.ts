/**
 * Subresource-Integrity handling for fetched archives (§13.5).
 *
 * nexu verifies integrity itself rather than trusting a library flag: while a
 * tarball streams to disk we hash it (sha512 and sha1, so legacy `shasum`
 * metadata can also be checked), then compare against the expected SRI string.
 * Nothing unverified ever reaches the store (I-001, I-009).
 *
 * Policy:
 *  - sha512 (or sha384/sha256) expected and matching  → verified.
 *  - only sha1 expected and matching                  → weak; accepted only
 *    with an explicit `allowWeak` (documented policy elsewhere).
 *  - expected digest missing                          → not verified; caller
 *    decides (strict mode rejects; otherwise the computed digest is pinned).
 *  - any mismatch                                     → hard failure.
 */

import { createHash, type Hash } from "node:crypto";
import { NexuError } from "../errors.ts";

export const SRI_ALGORITHMS = ["sha512", "sha384", "sha256", "sha1"] as const;
export type SriAlgorithm = (typeof SRI_ALGORITHMS)[number];

/** Algorithms that nexu treats as strong integrity. */
export const STRONG_ALGORITHMS: readonly SriAlgorithm[] = [
  "sha512",
  "sha384",
  "sha256",
];

export interface SriEntry {
  algorithm: SriAlgorithm;
  /** Standard base64 (base64url input is normalized). */
  digestBase64: string;
}

export interface ParsedSri {
  entries: SriEntry[];
  /** Whether the string was syntactically valid (`false` = malformed). */
  valid: boolean;
  /** Strongest entry present, if any (by our strength order). */
  strongest: SriEntry | undefined;
}

function normalizeBase64(value: string): string {
  return value.replaceAll("-", "+").replaceAll("_", "/");
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Parse an SRI string into entries. Malformed input is reported via
 * `valid: false` instead of throwing, so the caller can choose the policy.
 */
export function parseSri(value: string): ParsedSri {
  const entries: SriEntry[] = [];
  let valid = value.trim().length > 0;
  for (const raw of value.trim().split(/\s+/)) {
    if (raw === "") continue;
    // Strip any SRI options (`...?...`); npm does not use them.
    const withoutOptions = raw.split("?", 1)[0] ?? "";
    const dash = withoutOptions.indexOf("-");
    if (dash <= 0) {
      valid = false;
      continue;
    }
    const algorithm = withoutOptions.slice(0, dash);
    const digestRaw = normalizeBase64(withoutOptions.slice(dash + 1));
    if (!(SRI_ALGORITHMS as readonly string[]).includes(algorithm)) {
      // Unknown algorithms are not a syntax error, but were not verifiable.
      valid = false;
      continue;
    }
    if (digestRaw === "" || !BASE64_RE.test(digestRaw)) {
      valid = false;
      continue;
    }
    entries.push({
      algorithm: algorithm as SriAlgorithm,
      digestBase64: digestRaw,
    });
  }
  if (entries.length === 0) valid = false;
  let strongest: SriEntry | undefined;
  for (const algorithm of SRI_ALGORITHMS) {
    const found = entries.find((entry) => entry.algorithm === algorithm);
    if (found !== undefined) {
      strongest = found;
      break;
    }
  }
  return { entries, valid, strongest };
}

/** Build an SRI string from a base64 digest. */
export function formatSri(
  algorithm: SriAlgorithm,
  digestBase64: string,
): string {
  return `${algorithm}-${digestBase64}`;
}

export function base64FromHex(hex: string): string {
  return Buffer.from(hex, "hex").toString("base64");
}

export function hexFromBase64(base64: string): string {
  return Buffer.from(base64, "base64").toString("hex");
}

export interface HashedBytes {
  bytes: number;
  sha512Hex: string;
  sha512Base64: string;
  sha512Sri: string;
  sha1Hex: string;
  /** sha1 in the legacy npm `shasum` shape (hex). */
  shasum: string;
}

/**
 * Streaming hasher. Computes sha512 and sha1 in one pass and counts bytes.
 */
export class IntegrityHasher {
  #sha512: Hash = createHash("sha512");
  #sha1: Hash = createHash("sha1");
  #bytes = 0;
  #finalized: HashedBytes | undefined;

  update(chunk: Buffer | Uint8Array): void {
    if (this.#finalized !== undefined) {
      throw new NexuError(
        "NEXU_INTERNAL",
        "IntegrityHasher used after finalize()",
      );
    }
    this.#sha512.update(chunk);
    this.#sha1.update(chunk);
    this.#bytes += chunk.byteLength;
  }

  get bytes(): number {
    return this.#bytes;
  }

  finalize(): HashedBytes {
    if (this.#finalized === undefined) {
      const sha512Hex = this.#sha512.digest("hex");
      const sha1Hex = this.#sha1.digest("hex");
      const sha512Base64 = base64FromHex(sha512Hex);
      this.#finalized = {
        bytes: this.#bytes,
        sha512Hex,
        sha512Base64,
        sha512Sri: formatSri("sha512", sha512Base64),
        sha1Hex,
        shasum: sha1Hex,
      };
    }
    return this.#finalized;
  }
}

export type IntegrityOutcome =
  | { status: "verified"; algorithm: SriAlgorithm; digestBase64: string }
  | { status: "weak-verified"; digestBase64: string }
  | { status: "no-expected-integrity" }
  | {
      status: "mismatch";
      algorithm: SriAlgorithm;
      expected: string;
      actual: string;
    }
  | { status: "malformed" };

/**
 * Compare computed hashes against an expected SRI string.
 * Pure decision function; throwing is the caller's job (or use
 * `assertIntegrityOk` below).
 */
export function checkIntegrity(
  hashed: HashedBytes,
  expectedSRI: string | undefined,
): IntegrityOutcome {
  if (expectedSRI === undefined || expectedSRI.trim() === "") {
    return { status: "no-expected-integrity" };
  }
  const parsed = parseSri(expectedSRI);
  if (!parsed.valid || parsed.strongest === undefined) {
    return { status: "malformed" };
  }
  const entry = parsed.strongest;
  const actual = digestFor(hashed, entry.algorithm);
  if (actual !== entry.digestBase64) {
    return {
      status: "mismatch",
      algorithm: entry.algorithm,
      expected: entry.digestBase64,
      actual,
    };
  }
  if (entry.algorithm === "sha1") {
    return { status: "weak-verified", digestBase64: actual };
  }
  return {
    status: "verified",
    algorithm: entry.algorithm,
    digestBase64: actual,
  };
}

function digestFor(hashed: HashedBytes, algorithm: SriAlgorithm): string {
  if (algorithm === "sha512") return hashed.sha512Base64;
  if (algorithm === "sha1") return base64FromHex(hashed.sha1Hex);
  throw new NexuError(
    "NEXU_INTEGRITY_FAILED",
    `Integrity algorithm ${algorithm} is accepted in metadata but not implemented`,
  );
}

/**
 * Enforce the integrity outcome under the given policy.
 * Returns the verified digest (always sha512 when the hashes are ours to pin).
 * Throws NexuError(NEXU_INTEGRITY_FAILED) on mismatch, and on weak or missing
 * integrity unless the policy explicitly allows them.
 */
export function assertIntegrityOk(
  hashed: HashedBytes,
  expectedSRI: string | undefined,
  options: { what: string; allowWeak?: boolean; allowMissing?: boolean },
): { verifiedSri: string; weak: boolean } {
  const outcome = checkIntegrity(hashed, expectedSRI);
  switch (outcome.status) {
    case "verified":
      return {
        verifiedSri: formatSri(outcome.algorithm, outcome.digestBase64),
        weak: false,
      };
    case "weak-verified":
      if (options.allowWeak === true) {
        return {
          verifiedSri: formatSri("sha1", outcome.digestBase64),
          weak: true,
        };
      }
      throw new NexuError(
        "NEXU_INTEGRITY_FAILED",
        `${options.what} provides only legacy sha1 integrity; refusing under the current policy (set weak-integrity policy explicitly to accept)`,
      );
    case "no-expected-integrity":
      if (options.allowMissing === true) {
        return { verifiedSri: hashed.sha512Sri, weak: false };
      }
      throw new NexuError(
        "NEXU_INTEGRITY_FAILED",
        `${options.what} has no expected integrity metadata; strict policy rejects it`,
      );
    case "malformed":
      throw new NexuError(
        "NEXU_INTEGRITY_FAILED",
        `${options.what} has a malformed integrity string: ${String(expectedSRI)}`,
      );
    case "mismatch":
      throw new NexuError(
        "NEXU_INTEGRITY_FAILED",
        `${options.what} failed integrity verification: expected ${outcome.algorithm}-${outcome.expected}, got ${outcome.algorithm}-${outcome.actual}`,
      );
  }
}
