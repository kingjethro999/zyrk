/**
 * Minimal ambient declarations for vendored npm libraries.
 *
 * These cover only the API subset snpm actually uses, verified against the
 * installed versions (npm-registry-fetch 20.x). Third-party `@types` packages
 * trail the real majors too far to be trusted here; when we need more surface,
 * extend these deliberately and re-verify against the installed source.
 */

declare module "npm-registry-fetch" {
  import type { Readable } from "node:stream";

  export interface RetryOptions {
    retries?: number;
    factor?: number;
    minTimeout?: number;
    maxTimeout?: number;
    randomize?: boolean;
  }

  export interface FetchOptions {
    registry?: string;
    userAgent?: string;
    headers?: Record<string, string>;
    retry?: RetryOptions | number | false;
    timeout?: number;
    integrity?: string;
    query?: Record<string, string | string[]>;
    auth?: unknown;
    npmSession?: string;
    preferOffline?: boolean;
    preferOnline?: boolean;
    offline?: boolean;
    cache?: string;
    [key: string]: unknown;
  }

  /** Response shape as produced by make-fetch-happen / minipass-fetch. */
  export interface FetchResponse {
    ok: boolean;
    status: number;
    statusText: string;
    url: string;
    headers: {
      get(name: string): string | null;
      raw?: () => Record<string, string[]>;
    };
    body: Readable;
    json(): Promise<unknown>;
    text(): Promise<string>;
    buffer(): Promise<Buffer>;
  }

  /** The default export: fetch a URL, resolving to a Response. */
  export default function regFetch(
    url: string | URL,
    opts?: FetchOptions,
  ): Promise<FetchResponse>;

  /** Fetch and parse a JSON document. */
  export function json(
    url: string | URL,
    opts?: FetchOptions,
  ): Promise<unknown>;

  /** Fetch a JSON document as a stream of parsed objects (NDJSON). */
  export namespace json {
    function stream(
      url: string | URL,
      opts?: FetchOptions,
    ): NodeJS.ReadableStream;
  }

  /** Fetch plain text. */
  export function text(url: string | URL, opts?: FetchOptions): Promise<string>;

  /** Registry lookup helpers (not used yet; declared for completeness). */
  export function pickRegistry(
    spec: string | { scope?: string | null },
    opts?: FetchOptions,
  ): string;
  export function getAuth(registry: string, opts?: FetchOptions): unknown;
}
