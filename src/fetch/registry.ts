/**
 * Registry adapter (SPEC 13.1-13.3). Fetches metadata and tarballs through
 * npm-maintained libraries behind a typed surface with zyrk's own policy:
 * bounded retries, bounded download size, mandatory integrity verification of
 * the bytes we accept, and stable error mapping.
 *
 * This adapter never runs package code. Credentials are attached by this
 * adapter only within their full origin and path; each redirect is reviewed
 * before another request. Transport options cannot weaken mandatory TLS.
 */

import { open, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import type { Readable } from "node:stream";
import type { FetchOptions } from "npm-registry-fetch";

import { ZyrkError } from "../errors.ts";
import type { Logger } from "../log.ts";
import {
  assertIntegrityOk,
  canonicalStrongSri,
  IntegrityHasher,
  base64FromHex,
  type HashedBytes,
} from "../util/integrity.ts";

interface RegistryResponse {
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  body: Readable;
}
// npm-maintained transport; redirects are deliberately owned by this adapter.
const transport = createRequire(import.meta.url)("make-fetch-happen") as (
  url: string,
  options: Record<string, unknown>,
) => Promise<RegistryResponse>;

/** 512 MiB: large for an npm package, small enough to bound mishaps. */
export const DEFAULT_MAX_TARBALL_BYTES = 512 * 1024 * 1024;

/** Bounds the complete metadata closure while allowing large framework graphs. */
export const DEFAULT_MAX_TOTAL_METADATA_BYTES = 256 * 1024 * 1024;

/** Fifteen minutes per registry operation, including archive transfer. */
export const DEFAULT_REQUEST_DEADLINE_MS = 900_000;

/** Default registry for tool environments (SPEC 13.1). */
export const DEFAULT_REGISTRY = "https://registry.npmjs.org/";

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
  scopedRegistries?: Readonly<Record<string, string>>;
  /** Registry base URL; must be http(s). Trailing slash optional. */
  registry: string;
  userAgent: string;
  logger?: Logger;
  /** Bounded retries for retryable transport failures (default 2). */
  retries?: number;
  /** Per-request inactivity timeout in ms; passed through when set. */
  timeoutMs?: number;
  maxTarballBytes?: number;
  /** Allowlisted transport settings and URL-scoped npm credentials. */
  fetchOptions?: FetchOptions;
  /** Decoded metadata bytes, counted before JSON.parse. */
  maxMetadataBytes?: number;
  /** Total decoded metadata work across this client invocation. */
  maxTotalMetadataBytes?: number;
  maxMetadataVersions?: number;
  /** End-to-end deadline across retries, redirects and body consumption. */
  requestDeadlineMs?: number;
  signal?: AbortSignal;
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
  #routeBoundaries: readonly URL[] = [];
  readonly #scopedClients = new Map<string, RegistryClient>();
  readonly #registry: string;
  readonly #origin: string;
  readonly #userAgent: string;
  readonly #logger: Logger | undefined;
  readonly #fetchOptions: FetchOptions;
  readonly #maxTarballBytes: number;
  readonly #maxMetadataBytes: number;
  readonly #maxTotalMetadataBytes: number;
  #metadataBudget = { bytes: 0 };
  readonly #maxMetadataVersions: number;
  readonly #requestDeadlineMs: number;
  readonly #signal: AbortSignal | undefined;
  #credentials: Array<{ scope: URL; authorization: string }>;

  constructor(options: RegistryClientOptions) {
    const registry = normalizeRegistryUrl(options.registry);
    this.#registry = registry;
    this.#origin = credentialFreeOrigin(registry);
    this.#userAgent = options.userAgent;
    this.#logger = options.logger;
    this.#maxTarballBytes =
      options.maxTarballBytes ?? DEFAULT_MAX_TARBALL_BYTES;

    const retries = options.retries ?? 2;
    const base: FetchOptions = {
      registry,
      userAgent: options.userAgent,
      retry: {
        retries,
        factor: 2,
        minTimeout: 250,
        maxTimeout: 8_000,
        randomize: true,
      },
    };
    if (options.timeoutMs !== undefined) base.timeout = options.timeoutMs;
    const parsed = safeTransportOptions(options.fetchOptions ?? {}, registry);
    this.#fetchOptions = { ...base, ...parsed.transport, strictSSL: true };
    const boundary = new URL(registry);
    this.#credentials = parsed.credentials.filter(
      ({ scope }) =>
        scope.origin === boundary.origin &&
        (scope.pathname.startsWith(boundary.pathname) ||
          boundary.pathname.startsWith(scope.pathname)),
    );
    this.#maxMetadataBytes = positiveLimit(
      options.maxMetadataBytes ?? 32 * 1024 * 1024,
      "maxMetadataBytes",
    );
    this.#maxTotalMetadataBytes = positiveLimit(
      options.maxTotalMetadataBytes ?? DEFAULT_MAX_TOTAL_METADATA_BYTES,
      "maxTotalMetadataBytes",
    );
    this.#maxMetadataVersions = positiveLimit(
      options.maxMetadataVersions ?? 100_000,
      "maxMetadataVersions",
    );
    this.#requestDeadlineMs = positiveLimit(
      options.requestDeadlineMs ?? DEFAULT_REQUEST_DEADLINE_MS,
      "requestDeadlineMs",
    );
    positiveLimit(this.#maxTarballBytes, "maxTarballBytes");
    this.#signal = options.signal;
    const { scopedRegistries, ...baseOptions } = options;
    for (const [scope, selected] of Object.entries(scopedRegistries ?? {}).sort(
      ([a], [b]) => a.localeCompare(b),
    )) {
      if (!/^@[a-z0-9][a-z0-9._-]*$/.test(scope))
        throw new ZyrkError(
          "ZYRK_POLICY_DENIED",
          "Invalid scoped registry name.",
          { remedy: "Use an npm @scope registry setting." },
        );
      const { headers, ...childFetchOptions } = options.fetchOptions ?? {};
      const client = new RegistryClient({
        ...baseOptions,
        fetchOptions: childFetchOptions,
        registry: selected,
      });
      // Raw Authorization headers are scoped once to the original registry.
      // Cloning must never reinterpret them as credentials for a child host.
      for (const authorization of Object.values(
        (headers ?? {}) as Record<string, string>,
      )) {
        const originalScope = new URL(registry),
          childScope = new URL(client.registry);
        if (
          originalScope.origin === childScope.origin &&
          (originalScope.pathname.startsWith(childScope.pathname) ||
            childScope.pathname.startsWith(originalScope.pathname))
        )
          client.#credentials.push({ scope: originalScope, authorization });
      }
      client.#credentials.sort(
        (a, b) => b.scope.pathname.length - a.scope.pathname.length,
      );
      client.#metadataBudget = this.#metadataBudget;
      this.#scopedClients.set(scope, client);
    }
    // A containing public registry must not borrow a credential belonging to a
    // narrower configured private registry on the same host. Explicit broad
    // credentials retain their declared scope, including use by child routes.
    const clients = [this, ...this.#scopedClients.values()];
    const boundaries = clients.map((client) => new URL(client.registry));
    for (const client of clients) {
      const own = new URL(client.registry);
      client.#routeBoundaries = boundaries;
      client.#credentials = client.#credentials.filter(
        ({ scope }) =>
          !boundaries.some(
            (boundary) =>
              boundary.origin === scope.origin &&
              boundary.pathname.length > own.pathname.length &&
              scope.pathname.startsWith(boundary.pathname),
          ),
      );
    }
  }

  /** Credential-free registry origin; participates in source identity (§8.1). */
  get origin(): string {
    return this.#origin;
  }

  get registry(): string {
    return this.#registry;
  }

  /** Routing always follows the real package name, including npm aliases. */
  forPackage(name: string): RegistryClient {
    validateRegistryPackageName(name);
    return name.startsWith("@")
      ? (this.#scopedClients.get(name.slice(0, name.indexOf("/"))) ?? this)
      : this;
  }
  originFor(name: string): string {
    return this.forPackage(name).origin;
  }
  get scopedRegistries(): Readonly<Record<string, string>> {
    return Object.fromEntries(
      [...this.#scopedClients].map(([scope, client]) => [scope, client.origin]),
    );
  }

  /** Fetch the (abbreviated) packument for an exact package name. */
  async packument(
    name: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<Packument> {
    const selected = this.forPackage(name);
    if (selected !== this) return selected.packument(name, options);
    const url = `${this.#registry}${escapePackageName(name)}`;
    this.#logger?.debug("fetching packument", { name, url });
    let raw: unknown;
    try {
      raw = await this.#withRequest(
        url,
        `${INSTALL_V1_ACCEPT}, application/json`,
        (response) => this.#readMetadata(response),
        options.signal,
      );
    } catch (error) {
      throw mapFetchError(error, `fetch metadata for ${name}`);
    }
    return validatePackument(
      raw,
      name,
      this.#origin,
      this.#maxMetadataVersions,
    );
  }

  /** Fetch one exact version without transferring every release in a packument. */
  async versionManifest(
    name: string,
    version: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<PackumentVersion> {
    const selected = this.forPackage(name);
    if (selected !== this)
      return selected.versionManifest(name, version, options);
    const url = `${this.#registry}${escapePackageName(name)}/${encodeURIComponent(version)}`;
    this.#logger?.debug("fetching exact version metadata", {
      name,
      version,
      url,
    });
    let raw: unknown;
    try {
      raw = await this.#withRequest(
        url,
        `${INSTALL_V1_ACCEPT}, application/json`,
        (response) => this.#readMetadata(response),
        options.signal,
      );
    } catch (error) {
      throw mapFetchError(error, `fetch metadata for ${name}@${version}`);
    }
    const validated = validatePackument(
      { name, versions: { [version]: raw } },
      name,
      this.#origin,
      1,
    );
    const entry = validated.versions[version];
    if (entry === undefined)
      throw new ZyrkError(
        "ZYRK_RESOLUTION_FAILED",
        `registry has no version ${version} of ${name}`,
        {
          detail: { name, version },
          remedy:
            "check the requested version exists in the configured registry",
        },
      );
    return entry;
  }

  /** Registry advisory request; private names may never follow an external redirect. */
  async auditAdvisories(
    packages: Readonly<Record<string, readonly string[]>>,
    options: { signal?: AbortSignal } = {},
  ): Promise<unknown> {
    for (const [name, versions] of Object.entries(packages)) {
      validateRegistryPackageName(name);
      if (
        !Array.isArray(versions) ||
        versions.some((version) => typeof version !== "string")
      )
        throw new ZyrkError(
          "ZYRK_POLICY_DENIED",
          "Invalid registry advisory package versions.",
        );
    }
    const routes = new Set(
      Object.keys(packages).map((name) => this.forPackage(name)),
    );
    if (routes.size > 1)
      throw new ZyrkError(
        "ZYRK_POLICY_DENIED",
        "Mixed-registry audit requests must be partitioned by registry.",
        {
          remedy:
            "Audit each selected registry independently so private names are never disclosed across origins.",
        },
      );
    const selected = [...routes][0];
    if (selected && selected !== this)
      return selected.auditAdvisories(packages, options);
    const body = JSON.stringify(packages);
    if (Buffer.byteLength(body) > this.#maxMetadataBytes)
      throw resourceLimit(
        "advisory request bytes",
        this.#maxMetadataBytes,
        "maxMetadataBytes",
      );
    try {
      return await this.#withRequest(
        new URL("-/npm/v1/security/advisories/bulk", this.#registry).href,
        "application/json",
        (response) => this.#readMetadata(response),
        options.signal,
        { method: "POST", body },
      );
    } catch (error) {
      throw mapFetchError(error, "fetch security advisories");
    }
  }

  #countMetadataBytes(bytes: number, responseBytes: number): void {
    this.#metadataBudget.bytes += bytes;
    if (responseBytes > this.#maxMetadataBytes)
      throw resourceLimit(
        "metadata bytes",
        this.#maxMetadataBytes,
        "maxMetadataBytes",
      );
    if (this.#metadataBudget.bytes > this.#maxTotalMetadataBytes)
      throw resourceLimit(
        "total metadata bytes",
        this.#maxTotalMetadataBytes,
        "maxTotalMetadataBytes",
      );
  }

  async #readMetadata(response: RegistryResponse): Promise<unknown> {
    const buffers: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk as Uint8Array);
      bytes += buffer.length;
      this.#countMetadataBytes(buffer.length, bytes);
      buffers.push(buffer);
    }
    try {
      return JSON.parse(Buffer.concat(buffers).toString("utf8")) as unknown;
    } catch {
      throw new ZyrkError(
        "ZYRK_RESOLUTION_FAILED",
        "Registry returned invalid metadata JSON.",
        { remedy: "Retry against a well-formed npm registry." },
      );
    }
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
    signal?: AbortSignal;
    /** Receives each chunk byte count before staging writes; may throw to abort. */
    onBytes?: (bytes: number) => void;
  }): Promise<DownloadResult> {
    const parsedUrl = parseTarballUrl(options.url, options.label);
    const maxBytes = options.maxBytes ?? this.#maxTarballBytes;
    this.#logger?.debug("downloading tarball", {
      label: options.label,
      url: parsedUrl.href,
    });

    let handle;
    try {
      handle = await open(options.destPath, "wx", 0o600);
    } catch (error) {
      if (isErrnoCode(error, "EEXIST")) {
        throw new ZyrkError(
          "ZYRK_INTERNAL",
          "tarball staging file already exists",
          {
            remedy: "Retry with a fresh staging transaction.",
          },
        );
      }
      throw error;
    }

    const hasher = new IntegrityHasher();
    const startedAt = Date.now();
    try {
      await this.#withRequest(
        parsedUrl.href,
        "application/octet-stream",
        async (response) => {
          let written = 0;
          for await (const chunk of response.body) {
            const buffer = Buffer.isBuffer(chunk)
              ? chunk
              : Buffer.from(chunk as Uint8Array);
            written += buffer.byteLength;
            if (written > maxBytes) {
              response.body.destroy();
              throw new ZyrkError(
                "ZYRK_FETCH_REFUSED",
                `tarball for ${options.label} exceeds the ${formatMiB(maxBytes)} download bound`,
                {
                  detail: {
                    label: options.label,
                    url: options.url,
                    limitBytes: maxBytes,
                  },
                  remedy:
                    "verify this is the package you expect; raise the bound deliberately if the artifact is legitimate",
                },
              );
            }
            options.onBytes?.(buffer.byteLength);
            hasher.update(buffer);
            await handle!.write(buffer);
          }
        },
        options.signal,
      );

      await handle.sync();
      await handle.close();
      handle = undefined;

      const hashed = hasher.finalize();
      let verified: { verifiedSri: string; weak: boolean };
      try {
        verified = assertIntegrityOk(hashed, options.expectedIntegrity, {
          what: `tarball for ${options.label}`,
          ...(options.allowWeakIntegrity === undefined
            ? {}
            : { allowWeak: options.allowWeakIntegrity }),
          ...(options.allowMissingIntegrity === undefined
            ? {}
            : { allowMissing: options.allowMissingIntegrity }),
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
  #insideAdvisoryBoundary(url: URL): boolean {
    const registryScope = new URL(this.#registry);
    return (
      url.origin === registryScope.origin &&
      url.pathname.startsWith(registryScope.pathname) &&
      !/%(?:2f|5c|2e)/i.test(url.pathname) &&
      !this.#routeBoundaries.some(
        (boundary) =>
          boundary.origin === url.origin &&
          boundary.pathname.length > registryScope.pathname.length &&
          url.pathname.startsWith(boundary.pathname),
      )
    );
  }
  async #withRequest<T>(
    url: string,
    accept: string,
    consume: (response: RegistryResponse) => Promise<T>,
    signal?: AbortSignal,
    request: { method?: "POST"; body?: string } = {},
  ): Promise<T> {
    const controller = new AbortController();
    let active: RegistryResponse | undefined;
    let timedOut = false;
    const cancel = (): void => {
      controller.abort();
      active?.body.destroy();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      cancel();
    }, this.#requestDeadlineMs);
    const externalCancel = (): void => cancel();
    const signals = [this.#signal, signal].filter(
      (value): value is AbortSignal => value !== undefined,
    );
    for (const source of signals)
      source.addEventListener("abort", externalCancel, { once: true });
    if (signals.some((source) => source.aborted)) cancel();
    try {
      let current = parseTarballUrl(url, "registry request");
      if (request.method === "POST" && !this.#insideAdvisoryBoundary(current))
        throw new ZyrkError(
          "ZYRK_FETCH_REFUSED",
          "Registry advisory endpoint overlaps another configured registry or has an ambiguous path.",
          {
            remedy:
              "Use a distinct advisory endpoint within the selected registry's own route.",
          },
        );
      let crossedBoundary = false;
      for (let hop = 0; hop <= 10; hop++) {
        if (controller.signal.aborted)
          throw resourceLimit(
            "request deadline or cancellation",
            this.#requestDeadlineMs,
            "requestDeadlineMs",
          );
        const auth = crossedBoundary ? undefined : this.#authorization(current);
        const retry = this.#fetchOptions.retry;
        const retryOptions =
          typeof retry === "object" && retry !== null ? retry : {};
        const retryCount =
          request.method === "POST" || retry === false
            ? 0
            : typeof retry === "number"
              ? retry
              : (retryOptions.retries ?? 2);
        for (let attempt = 0; ; attempt++) {
          const pause = async (): Promise<void> => {
            const ms = Math.min(
              retryOptions.maxTimeout ?? 8_000,
              (retryOptions.minTimeout ?? 250) *
                (retryOptions.factor ?? 2) ** attempt,
            );
            await delay(ms, undefined, { signal: controller.signal });
          };
          try {
            active = await transport(current.href, {
              ...this.#fetchOptions,
              ...request,
              retry: false,
              redirect: "manual",
              strictSSL: true,
              signal: controller.signal,
              headers: {
                accept,
                "user-agent": this.#userAgent,
                ...(request.method === "POST"
                  ? { "content-type": "application/json" }
                  : {}),
                ...(auth === undefined ? {} : { authorization: auth }),
              },
            });
          } catch (error) {
            const code =
              typeof error === "object" && error !== null
                ? (error as { code?: unknown }).code
                : undefined;
            if (
              controller.signal.aborted ||
              attempt >= retryCount ||
              typeof code !== "string" ||
              !RETRYABLE_NETWORK_CODES.has(code)
            )
              throw error;
            await pause();
            continue;
          }
          if (
            attempt >= retryCount ||
            !([408, 420, 429].includes(active.status) || active.status >= 500)
          )
            break;
          // Count and bound failed response bodies too; the transport's own
          // implicit retries cannot account for this invocation's total work.
          let responseBytes = 0;
          for await (const chunk of active.body) {
            const bytes = Buffer.byteLength(chunk as Uint8Array);
            responseBytes += bytes;
            this.#countMetadataBytes(bytes, responseBytes);
          }
          active.body.destroy();
          await pause();
        }
        if ([301, 302, 303, 307, 308].includes(active.status)) {
          const location = active.headers.get("location");
          active.body.destroy();
          if (!location || hop === 10)
            throw new ZyrkError(
              "ZYRK_FETCH_REFUSED",
              "Registry redirect limit reached or redirect location missing.",
              { remedy: "Check registry redirect configuration." },
            );
          const next = parseTarballUrl(
            new URL(location, current).href,
            "registry redirect",
          );
          if (current.protocol === "https:" && next.protocol !== "https:")
            throw new ZyrkError(
              "ZYRK_FETCH_REFUSED",
              "Registry HTTPS downgrade redirect refused.",
              { remedy: "Use HTTPS for every registry redirect." },
            );
          if (request.method === "POST") {
            if (
              ![307, 308].includes(active.status) ||
              !this.#insideAdvisoryBoundary(next)
            )
              throw new ZyrkError(
                "ZYRK_FETCH_REFUSED",
                "Registry advisory redirect crosses its authorized endpoint boundary or changes POST semantics.",
                {
                  remedy:
                    "Configure the advisory service directly within the selected registry; private package names are never forwarded outside that boundary.",
                },
              );
          }
          if (
            next.origin !== current.origin ||
            this.#authorization(next) !== auth
          )
            crossedBoundary = true;
          current = next;
          continue;
        }
        if (!active.ok) {
          active.body.destroy();
          throw httpStatusError(
            active.status,
            "fetch registry content",
            current.href,
          );
        }
        return await consume(active);
      }
      throw resourceLimit(
        "redirect count",
        10,
        "registry redirect configuration",
      );
    } catch (error) {
      // A bounded body consumer can stop while the decoder still has source
      // bytes arriving. Abort the transport before closing the exposed stream
      // so compressed responses cannot write into a closed decompressor.
      cancel();
      if (timedOut || signals.some((source) => source.aborted))
        throw resourceLimit(
          "request deadline or cancellation",
          this.#requestDeadlineMs,
          "requestDeadlineMs",
        );
      throw error;
    } finally {
      clearTimeout(timer);
      for (const source of signals)
        source.removeEventListener("abort", externalCancel);
    }
  }

  #authorization(url: URL): string | undefined {
    return this.#credentials.find(
      ({ scope }) =>
        scope.origin === url.origin && url.pathname.startsWith(scope.pathname),
    )?.authorization;
  }
}

/**
 * Pick the expected integrity string from dist metadata: prefer SRI, fall
 * back to synthesizing sha1 from the legacy `shasum` field.
 */
export function expectedIntegrityFromDist(
  dist: PackumentDist,
): string | undefined {
  if (typeof dist.integrity === "string" && dist.integrity.trim() !== "") {
    return canonicalStrongSri(dist.integrity);
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
    throw new ZyrkError("ZYRK_MANIFEST_INVALID", "registry URL is not valid", {
      remedy: "set a registry URL such as https://registry.npmjs.org/",
      cause: error,
    });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ZyrkError(
      "ZYRK_MANIFEST_INVALID",
      "registry URL must be http(s)",
      {
        remedy: "set an http(s) registry URL",
      },
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new ZyrkError(
      "ZYRK_MANIFEST_INVALID",
      "registry URL must not embed credentials",
      {
        remedy:
          "configure credentials through the supported auth adapter instead of the URL",
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
  const path = url.pathname.endsWith("/")
    ? url.pathname.slice(0, -1)
    : url.pathname;
  return `${url.protocol}//${url.host}${path}`;
}

/**
 * Reject package names that cannot be safely interpolated into a registry
 * URL. Registry names are a restricted charset; anything else is a caller
 * bug or an attack, not a package.
 */
export function validateRegistryPackageName(name: string): void {
  const bad = (why: string): never => {
    throw new ZyrkError(
      "ZYRK_RESOLUTION_FAILED",
      `invalid package name "${name}" (${why})`,
      {
        remedy: "use a real npm package name",
      },
    );
  };
  if (name === "" || name.length > 214) bad("empty or too long");
  if (name.includes("\\") || name.includes("%") || name.includes("\0"))
    bad("forbidden character");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0020\u007f]/.test(name))
    bad("control or whitespace character");
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name))
    bad("name must use supported lowercase npm package characters");
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
    throw new ZyrkError(
      "ZYRK_FETCH_REFUSED",
      `registry metadata for ${label} has an invalid tarball URL`,
      {
        detail: { label, url },
        remedy:
          "report the registry response; zyrk refuses to fetch a malformed URL",
        cause: error,
      },
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ZyrkError(
      "ZYRK_FETCH_REFUSED",
      `tarball URL for ${label} uses unsupported protocol ${parsed.protocol}`,
      {
        detail: { label, url },
        remedy: "only http(s) tarball URLs are supported",
      },
    );
  }
  if (parsed.username || parsed.password)
    throw new ZyrkError(
      "ZYRK_FETCH_REFUSED",
      "Registry artifact URL must not embed credentials.",
      {
        remedy: "Configure credentials separately from registry artifact URLs.",
      },
    );
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
 * Map library/transport errors to stable codes without exposing arbitrary
 * library messages, request URLs, response bodies, config or headers.
 */
function mapFetchError(error: unknown, what: string): ZyrkError {
  if (error instanceof ZyrkError) return error;

  const record = (error ?? {}) as {
    message?: unknown;
    code?: unknown;
    statusCode?: unknown;
    errno?: unknown;
  };
  const status =
    typeof record.statusCode === "number" ? record.statusCode : undefined;
  const code = typeof record.code === "string" ? record.code : undefined;

  if (status === 401 || status === 403 || code === "EOTP") {
    return new ZyrkError(
      "ZYRK_REGISTRY_AUTH",
      `registry authorization failed while trying to ${what}`,
      {
        detail: { status, code },
        remedy:
          "verify the credentials configured for this registry (and their scope); zyrk never falls back to the public registry",
        cause: error,
      },
    );
  }
  if (status !== undefined) {
    return httpStatusError(status, what, undefined, error);
  }
  if (code !== undefined && RETRYABLE_NETWORK_CODES.has(code)) {
    return new ZyrkError(
      "ZYRK_FETCH_FAILED",
      `network failure while trying to ${what}`,
      {
        detail: { errno: code },
        remedy:
          "check network connectivity and registry availability, then retry",
        cause: error,
      },
    );
  }
  return new ZyrkError("ZYRK_FETCH_FAILED", `failed to ${what}`, {
    ...(code === undefined ? {} : { detail: { errno: code } }),
    remedy: "check registry availability, then retry",
    cause: error,
  });
}

function httpStatusError(
  status: number,
  what: string,
  url?: string,
  cause?: unknown,
): ZyrkError {
  const detail: Record<string, unknown> = { status };
  if (url !== undefined) detail.url = url;
  if (status === 404) {
    return new ZyrkError(
      "ZYRK_RESOLUTION_FAILED",
      `not found while trying to ${what} (HTTP 404)`,
      {
        detail,
        remedy:
          "verify the package name or version exists in the configured registry",
        ...(cause === undefined ? {} : { cause }),
      },
    );
  }
  if (status === 401 || status === 403) {
    return new ZyrkError(
      "ZYRK_REGISTRY_AUTH",
      `registry authorization failed while trying to ${what} (HTTP ${status})`,
      {
        detail,
        remedy: "verify the credentials configured for this registry",
        ...(cause === undefined ? {} : { cause }),
      },
    );
  }
  return new ZyrkError(
    "ZYRK_FETCH_FAILED",
    `registry responded HTTP ${status} while trying to ${what}`,
    {
      detail,
      remedy: "retry later; if it persists, check the registry's status",
      ...(cause === undefined ? {} : { cause }),
    },
  );
}

function validatePackument(
  raw: unknown,
  requestedName: string,
  origin: string,
  maxVersions: number,
): Packument {
  const bad = (why: string): never => {
    throw new ZyrkError(
      "ZYRK_RESOLUTION_FAILED",
      `registry returned a malformed packument for ${requestedName} (${why})`,
      {
        detail: { name: requestedName, origin },
        remedy:
          "report the registry response; retry against a well-formed npm registry",
      },
    );
  };
  if (typeof raw !== "object" || raw === null) bad("not an object");
  const doc = raw as Record<string, unknown>;
  if (typeof doc["name"] !== "string") bad("missing name");
  if ((doc["name"] as string).toLowerCase() !== requestedName.toLowerCase()) {
    bad(
      `name mismatch: asked for ${requestedName}, got ${doc["name"] as string}`,
    );
  }
  const versionsRaw = doc["versions"];
  if (
    typeof versionsRaw !== "object" ||
    versionsRaw === null ||
    Array.isArray(versionsRaw)
  ) {
    bad("missing versions map");
  }
  if (Object.keys(versionsRaw as object).length > maxVersions)
    throw resourceLimit(
      "metadata versions",
      maxVersions,
      "maxMetadataVersions",
    );
  const distTagsRaw = doc["dist-tags"] ?? doc["distTags"];
  if (
    distTagsRaw !== undefined &&
    (typeof distTagsRaw !== "object" || distTagsRaw === null)
  ) {
    bad("dist-tags is not an object");
  }

  const versions: Record<string, PackumentVersion> = {};
  for (const [version, value] of Object.entries(
    versionsRaw as Record<string, unknown>,
  )) {
    if (typeof value !== "object" || value === null)
      bad(`version ${version} is not an object`);
    const entry = value as Record<string, unknown>;
    if (entry["version"] !== undefined && entry["version"] !== version) {
      bad(
        `version key ${version} disagrees with entry version ${String(entry["version"])}`,
      );
    }
    const dist = entry["dist"];
    if (typeof dist !== "object" || dist === null)
      bad(`version ${version} has no dist block`);
    const distRecord = dist as Record<string, unknown>;
    if (
      typeof distRecord["tarball"] !== "string" ||
      distRecord["tarball"] === ""
    ) {
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
    for (const [tag, target] of Object.entries(
      distTagsRaw as Record<string, unknown>,
    )) {
      if (typeof target === "string") distTags[tag] = target;
    }
  }

  const packument: Packument = { name: requestedName, distTags, versions };
  if (typeof doc["modified"] === "string") packument.modified = doc["modified"];
  return packument;
}

function positiveLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new ZyrkError(
      "ZYRK_POLICY_DENIED",
      `Invalid registry resource limit ${name}.`,
      {
        remedy:
          "Use a positive safe integer for each registry resource budget.",
      },
    );
  return value;
}
function resourceLimit(
  subject: string,
  limit: number,
  setting: string,
): ZyrkError {
  return new ZyrkError(
    "ZYRK_FETCH_REFUSED",
    `Registry ${subject} budget exceeded.`,
    {
      detail: { limit, setting },
      remedy: `Verify the registry response; deliberately raise ${setting} through RegistryClient options only if appropriate.`,
    },
  );
}
function safeTransportOptions(
  options: FetchOptions,
  registry: string,
): {
  transport: FetchOptions;
  credentials: Array<{ scope: URL; authorization: string }>;
} {
  const transport: FetchOptions = {};
  const credentials: Array<{ scope: URL; authorization: string }> = [];
  const config = options as Record<string, unknown>;
  const refuse = (): never => {
    throw new ZyrkError(
      "ZYRK_POLICY_DENIED",
      "Unsupported registry transport option or TLS policy weakening.",
      {
        remedy:
          "Use verified TLS, scoped registry credentials, and supported transport options.",
      },
    );
  };
  for (const [key, value] of Object.entries(config)) {
    if (["ca", "timeout", "retry", "maxSockets", "strictSSL"].includes(key)) {
      if (key === "strictSSL" && value !== true) refuse();
      transport[key] = value;
    } else if (
      /^\/\/[^/]+\/.*:(?:_authToken|_auth|username|_password)$/.test(key)
    ) {
      // Handled as one credential group below.
    } else if (key === "headers") {
      if (!value || typeof value !== "object") refuse();
      for (const [header, content] of Object.entries(value as object)) {
        if (
          header.toLowerCase() !== "authorization" ||
          typeof content !== "string" ||
          /[\r\n]/.test(content)
        )
          refuse();
        credentials.push({
          scope: new URL(registry),
          authorization: content as string,
        });
      }
    } else refuse();
  }
  const scopes = new Set(
    Object.keys(config)
      .filter((key) => key.startsWith("//"))
      .map((key) => key.slice(0, key.lastIndexOf(":"))),
  );
  for (const key of scopes) {
    const scope = new URL(`${new URL(registry).protocol}${key}`);
    if (!scope.pathname.endsWith("/")) refuse();
    const token = config[`${key}:_authToken`];
    const auth = config[`${key}:_auth`];
    const username = config[`${key}:username`];
    const password = config[`${key}:_password`];
    let authorization: string;
    if (typeof token === "string") authorization = `Bearer ${token}`;
    else if (typeof auth === "string") authorization = `Basic ${auth}`;
    else if (typeof username === "string" && typeof password === "string")
      authorization = `Basic ${Buffer.from(`${username}:${Buffer.from(password, "base64").toString("utf8")}`).toString("base64")}`;
    else refuse();
    if (/[\r\n]/.test(authorization!)) refuse();
    credentials.push({ scope, authorization: authorization! });
  }
  credentials.sort((a, b) => b.scope.pathname.length - a.scope.pathname.length);
  return { transport, credentials };
}
