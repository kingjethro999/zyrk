/**
 * Registry adapter (SPEC 13.1-13.3). Fetches metadata and tarballs through
 * npm-maintained libraries behind a typed surface with snpm's own policy:
 * bounded retries, bounded download size, mandatory integrity verification of
 * the bytes we accept, and stable error mapping.
 *
 * This adapter never runs package code. Credential handling is deliberately
 * not implemented yet: callers may pass through fetch options (an .npmrc-
 * reading adapter lands later with its own review), and nothing here can
 * disable TLS verification.
 */

import { open, rm } from "node:fs/promises";
import regFetch, { json as fetchJson, type FetchOptions } from "npm-registry-fetch";
import { SnpmError } from "../errors.ts";
import type { Logger } from "../log.ts";
import { assertIntegrityOk, IntegrityHasher, base64FromHex, type HashedBytes } from "../util/integrity.ts";

/** 512 MiB: large for an npm package, small enough to bound mishaps. */
export const DEFAULT_MAX_TARBALL_BYTES = 512 * 1024 * 1024;

/** npm's abbreviated packument media type, used for installs. */
const INSTALL_V1_ACCEPT = "application/vnd.npm.install-v1+json";

export interface PackumentDist {
  tarball: string;
  integrity?: string;
  shasum?: string;
  unpackedSize?: number;
  fileCount?: number;
}

export interface PackumentVersion {
  name: string;
  version: string;
  dist: PackumentDist;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  bundledDependencies?: string[] | boolean;
  bin?: string | Record<string, string>;
  os?: string[];
  cpu?: string[];
  libc?: string[];
  engines?: Record<string, string>;
  deprecated?: string;
  hasInstallScript?: boolean;
}

export interface Packument {
  name: string;
  distTags: Record<string, string>;
  versions: Record<string, PackumentVersion>;
  modified?: string;
}

export interface RegistryClientOptions {
  /** Registry base URL; must be http(s). Trailing slash optional. */
  registry: string;
  userAgent: string;
  logger?: Logger;
  /** Bounded retries for retryable transport failures (default 2). */
  retries?: number;
  /** Per-request inactivity timeout in ms; passed through when set. */
  timeoutMs?: number;
  maxTarballBytes?: number;
  /** Extra options for npm-registry-fetch. Never includes anything unsafe by default. */
  fetchOptions?: FetchOptions;
}

export interface DownloadResult {
  url: string;
  bytes: number;
  hashed: HashedBytes;
  /** The digest accepted as the verified integrity for this download. */
  verifiedSri: string;
  /** True when only legacy sha1 integrity was available and accepted. */
  weakIntegrity: boolean;
}

export class RegistryClient {
  readonly #registry: string;
  readonly #origin: string;
  readonly #userAgent: string;
  readonly #logger: Logger | undefined;
  readonly #fetchOptions: FetchOptions;
  readonly #maxTarballBytes: number;

  constructor(options: RegistryClientOptions) {
    const registry = normalizeRegistryUrl(options.registry);
    this.#registry = registry;
    this.#origin = credentialFreeOrigin(registry);
    this.#userAgent = options.userAgent;
    this.#logger = options.logger;
    this.#maxTarballBytes = options.maxTarballBytes ?? DEFAULT_MAX_TARBALL_BYTES;

    const retries = options.retries ?? 2;
    const base: FetchOptions = {
      registry,
      userAgent: options.userAgent,
      retry: { retries, factor: 2, minTimeout: 250, maxTimeout: 8_000, randomize: true },
    };
    if (options.timeoutMs !== undefined) base.timeout = options.timeoutMs;
    this.#fetchOptions = { ...base, ...options.fetchOptions };
  }

  /** Credential-free registry origin; participates in source identity (§8.1). */
  get origin(): string {
    return this.#origin;
  }

  get registry(): string {
    return this.#registry;
  }

  /** Fetch the (abbreviated) packument for an exact package name. */
  async packument(name: string): Promise<Packument> {
    validateRegistryPackageName(name);
    const url = `${this.#registry}${escapePackageName(name)}`;
    this.#logger?.debug("fetching packument", { name, url });
    let raw: unknown;
    try {
      raw = await fetchJson(url, {
        ...this.#fetchOptions,
        headers: { accept: `${INSTALL_V1_ACCEPT}, application/json` },
      });
    } catch (error) {
      throw mapFetchError(error, `fetch metadata for ${name}`);
    }
    return validatePackument(raw, name, this.#origin);
  }

  /**
   * Download a tarball to `destPath` (which is owned by the caller's
   * transaction staging and must not exist), verify its integrity, and
   * fsync it. The file is removed on any failure.
   */
  async downloadTarball(options: {
    url: string;
    /** Expected SRI. When undefined, strict callers must reject the download. */
    expectedIntegrity: string | undefined;
    destPath: string;
    /** Human label used in errors, e.g. `foo@1.2.3`. */
    label: string;
    maxBytes?: number;
    allowWeakIntegrity?: boolean;
    allowMissingIntegrity?: boolean;
  }): Promise<DownloadResult> {
    const parsedUrl = parseTarballUrl(options.url, options.label);
    const maxBytes = options.maxBytes ?? this.#maxTarballBytes;
    this.#logger?.debug("downloading tarball", { label: options.label, url: parsedUrl.href });

    let handle;
    try {
      handle = await open(options.destPath, "wx", 0o600);
    } catch (error) {
      if (isErrnoCode(error, "EEXIST")) {
        throw new SnpmError("SNPM_INTERNAL", `staging file already exists: ${options.destPath}`, {
          detail: { destPath: options.destPath },
        });
      }
      throw error;
    }

    const hasher = new IntegrityHasher();
    const startedAt = Date.now();
    try {
      const response = await regFetch(parsedUrl.href, {
        ...this.#fetchOptions,
        headers: { accept: "application/octet-stream" },
      });
      if (!response.ok) {
        // Drain a little of the body so the connection can be reused, then
        // report by status.
        response.body.resume();
        throw httpStatusError(response.status, `download tarball for ${options.label}`, options.url);
      }

      let written = 0;
      for await (const chunk of response.body) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        written += buffer.byteLength;
        if (written > maxBytes) {
          response.body.destroy();
          throw new SnpmError(
            "SNPM_FETCH_REFUSED",
            `tarball for ${options.label} exceeds the ${formatMiB(maxBytes)} download bound`,
            {
              detail: { label: options.label, url: options.url, limitBytes: maxBytes },
              remedy: "verify this is the package you expect; raise the bound deliberately if the artifact is legitimate",
            },
          );
        }
        hasher.update(buffer);
        await handle.write(buffer);
      }

      await handle.sync();
      await handle.close();
      handle = undefined;

      const hashed = hasher.finalize();
      let verified: { verifiedSri: string; weak: boolean };
      try {
        verified = assertIntegrityOk(hashed, options.expectedIntegrity, {
          what: `tarball for ${options.label}`,
          ...(options.allowWeakIntegrity === undefined ? {} : { allowWeak: options.allowWeakIntegrity }),
          ...(options.allowMissingIntegrity === undefined ? {} : { allowMissing: options.allowMissingIntegrity }),
        });
      } catch (error) {
        await rm(options.destPath, { force: true });
        throw error;
      }

      this.#logger?.debug("tarball verified", {
        label: options.label,
        bytes: hashed.bytes,
        ms: Date.now() - startedAt,
        weakIntegrity: verified.weak,
      });

      return {
        url: parsedUrl.href,
        bytes: hashed.bytes,
        hashed,
        verifiedSri: verified.verifiedSri,
        weakIntegrity: verified.weak,
      };
    } catch (error) {
      if (handle !== undefined) {
        try {
          await handle.close();
        } catch {
          // The original failure is more useful.
        }
      }
      await rm(options.destPath, { force: true });
      throw mapFetchError(error, `download tarball for ${options.label}`);
    }
  }
}

/**
 * Pick the expected integrity string from dist metadata: prefer SRI, fall
 * back to synthesizing sha1 from the legacy `shasum` field.
 */
export function expectedIntegrityFromDist(dist: PackumentDist): string | undefined {
  if (typeof dist.integrity === "string" && dist.integrity.trim() !== "") {
    return dist.integrity;
  }
  if (typeof dist.shasum === "string" && /^[0-9a-f]{40}$/.test(dist.shasum)) {
    return `sha1-${base64FromHex(dist.shasum)}`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------

function normalizeRegistryUrl(registry: string): string {
  let url: URL;
  try {
    url = new URL(registry);
  } catch (error) {
    throw new SnpmError("SNPM_MANIFEST_INVALID", `registry URL is not valid: ${registry}`, {
      remedy: "set a registry URL such as https://registry.npmjs.org/",
      cause: error,
    });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new SnpmError("SNPM_MANIFEST_INVALID", `registry URL must be http(s): ${registry}`, {
      remedy: "set an http(s) registry URL",
    });
  }
  if (url.username !== "" || url.password !== "") {
    throw new SnpmError(
      "SNPM_MANIFEST_INVALID",
      "registry URL must not embed credentials",
      {
        remedy: "configure credentials through the supported auth adapter instead of the URL",
      },
    );
  }
  url.search = "";
  url.hash = "";
  const href = url.href.endsWith("/") ? url.href : `${url.href}/`;
  return href;
}

/** scheme://host[:port][/path] with credentials, query and fragment removed. */
function credentialFreeOrigin(registry: string): string {
  const url = new URL(registry);
  const path = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  return `${url.protocol}//${url.host}${path}`;
}

/**
 * Reject package names that cannot be safely interpolated into a registry
 * URL. Registry names are a restricted charset; anything else is a caller
 * bug or an attack, not a package.
 */
export function validateRegistryPackageName(name: string): void {
  const bad = (why: string): never => {
    throw new SnpmError("SNPM_RESOLUTION_FAILED", `invalid package name "${name}" (${why})`, {
      remedy: "use a real npm package name",
    });
  };
  if (name === "" || name.length > 214) bad("empty or too long");
  if (name.includes("\\") || name.includes("%") || name.includes("\0")) bad("forbidden character");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0020\u007f]/.test(name)) bad("control or whitespace character");
  if (!/^(?:@[^/@]+\/)?[^/@]+$/.test(name)) bad("shape is not `name` or `@scope/name`");
  for (const segment of name.split("/")) {
    if (segment === "." || segment === "..") bad("path-like segment");
  }
}

function escapePackageName(name: string): string {
  return name.replace("/", "%2f");
}

function parseTarballUrl(url: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (error) {
    throw new SnpmError("SNPM_FETCH_REFUSED", `registry metadata for ${label} has an invalid tarball URL`, {
      detail: { label, url },
      remedy: "report the registry response; snpm refuses to fetch a malformed URL",
      cause: error,
    });
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new SnpmError("SNPM_FETCH_REFUSED", `tarball URL for ${label} uses unsupported protocol ${parsed.protocol}`, {
      detail: { label, url },
      remedy: "only http(s) tarball URLs are supported",
    });
  }
  return parsed;
}

function formatMiB(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MiB`;
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === code
  );
}

const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "EPROTO",
  "ERR_SSL_PROTOCOL_ERROR",
]);

/**
 * Map library/transport errors to stable codes. Keeps the library's message
 * and status available in `detail` without dumping config or headers.
 */
function mapFetchError(error: unknown, what: string): SnpmError {
  if (error instanceof SnpmError) return error;

  const record = (error ?? {}) as {
    message?: unknown;
    code?: unknown;
    statusCode?: unknown;
    errno?: unknown;
  };
  const message = typeof record.message === "string" ? record.message : String(error);
  const status = typeof record.statusCode === "number" ? record.statusCode : undefined;
  const code = typeof record.code === "string" ? record.code : undefined;

  if (status === 401 || status === 403 || code === "EOTP") {
    return new SnpmError("SNPM_REGISTRY_AUTH", `registry authorization failed while trying to ${what}`, {
      detail: { status, code },
      remedy: "verify the credentials configured for this registry (and their scope); snpm never falls back to the public registry",
      cause: error,
    });
  }
  if (status !== undefined) {
    return httpStatusError(status, what, undefined, error);
  }
  if (code !== undefined && RETRYABLE_NETWORK_CODES.has(code)) {
    return new SnpmError("SNPM_FETCH_FAILED", `network failure while trying to ${what}: ${message}`, {
      detail: { errno: code },
      remedy: "check network connectivity and registry availability, then retry",
      cause: error,
    });
  }
  return new SnpmError("SNPM_FETCH_FAILED", `failed to ${what}: ${message}`, {
    ...(code === undefined ? {} : { detail: { errno: code } }),
    remedy: "check registry availability, then retry",
    cause: error,
  });
}

function httpStatusError(status: number, what: string, url?: string, cause?: unknown): SnpmError {
  const detail: Record<string, unknown> = { status };
  if (url !== undefined) detail.url = url;
  if (status === 404) {
    return new SnpmError("SNPM_RESOLUTION_FAILED", `not found while trying to ${what} (HTTP 404)`, {
      detail,
      remedy: "verify the package name or version exists in the configured registry",
      ...(cause === undefined ? {} : { cause }),
    });
  }
  if (status === 401 || status === 403) {
    return new SnpmError("SNPM_REGISTRY_AUTH", `registry authorization failed while trying to ${what} (HTTP ${status})`, {
      detail,
      remedy: "verify the credentials configured for this registry",
      ...(cause === undefined ? {} : { cause }),
    });
  }
  return new SnpmError("SNPM_FETCH_FAILED", `registry responded HTTP ${status} while trying to ${what}`, {
    detail,
    remedy: "retry later; if it persists, check the registry's status",
    ...(cause === undefined ? {} : { cause }),
  });
}

function validatePackument(raw: unknown, requestedName: string, origin: string): Packument {
  const bad = (why: string): never => {
    throw new SnpmError("SNPM_RESOLUTION_FAILED", `registry returned a malformed packument for ${requestedName} (${why})`, {
      detail: { name: requestedName, origin },
      remedy: "report the registry response; retry against a well-formed npm registry",
    });
  };
  if (typeof raw !== "object" || raw === null) bad("not an object");
  const doc = raw as Record<string, unknown>;
  if (typeof doc["name"] !== "string") bad("missing name");
  if ((doc["name"] as string).toLowerCase() !== requestedName.toLowerCase()) {
    bad(`name mismatch: asked for ${requestedName}, got ${doc["name"] as string}`);
  }
  const versionsRaw = doc["versions"];
  if (typeof versionsRaw !== "object" || versionsRaw === null || Array.isArray(versionsRaw)) {
    bad("missing versions map");
  }
  const distTagsRaw = doc["dist-tags"] ?? doc["distTags"];
  if (distTagsRaw !== undefined && (typeof distTagsRaw !== "object" || distTagsRaw === null)) {
    bad("dist-tags is not an object");
  }

  const versions: Record<string, PackumentVersion> = {};
  for (const [version, value] of Object.entries(versionsRaw as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) bad(`version ${version} is not an object`);
    const entry = value as Record<string, unknown>;
    if (entry["version"] !== undefined && entry["version"] !== version) {
      bad(`version key ${version} disagrees with entry version ${String(entry["version"])}`);
    }
    const dist = entry["dist"];
    if (typeof dist !== "object" || dist === null) bad(`version ${version} has no dist block`);
    const distRecord = dist as Record<string, unknown>;
    if (typeof distRecord["tarball"] !== "string" || distRecord["tarball"] === "") {
      bad(`version ${version} has no tarball URL`);
    }
    versions[version] = {
      ...(entry as unknown as PackumentVersion),
      name: typeof entry["name"] === "string" ? entry["name"] : requestedName,
      version,
      dist: dist as unknown as PackumentDist,
    };
  }

  const distTags: Record<string, string> = {};
  if (distTagsRaw !== undefined) {
    for (const [tag, target] of Object.entries(distTagsRaw as Record<string, unknown>)) {
      if (typeof target === "string") distTags[tag] = target;
    }
  }

  const packument: Packument = { name: requestedName, distTags, versions };
  if (typeof doc["modified"] === "string") packument.modified = doc["modified"];
  return packument;
}
