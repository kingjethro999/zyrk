/** Shared data-only registry configuration for every native CLI command. */
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { ZyrkError } from "../errors.ts";
import { RegistryClient, DEFAULT_REGISTRY } from "../fetch/registry.ts";
import { isErrno } from "../util/fsx.ts";
import { findProjectBoundary } from "../config/paths.ts";
import { cleanUrl } from "./lock.ts";

export async function installRegistry(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  version: string;
  registry?: string;
}): Promise<RegistryClient> {
  let registry = DEFAULT_REGISTRY;
  const auth: Record<string, string> = {};
  const home = options.env.HOME ?? os.homedir();
  const project = (await findProjectBoundary(options.cwd)) ?? options.cwd;
  const files = [
    options.env.npm_config_userconfig ??
      options.env.NPM_CONFIG_USERCONFIG ??
      path.join(home, ".npmrc"),
    path.join(project, ".npmrc"),
  ];
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (cause) {
      if (isErrno(cause, "ENOENT")) continue;
      throw new ZyrkError(
        "ZYRK_POLICY_DENIED",
        "Cannot read npm registry configuration.",
        {
          remedy: "Make the user and project .npmrc readable before retrying.",
        },
      );
    }
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";"))
        continue;
      const index = trimmed.indexOf("=");
      if (index < 1) continue;
      const key = trimmed.slice(0, index).trim();
      let value = trimmed.slice(index + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      )
        value = value.slice(1, -1);
      value = value.replace(/\$\{([^}]+)\}/g, (_match, name: string) => {
        const expanded = options.env[name];
        if (expanded === undefined)
          throw new ZyrkError(
            "ZYRK_POLICY_DENIED",
            "Registry configuration requires a missing environment variable.",
            {
              remedy:
                "Set the environment variables referenced by your npm registry configuration.",
            },
          );
        return expanded;
      });
      if (
        /^\/\//.test(key) &&
        /:(?:_authToken|_auth|username|_password)$/.test(key)
      )
        auth[key] = value;
      else if (
        /^(?:_authToken|_auth|username|_password|certfile|keyfile)$/.test(
          key,
        ) ||
        /:(?:certfile|keyfile)$/.test(key)
      )
        throw new ZyrkError(
          "ZYRK_POLICY_DENIED",
          "Registry credentials must use a supported URL-scoped auth setting.",
          {
            remedy:
              "Use a URL-scoped _authToken or Basic credential entry in .npmrc; unsupported auth configuration is never ignored.",
          },
        );
      if (key === "registry") registry = value;
      if (/^@.+:registry$/.test(key))
        throw new ZyrkError(
          "ZYRK_POLICY_DENIED",
          "Scoped registry routing is not supported by native commands yet.",
          {
            remedy:
              "Use npm for mixed-registry projects; zyrk will not silently fetch a private scope from a public registry.",
          },
        );
      if (key === "strict-ssl" && value === "false")
        throw new ZyrkError(
          "ZYRK_POLICY_DENIED",
          "Disabling registry TLS verification is not supported.",
          {
            remedy:
              "Configure a trusted HTTPS registry with valid TLS certificates.",
          },
        );
    }
  }
  if (
    (
      options.env.npm_config_strict_ssl ?? options.env.NPM_CONFIG_STRICT_SSL
    )?.toLowerCase() === "false"
  )
    throw new ZyrkError(
      "ZYRK_POLICY_DENIED",
      "Disabling registry TLS verification is not supported.",
      { remedy: "Configure trusted HTTPS certificates." },
    );
  registry =
    options.registry ??
    options.env.npm_config_registry ??
    options.env.NPM_CONFIG_REGISTRY ??
    registry;
  if (!cleanUrl(registry))
    throw new ZyrkError(
      "ZYRK_POLICY_DENIED",
      "Registry URL must be HTTP(S) without credentials, query parameters, or fragments.",
      {
        remedy:
          "Use a credential-free registry URL and configure URL-scoped credentials separately in .npmrc.",
      },
    );
  const url = new URL(registry);
  if (
    url.protocol !== "https:" &&
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  )
    throw new ZyrkError(
      "ZYRK_POLICY_DENIED",
      "Remote registries require HTTPS.",
      {
        remedy:
          "Select an HTTPS registry; HTTP is limited to loopback development registries.",
      },
    );
  return new RegistryClient({
    registry,
    userAgent: `zyrk/${options.version}`,
    fetchOptions: auth,
  });
}
