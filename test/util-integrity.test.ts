import { describe, expect, it } from "vitest";
import {
  assertIntegrityOk,
  base64FromHex,
  checkIntegrity,
  formatSri,
  IntegrityHasher,
  parseSri,
} from "../src/util/integrity.ts";
import { SnpmError } from "../src/errors.ts";

// Real, published test vectors: sha512("abc") and sha1("abc").
const ABC_SHA512_HEX =
  "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f";
const ABC_SHA1_HEX = "a9993e364706816aba3e25717850c26c9cd0d89d";

function hashedABC(): ReturnType<IntegrityHasher["finalize"]> {
  const hasher = new IntegrityHasher();
  hasher.update(Buffer.from("abc"));
  return hasher.finalize();
}

describe("IntegrityHasher", () => {
  it("matches published sha512 and sha1 vectors", () => {
    const hashed = hashedABC();
    expect(hashed.sha512Hex).toBe(ABC_SHA512_HEX);
    expect(hashed.sha1Hex).toBe(ABC_SHA1_HEX);
    expect(hashed.shasum).toBe(ABC_SHA1_HEX);
    expect(hashed.sha512Base64).toBe(base64FromHex(ABC_SHA512_HEX));
    expect(hashed.sha512Sri).toBe(`sha512-${base64FromHex(ABC_SHA512_HEX)}`);
    expect(hashed.bytes).toBe(3);
  });

  it("counts bytes across chunked updates", () => {
    const hasher = new IntegrityHasher();
    hasher.update(Buffer.from("a"));
    hasher.update(Buffer.from("b"));
    hasher.update(Buffer.from("c"));
    const hashed = hasher.finalize();
    expect(hashed.bytes).toBe(3);
    expect(hashed.sha512Hex).toBe(ABC_SHA512_HEX);
  });

  it("refuses use after finalize", () => {
    const hasher = new IntegrityHasher();
    hasher.finalize();
    expect(() => hasher.update(Buffer.from("x"))).toThrow(SnpmError);
  });
});

describe("parseSri", () => {
  it("parses a well-formed entry", () => {
    const parsed = parseSri(`sha512-${base64FromHex(ABC_SHA512_HEX)}`);
    expect(parsed.valid).toBe(true);
    expect(parsed.strongest?.algorithm).toBe("sha512");
  });

  it("normalizes base64url input", () => {
    const standard = base64FromHex(ABC_SHA512_HEX);
    const url = standard.replaceAll("+", "-").replaceAll("/", "_");
    const parsed = parseSri(`sha512-${url}`);
    expect(parsed.valid).toBe(true);
    expect(parsed.strongest?.digestBase64).toBe(standard);
  });

  it("rejects malformed strings", () => {
    expect(parseSri("").valid).toBe(false);
    expect(parseSri("sha512").valid).toBe(false);
    expect(parseSri("sha512-").valid).toBe(false);
    expect(parseSri("md5-abcd").valid).toBe(false);
    expect(parseSri("sha512-not/base64!").valid).toBe(false);
  });

  it("picks the strongest algorithm from several entries", () => {
    const parsed = parseSri(`sha1-${base64FromHex(ABC_SHA1_HEX)} sha512-${base64FromHex(ABC_SHA512_HEX)}`);
    expect(parsed.strongest?.algorithm).toBe("sha512");
  });
});

describe("checkIntegrity and assertIntegrityOk", () => {
  const hashed = hashedABC();

  it("verifies a matching sha512", () => {
    const outcome = checkIntegrity(hashed, formatSri("sha512", hashed.sha512Base64));
    expect(outcome.status).toBe("verified");
    expect(assertIntegrityOk(hashed, hashed.sha512Sri, { what: "test" }).verifiedSri).toBe(hashed.sha512Sri);
  });

  it("reports a mismatch without accepting it", () => {
    const wrong = formatSri("sha512", base64FromHex("00".repeat(64)));
    const outcome = checkIntegrity(hashed, wrong);
    expect(outcome.status).toBe("mismatch");
    expect(() => assertIntegrityOk(hashed, wrong, { what: "tarball x" })).toThrow(SnpmError);
    try {
      assertIntegrityOk(hashed, wrong, { what: "tarball x" });
    } catch (error) {
      expect((error as SnpmError).code).toBe("SNPM_INTEGRITY_FAILED");
    }
  });

  it("verifies sha1 only when weak integrity is explicitly allowed", () => {
    const weak = formatSri("sha1", base64FromHex(ABC_SHA1_HEX));
    expect(checkIntegrity(hashed, weak).status).toBe("weak-verified");
    expect(() => assertIntegrityOk(hashed, weak, { what: "tarball x" })).toThrow(SnpmError);
    const allowed = assertIntegrityOk(hashed, weak, { what: "tarball x", allowWeak: true });
    expect(allowed.weak).toBe(true);
    expect(allowed.verifiedSri).toBe(weak);
  });

  it("treats missing integrity as unacceptable unless explicitly allowed", () => {
    expect(checkIntegrity(hashed, undefined).status).toBe("no-expected-integrity");
    expect(() => assertIntegrityOk(hashed, undefined, { what: "tarball x" })).toThrow(SnpmError);
    const allowed = assertIntegrityOk(hashed, undefined, { what: "tarball x", allowMissing: true });
    expect(allowed.verifiedSri).toBe(hashed.sha512Sri);
  });

  it("rejects malformed integrity strings rather than guessing", () => {
    expect(checkIntegrity(hashed, "garbage").status).toBe("malformed");
    expect(() => assertIntegrityOk(hashed, "garbage", { what: "tarball x" })).toThrow(SnpmError);
  });
});
