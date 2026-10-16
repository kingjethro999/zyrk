/**
 * Version constants that participate in on-disk formats.
 *
 * Bumping rules:
 * - STORE_FORMAT_VERSION gates the whole store layout; a CLI that does not
 *   understand a newer store must refuse to act on it.
 * - SOURCE_MANIFEST_SCHEMA_VERSION gates `sources/<id>/manifest.json`.
 * - EXTRACTION_POLICY_VERSION is part of source identity: a safety fix that
 *   changes accepted content invalidates or revalidates existing manifests
 *   (SPEC 13.4).
 * - CONTEXT_CANONICALIZATION_VERSION is part of the store format and of
 *   dependency-context identity (SPEC 9.4).
 * - RESOLVER_POLICY_VERSION participates in the lockfile (SPEC 14.2).
 */
export const CLI_VERSION = "0.0.0";

export const STORE_FORMAT_VERSION = 1;

/** Domain separator for content-object keys; see SPEC 8.2. */
export const OBJECT_KEY_SCHEME = "zyrk-obj1";

export const SOURCE_MANIFEST_SCHEMA_VERSION = 1;

export const EXTRACTION_POLICY_VERSION = 1;

export const CONTEXT_CANONICALIZATION_VERSION = 1;

export const RESOLVER_POLICY_VERSION = 1;

/** Version of the `zyrk` extension namespace inside package-lock.json (D-1). */
export const LOCKFILE_ZYRK_EXTENSION_VERSION = 1;

/** Store format marker file name at the store root. */
export const STORE_FORMAT_FILE = "format.json";
