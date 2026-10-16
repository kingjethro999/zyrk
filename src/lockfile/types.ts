/**
 * package-lock.json with a namespaced nexu extension (D-1).
 *
 * nexu reads and writes the same `package-lock.json` as npm. All npm-owned
 * fields are preserved opaquely: the writer never deletes or reinterprets
 * them, and the nexu extension lives under one top-level `nexu` key that
 * npm's own loader carries through untouched (verified against the pinned
 * npm's @npmcli/arborist `shrinkwrap.js load()`, which spreads unknown
 * top-level fields into its data object and only reads the keys it knows).
 *
 * The extension records everything a frozen reinstall needs that npm's
 * format cannot express: exact resolved graph with peer bindings and
 * aliases, canonical source identities, and the fingerprints that detect
 * manifest, policy, or configuration drift.
 */

export const NEXU_LOCK_EXTENSION_VERSION = 1;

/** Opaque npm package entry: preserved byte-identically, never interpreted. */
export type NpmPackageEntry = Record<string, unknown>;

export type NpmLockDoc = {
  name?: string;
  version?: string;
  lockfileVersion?: number;
  requires?: boolean;
  packages?: Record<string, NpmPackageEntry>;
  dependencies?: Record<string, unknown>;
  nexu?: NexuLockExtension;
  [key: string]: unknown;
};

export type NexuLockNode = {
  name: string;
  version: string;
  /** Expected tarball integrity (mirrors the npm entry). */
  integrity: string;
  /** Credential-free registry origin (SPEC 8.1). */
  origin: string;
  /** Canonical source identity. */
  source: string;
  /** Dependency edge name -> occurrence key (alias-aware). */
  edges: Record<string, string>;
  /** Edge name -> prod | optional | peer. */
  edgeKinds: Record<string, "prod" | "optional" | "peer">;
  /** Peer name -> occurrence key, or null for absent optional peers. */
  peers: Record<string, string | null>;
};

export type NexuLockExtension = {
  /** Extension schema version; newer writers are rejected, never guessed. */
  version: number;
  /** Resolver-policy version that produced this lock. */
  resolver: string;
  /** Context canonicalization version (mirrors the store format marker). */
  contextCanonicalization: number;
  /** Fingerprint of the importer manifests this lock was written from. */
  manifest: string;
  /** Portable project script-policy fingerprint. */
  scripts: string;
  /** Resolution-affecting configuration fingerprint. */
  config: string;
  /** Occurrence key -> resolved node, sorted by key at write time. */
  nodes: Record<string, NexuLockNode>;
  /** Importer ("." for the root) -> direct dep name -> occurrence key. */
  roots: Record<string, Record<string, string>>;
  [key: string]: unknown;
};

export const NEXU_RESOLVER_POLICY = "nexu-resolve/1";
