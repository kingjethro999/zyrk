import { afterEach, expect, test } from "vitest";
import { createServer, type RequestListener, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { RegistryClient } from "../src/fetch/registry.ts";
import { installRegistry } from "../src/install/registry.ts";
import { redactSecrets } from "../src/log.ts";
import { ZyrkError, toZyrkError } from "../src/errors.ts";
const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.closeAllConnections();
          s.close(() => resolve());
        }),
    ),
  );
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
async function server(listener: RequestListener): Promise<string> {
  const s = createServer(listener);
  servers.push(s);
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const addr = s.address();
  if (!addr || typeof addr === "string") throw Error("bad address");
  return `http://127.0.0.1:${addr.port}`;
}
async function dir() {
  const d = await mkdtemp(path.join(tmpdir(), "zyrk-net-"));
  dirs.push(d);
  return d;
}
const doc = JSON.stringify({ name: "fixture", versions: {}, "dist-tags": {} });
test("diagnostics remove URL secrets, Basic auth, controls, nested details and local paths", () => {
  const fake = "FAKE_SECRET";
  const text = redactSecrets(
    `https://user:${fake}@example.test/a?X-Amz-Signature=${fake}&x=${fake} Authorization: Basic ${fake}\nforged\u001b[31m /home/fake/private/file`,
  );
  expect(text).not.toContain(fake);
  expect(text).not.toContain("user:");
  expect(text).not.toContain("\n");
  expect(text).not.toContain("\u001b");
  expect(text).not.toContain("/home/fake");
  const error = new ZyrkError(
    "ZYRK_FETCH_FAILED",
    `https://u:${fake}@example.test/?sig=${fake}`,
    {
      detail: {
        nested: [{ password: fake, url: `https://x.test/?signed=${fake}` }],
      },
      remedy: `token=${fake}`,
    },
  );
  expect(JSON.stringify(error)).not.toContain(fake);
  expect(
    toZyrkError(
      new Error(`read /home/fake/private/${fake}`),
      "operation failed",
    ).message,
  ).toBe("operation failed");
});
test("rejects transport options that weaken or bypass TLS policy", () => {
  for (const fetchOptions of [
    { strictSSL: false },
    { agent: {} },
    { rejectUnauthorized: false },
    { headers: { cookie: "FAKE" } },
  ])
    expect(
      () =>
        new RegistryClient({
          registry: "https://example.test/",
          userAgent: "test",
          fetchOptions,
        }),
    ).toThrow(/transport|TLS|option/i);
});
test("auth is attached only to the full authorized origin and path, including redirect chains", async () => {
  const received: Array<string | undefined> = [];
  const target = await server((req, res) => {
    received.push(req.headers.authorization);
    res.end(doc);
  });
  const local: Array<string | undefined> = [];
  const source = await server((req, res) => {
    local.push(req.headers.authorization);
    if (req.url === "/registry/fixture") {
      res.writeHead(302, { location: `${target}/hop` });
      res.end();
    } else res.end("x");
  });
  const client = new RegistryClient({
    registry: `${source}/registry/`,
    userAgent: "test",
    fetchOptions: {
      [`//${new URL(source).host}/registry/:_authToken`]: "FAKE_AUTH",
    },
  });
  await client.packument("fixture");
  expect(local).toEqual(["Bearer FAKE_AUTH"]);
  expect(received).toEqual([undefined]);
  await client.downloadTarball({
    url: `${source}/sibling/a`,
    label: "fixture",
    destPath: path.join(await dir(), "a"),
    expectedIntegrity: undefined,
    allowMissingIntegrity: true,
  });
  expect(local[1]).toBeUndefined();
});
test("metadata byte and version budgets reject small hostile fixtures", async () => {
  const base = await server((_req, res) => res.end(doc));
  const client = new RegistryClient({
    registry: base,
    userAgent: "test",
    maxMetadataBytes: 8,
  });
  await expect(client.packument("fixture")).rejects.toMatchObject({
    code: "ZYRK_FETCH_REFUSED",
  });
  const versions = await server((_req, res) =>
    res.end(
      JSON.stringify({
        name: "fixture",
        versions: {
          "1.0.0": { dist: { tarball: `${base}/a` } },
          "2.0.0": { dist: { tarball: `${base}/b` } },
        },
      }),
    ),
  );
  await expect(
    new RegistryClient({
      registry: versions,
      userAgent: "test",
      maxMetadataVersions: 1,
    }).packument("fixture"),
  ).rejects.toMatchObject({ code: "ZYRK_FETCH_REFUSED" });
});
test("metadata deadline aborts a live response and stops its socket", async () => {
  let closed!: () => void;
  const didClose = new Promise<void>((r) => {
    closed = r;
  });
  const base = await server((req, res) => {
    req.on("close", closed);
    res.writeHead(200);
    res.write("{");
  });
  await expect(
    new RegistryClient({
      registry: base,
      userAgent: "test",
      requestDeadlineMs: 50,
      retries: 0,
    }).packument("fixture"),
  ).rejects.toMatchObject({ code: "ZYRK_FETCH_REFUSED" });
  await Promise.race([
    didClose,
    new Promise((_, reject) =>
      setTimeout(() => reject(Error("socket not closed")), 1000),
    ),
  ]);
});
test("config applies user, project, environment and CLI precedence without public fallback", async () => {
  const cwd = await dir();
  const home = await dir();
  await writeFile(
    path.join(home, ".npmrc"),
    "registry=https://user.invalid/\n",
  );
  await writeFile(
    path.join(cwd, ".npmrc"),
    "registry=https://project.invalid/\n",
  );
  const base = { cwd, env: { HOME: home }, version: "test" };
  expect((await installRegistry(base)).registry).toBe(
    "https://project.invalid/",
  );
  expect(
    (
      await installRegistry({
        ...base,
        env: { HOME: home, npm_config_registry: "https://env.invalid/" },
      })
    ).registry,
  ).toBe("https://env.invalid/");
  expect(
    (await installRegistry({ ...base, registry: "https://cli.invalid/" }))
      .registry,
  ).toBe("https://cli.invalid/");
  await writeFile(
    path.join(cwd, ".npmrc"),
    "@internal:registry=https://private.invalid/\n",
  );
  await expect(installRegistry(base)).rejects.toMatchObject({
    code: "ZYRK_POLICY_DENIED",
  });
});

test("private config loads scoped credentials with environment expansion and never falls back after auth errors", async () => {
  const seen: Array<string | undefined> = [];
  const base = await server((req, res) => {
    seen.push(req.headers.authorization);
    res.writeHead(401);
    res.end('{"error":"FAKE_SERVER_SECRET"}');
  });
  const cwd = await dir();
  const home = await dir();
  await writeFile(
    path.join(cwd, ".npmrc"),
    `registry=${base}/registry/\n//${new URL(base).host}/registry/:_authToken=\${FIXTURE_TOKEN}\n`,
  );
  const client = await installRegistry({
    cwd,
    env: { HOME: home, FIXTURE_TOKEN: "FAKE_CONFIG_TOKEN" },
    version: "test",
  });
  await expect(client.packument("fixture")).rejects.toMatchObject({
    code: "ZYRK_REGISTRY_AUTH",
  });
  expect(seen).toEqual(["Bearer FAKE_CONFIG_TOKEN"]);
  await expect(
    installRegistry({ cwd, env: { HOME: home }, version: "test" }),
  ).rejects.toMatchObject({ code: "ZYRK_POLICY_DENIED" });
  await expect(
    installRegistry({
      cwd,
      env: { HOME: home, npm_config_strict_ssl: "false" },
      version: "test",
    }),
  ).rejects.toMatchObject({ code: "ZYRK_POLICY_DENIED" });
});

test("redirect chains cannot recover credentials after crossing the origin or path boundary", async () => {
  const seen: Array<[string, string | undefined]> = [];
  let source = "";
  const other = await server((req, res) => {
    seen.push(["other", req.headers.authorization]);
    res.writeHead(302, { location: `${source}/registry/final` });
    res.end();
  });
  source = await server((req, res) => {
    seen.push([req.url!, req.headers.authorization]);
    if (req.url === "/registry/fixture") {
      res.writeHead(302, { location: `${other}/hop` });
      res.end();
    } else if (req.url === "/registry/sibling") {
      res.writeHead(302, { location: "/elsewhere" });
      res.end();
    } else res.end(doc);
  });
  const client = new RegistryClient({
    registry: `${source}/registry/`,
    userAgent: "test",
    fetchOptions: { headers: { authorization: "Bearer FAKE_CHAIN" } },
  });
  await client.packument("fixture");
  expect(seen).toEqual([
    ["/registry/fixture", "Bearer FAKE_CHAIN"],
    ["other", undefined],
    ["/registry/final", undefined],
  ]);
  seen.length = 0;
  await client.downloadTarball({
    url: `${source}/registry/sibling`,
    destPath: path.join(await dir(), "sibling"),
    label: "fixture",
    expectedIntegrity: undefined,
    allowMissingIntegrity: true,
  });
  expect(seen).toEqual([
    ["/registry/sibling", "Bearer FAKE_CHAIN"],
    ["/elsewhere", undefined],
  ]);
});

test("credential-bearing artifact URLs are refused before requesting them", async () => {
  let requests = 0;
  const base = await server((_req, res) => {
    requests++;
    res.end("x");
  });
  const client = new RegistryClient({ registry: base, userAgent: "test" });
  await expect(
    client.downloadTarball({
      url: base.replace("//", "//u:FAKE_URL_PASSWORD@"),
      destPath: path.join(await dir(), "artifact"),
      label: "fixture",
      expectedIntegrity: undefined,
    }),
  ).rejects.toMatchObject({ code: "ZYRK_FETCH_REFUSED" });
  expect(requests).toBe(0);
});

test("trusted TLS still refuses HTTPS downgrade without forwarding credentials", async () => {
  const { createServer: createSecureServer } = await import("node:https");
  const { readFile } = await import("node:fs/promises");
  const key = await readFile(
    new URL("./fixtures/network/key.pem", import.meta.url),
  );
  const cert = await readFile(
    new URL("./fixtures/network/cert.pem", import.meta.url),
  );
  let insecureRequests = 0;
  let tlsAuth: string | undefined;
  const insecure = await server((_req, res) => {
    insecureRequests++;
    res.end(doc);
  });
  const secure = createSecureServer({ key, cert }, (req, res) => {
    tlsAuth = req.headers.authorization;
    res.writeHead(302, { location: `${insecure}/registry/fixture` });
    res.end();
  });
  servers.push(secure);
  await new Promise<void>((resolve) => secure.listen(0, "127.0.0.1", resolve));
  const addr = secure.address();
  if (!addr || typeof addr === "string") throw Error("bad address");
  const registry = `https://127.0.0.1:${addr.port}/registry/`;
  const client = new RegistryClient({
    registry,
    userAgent: "test",
    fetchOptions: {
      ca: cert.toString("utf8"),
      headers: { authorization: "Bearer FAKE_TLS" },
    },
  });
  await expect(client.packument("fixture")).rejects.toMatchObject({
    code: "ZYRK_FETCH_REFUSED",
  });
  expect(tlsAuth).toBe("Bearer FAKE_TLS");
  expect(insecureRequests).toBe(0);
});

test("logger sanitizes nested credential fields before serializing objects", async () => {
  const { createLogger } = await import("../src/log.ts");
  const { Writable } = await import("node:stream");
  let output = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += String(chunk);
      callback();
    },
  });
  createLogger({ level: "debug", stream }).debug("metadata", {
    nested: { password: "FAKE_NESTED", authorization: "Basic FAKE_BASIC" },
  });
  expect(output).not.toContain("FAKE_NESTED");
  expect(output).not.toContain("FAKE_BASIC");
});

test("diagnostics redact quoted secret fields and Windows UNC paths", () => {
  expect(
    redactSecrets('{"password":"FAKE_QUOTED", "_authToken": "FAKE_AUTH_JSON"}'),
  ).not.toMatch(/FAKE_/);
  expect(redactSecrets("open \\\\server\\private\\file")).not.toContain(
    "server",
  );
});

test("metadata limits cancel the producer before the rest of its response", async () => {
  let sent = 0;
  let timer: NodeJS.Timeout | undefined;
  const base = await server((req, res) => {
    res.writeHead(200);
    timer = setInterval(() => {
      sent++;
      res.write("12345678");
    }, 5);
    req.on("close", () => clearInterval(timer));
  });
  await expect(
    new RegistryClient({
      registry: base,
      userAgent: "test",
      maxMetadataBytes: 8,
    }).packument("fixture"),
  ).rejects.toMatchObject({ code: "ZYRK_FETCH_REFUSED" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(sent).toBeLessThan(6);
});

test("hostname changes on the same loopback server strip authorization", async () => {
  const seen: Array<string | undefined> = [];
  let base = "";
  base = await server((req, res) => {
    seen.push(req.headers.authorization);
    if (req.url === "/registry/fixture") {
      res.writeHead(302, {
        location: `${base.replace("127.0.0.1", "localhost")}/registry/final`,
      });
      res.end();
    } else res.end(doc);
  });
  const client = new RegistryClient({
    registry: `${base}/registry/`,
    userAgent: "test",
    fetchOptions: { headers: { authorization: "Bearer FAKE_HOST" } },
  });
  await client.packument("fixture");
  expect(seen).toEqual(["Bearer FAKE_HOST", undefined]);
});

test("unsupported URL schemes cannot leak credentials or file paths through errors", () => {
  expect(
    redactSecrets(
      "git://user:FAKE_GIT_PASSWORD@example.test/path?sig=FAKE_QUERY",
    ),
  ).not.toMatch(/FAKE_|user:/);
  expect(redactSecrets("file:///home/fake-private/file")).not.toContain(
    "fake-private",
  );
});

test("per-call cancellation stops its request while preserving the shared client", async () => {
  const base = await server((req, res) => {
    if (req.url === "/fixture") {
      res.writeHead(200);
      res.write("{");
    } else res.end(JSON.stringify({ name: "other", versions: {} }));
  });
  const controller = new AbortController();
  const client = new RegistryClient({
    registry: base,
    userAgent: "test",
    requestDeadlineMs: 1000,
  });
  const pending = client.packument("fixture", { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await expect(pending).rejects.toMatchObject({ code: "ZYRK_FETCH_REFUSED" });
  await expect(client.packument("other")).resolves.toMatchObject({
    name: "other",
  });
});

test("tarball streaming accounts aggregate bytes before accepting the chunk", async () => {
  const base = await server((_req, res) => res.end("12345678"));
  const cwd = await dir();
  const destPath = path.join(cwd, "artifact");
  const counts: number[] = [];
  await expect(
    new RegistryClient({ registry: base, userAgent: "test" }).downloadTarball({
      url: `${base}/artifact`,
      destPath,
      label: "fixture",
      expectedIntegrity: undefined,
      allowMissingIntegrity: true,
      onBytes(bytes) {
        counts.push(bytes);
        throw new ZyrkError(
          "ZYRK_FETCH_REFUSED",
          "Aggregate download budget exceeded.",
        );
      },
    }),
  ).rejects.toMatchObject({ code: "ZYRK_FETCH_REFUSED" });
  expect(counts).toEqual([8]);
  const { access } = await import("node:fs/promises");
  await expect(access(destPath)).rejects.toMatchObject({ code: "ENOENT" });
});

test("audit posts only to its configured authenticated registry path", async () => {
  const seen: Array<{
    url: string;
    method: string | undefined;
    auth: string | undefined;
    body: string;
  }> = [];
  const base = await server((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => {
      seen.push({
        url: req.url!,
        method: req.method,
        auth: req.headers.authorization,
        body,
      });
      res.end("{}");
    });
  });
  const client = new RegistryClient({
    registry: `${base}/registry/`,
    userAgent: "test",
    fetchOptions: { headers: { authorization: "Bearer FAKE_AUDIT" } },
  });
  await expect(
    client.auditAdvisories({ "@private/fixture": ["1.0.0"] }),
  ).resolves.toEqual({});
  expect(seen).toEqual([
    {
      url: "/registry/-/npm/v1/security/advisories/bulk",
      method: "POST",
      auth: "Bearer FAKE_AUDIT",
      body: JSON.stringify({ "@private/fixture": ["1.0.0"] }),
    },
  ]);
});

test("audit refuses cross-boundary redirects before disclosing package names and bounds response bytes", async () => {
  let targetRequests = 0;
  const target = await server((_req, res) => {
    targetRequests++;
    res.end("{}");
  });
  const origin = await server((_req, res) => {
    res.writeHead(307, { location: `${target}/bulk` });
    res.end();
  });
  await expect(
    new RegistryClient({ registry: origin, userAgent: "test" }).auditAdvisories(
      { "@private/fixture": ["1.0.0"] },
    ),
  ).rejects.toMatchObject({ code: "ZYRK_FETCH_REFUSED" });
  expect(targetRequests).toBe(0);
  const huge = await server((_req, res) => res.end('{"fixture":[]}'));
  await expect(
    new RegistryClient({
      registry: huge,
      userAgent: "test",
      maxMetadataBytes: 8,
    }).auditAdvisories({ fixture: ["1.0.0"] }),
  ).rejects.toMatchObject({ code: "ZYRK_FETCH_REFUSED" });
});

test("aggregate metadata accounting limits a client across individually valid responses", async () => {
  const base = await server((_req, res) => res.end(doc));
  const client = new RegistryClient({
    registry: base,
    userAgent: "test",
    maxMetadataBytes: Buffer.byteLength(doc) + 1,
    maxTotalMetadataBytes: Buffer.byteLength(doc) * 2 - 1,
  });
  await client.packument("fixture");
  await expect(client.packument("fixture")).rejects.toMatchObject({
    code: "ZYRK_FETCH_REFUSED",
    detail: { setting: "maxTotalMetadataBytes" },
  });
});

test("metadata retry error bodies consume the same total client budget", async () => {
  let requests = 0;
  const base = await server((_req, res) => {
    requests++;
    if (requests === 1) {
      res.writeHead(500);
      res.end("x".repeat(40));
    } else res.end(doc);
  });
  const client = new RegistryClient({
    registry: base,
    userAgent: "test",
    retries: 1,
    maxMetadataBytes: 64,
    maxTotalMetadataBytes: 70,
  });
  await expect(client.packument("fixture")).rejects.toMatchObject({
    code: "ZYRK_FETCH_REFUSED",
    detail: { setting: "maxTotalMetadataBytes" },
  });
  expect(requests).toBe(2);
});

test("nested tool working directories retain the project registry boundary", async () => {
  const project = await dir();
  await writeFile(path.join(project, "package.json"), '{"name":"fixture"}');
  await writeFile(
    path.join(project, ".npmrc"),
    "@internal:registry=https://private.invalid/\n",
  );
  const nested = path.join(project, "nested");
  await mkdir(nested);
  await expect(
    installRegistry({
      cwd: nested,
      env: {
        HOME: project,
        npm_config_userconfig: path.join(project, "missing-user-config"),
      },
      version: "test",
    }),
  ).rejects.toMatchObject({ code: "ZYRK_POLICY_DENIED" });
});

test("free text redacts long npm tokens and cookie headers", () => {
  const token = "npm_" + "a".repeat(60);
  expect(redactSecrets(token)).not.toContain(token);
  expect(
    redactSecrets("Cookie: session=FAKE_COOKIE_SECRET\nnext line"),
  ).not.toContain("FAKE_COOKIE_SECRET");
});

test("workspace child commands retain the authoritative root registry policy", async () => {
  const root = await dir();
  await mkdir(path.join(root, "packages/child"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ workspaces: ["packages/*"] }),
  );
  await writeFile(
    path.join(root, "packages/child/package.json"),
    JSON.stringify({ name: "child", version: "1.0.0" }),
  );
  await writeFile(
    path.join(root, ".npmrc"),
    "@private:registry=https://private.invalid/\n",
  );
  await expect(
    installRegistry({
      cwd: path.join(root, "packages/child"),
      env: {
        HOME: root,
        npm_config_userconfig: path.join(root, "missing-user-config"),
      },
      version: "test",
    }),
  ).rejects.toMatchObject({ code: "ZYRK_POLICY_DENIED" });
});
