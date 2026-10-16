/** Fail closed on registry settings the current single-registry adapter cannot honor. */
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { ZyrkError } from "../errors.ts";
import { RegistryClient, DEFAULT_REGISTRY } from "../fetch/registry.ts";
import { isErrno } from "../util/fsx.ts";
import { cleanUrl } from "./lock.ts";

export async function installRegistry(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  version: string;
  registry?: string;
}): Promise<RegistryClient> {
  let registry = DEFAULT_REGISTRY;
  const home = options.env.HOME ?? os.homedir();
  const files = [
    options.env.npm_config_userconfig ?? path.join(home, ".npmrc"),
    path.join(options.cwd, ".npmrc"),
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
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim();
      if (key === "registry") registry = value;
      if (/^@.+:registry$/.test(key))
        throw new ZyrkError(
          "ZYRK_POLICY_DENIED",
          "Scoped registry routing is not supported by project install yet.",
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
  registry = options.registry ?? options.env.npm_config_registry ?? registry;
  if (!cleanUrl(registry))
    throw new ZyrkError(
      "ZYRK_POLICY_DENIED",
      "Registry URL must be HTTP(S) without credentials, query parameters, or fragments.",
      {
        remedy:
          "Use a credential-free registry URL. Authenticated private registries are not supported by project install yet.",
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
  return new RegistryClient({ registry, userAgent: `zyrk/${options.version}` });
}
