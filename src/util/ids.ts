import { randomBytes } from "node:crypto";

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** RFC 4648 base32, lowercase, unpadded. Friendship with case-insensitive filesystems. */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

/**
 * Unpredictable identifier with a versioned prefix, e.g. `txn1_abc...`.
 * Length: 16 random bytes -> 26 base32 characters.
 */
export function randomId(prefix: string, bytes: number = 16): string {
  return `${prefix}${base32Encode(randomBytes(bytes))}`;
}

export const ID_PREFIX = {
  transaction: "txn1_",
  lease: "lease1_",
  gcRun: "gc1_",
  incident: "inc1_",
  project: "proj1_",
  generation: "gen1_",
  pin: "pin1_",
  repair: "repair1_",
  lockAttempt: "lk1_",
} as const;
