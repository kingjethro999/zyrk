import { createHash, type Hash } from "node:crypto";
import { canonicalJson } from "./json.ts";
import { EXTRACTION_POLICY_VERSION, OBJECT_KEY_SCHEME } from "../version.ts";

/** Normalized mode classes; the static pair stored in the CAS key (SPEC 8.2). */
export type ModeClass = "plain" | "exec";

export function modeClassOf(mode: number): ModeClass {
  return (mode & 0o111) !== 0 ? "exec" : "plain";
}

/** On-disk permission for a mode class in committed, read-only content. */
export function committedMode(classOf: ModeClass): number {
  return classOf === "exec" ? 0o555 : 0o444;
}

export function modeOfClass(classOf: ModeClass): number {
  return classOf === "exec" ? 0o755 : 0o644;
}

export class Digest {
  readonly #hash: Hash;
  readonly algorithm: "sha512";

  constructor(algorithm: "sha512" = "sha512") {
    this.algorithm = algorithm;
    this.#hash = createHash(algorithm);
  }

  update(chunk: Uint8Array | string): this {
    this.#hash.update(chunk);
    return this;
  }

  hex(): string {
    return this.#hash.digest("hex");
  }
}

export function sha512Hex(data: Uint8Array | string): string {
  return createHash("sha512").update(data).digest("hex");
}

/**
 * Object key for the content-addressed store. The key covers the normalized
 * mode class so that an executable file and a non-executable file with the
 * same bytes can never share an inode whose permissions are later changed
 * (SPEC 8.2). `innerDigestHex` is the sha512 of the raw bytes.
 */
export function objectIdOf(modeClass: ModeClass, innerDigestHex: string): string {
  const prefix = Buffer.from(`${OBJECT_KEY_SCHEME}\u0000${modeClass}\u0000`, "utf8");
  return sha512Hex(Buffer.concat([prefix, Buffer.from(innerDigestHex, "ascii")]));
}

/**
 * Source identity (SPEC 8.1 layer 4): verified archive plus extraction-format
 * version. The credential-free origin participates so a public and a private
 * registry publishing the same name/version are distinct trusted identities.
 */
export type SourceIdentityInput = {
  sourceType: "registry";
  name: string;
  version: string;
  origin: string;
  integrity: string;
};

export function sourceIdOf(identity: SourceIdentityInput): string {
  const digest = sha512Hex(
    canonicalJson({
      sourceType: identity.sourceType,
      name: identity.name,
      version: identity.version,
      origin: identity.origin,
      integrity: identity.integrity,
      extractionPolicyVersion: EXTRACTION_POLICY_VERSION,
    }),
  );
  return `src1_${digest.slice(0, 40)}`;
}

/**
 * Manifest hash: the digest that identifies the exact accepted content of a
 * source. Computed over canonical JSON of the manifest content block only, so
 * provenance (verification time) can change without changing identity.
 */
export function manifestHashOf(manifestContent: unknown): string {
  return sha512Hex(canonicalJson(manifestContent));
}
