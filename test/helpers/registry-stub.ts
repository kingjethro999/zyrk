/**
 * Hermetic registry stub for tests: serves packuments and tarballs over
 * local HTTP so resolve/fetch/realize paths run end to end without network
 * access. Tarball bytes are crafted first and the advertised integrity is
 * computed from those exact bytes, so verification exercises the real path.
 */
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { craftTarGz, type CraftEntry } from "./tar.ts";

export type StubFile = { data: string | Buffer; mode?: number };
export type StubVersion = {
  version: string;
  /** Relative paths; the helper adds the `package/` prefix. */
  files: Record<string, StubFile>;
  deps?: Record<string, string>;
  optionalDeps?: Record<string, string>;
  peerDeps?: Record<string, string>;
  peerMeta?: Record<string, { optional?: boolean }>;
  bin?: string | Record<string, string>;
  scripts?: Record<string, string>;
};

export type StubPackage = {
  name: string;
  versions: StubVersion[];
  tags?: Record<string, string>;
};

export type StubRegistry = {
  url: string;
  origin: string;
  close(): Promise<void>;
};

function tarballFileFor(name: string, version: string): string {
  return `${name.replace("@", "").replace("/", "-")}-${version}.tgz`;
}

export async function startStubRegistry(
  packages: StubPackage[],
): Promise<StubRegistry> {
  const tarballs = new Map<string, Buffer>();

  for (const pkg of packages) {
    for (const stub of pkg.versions) {
      const entries: CraftEntry[] = [{ path: "package", type: "dir" }];
      if (stub.files["package.json"] === undefined) {
        entries.push({
          path: "package/package.json",
          data: `${JSON.stringify(
            {
              name: pkg.name,
              version: stub.version,
              ...(stub.bin === undefined ? {} : { bin: stub.bin }),
              ...(stub.scripts === undefined ? {} : { scripts: stub.scripts }),
              ...(stub.deps === undefined ? {} : { dependencies: stub.deps }),
              ...(stub.optionalDeps === undefined
                ? {}
                : { optionalDependencies: stub.optionalDeps }),
              ...(stub.peerDeps === undefined
                ? {}
                : { peerDependencies: stub.peerDeps }),
            },
            null,
            2,
          )}\n`,
        });
      }
      const sortedFiles = Object.keys(stub.files).sort();
      for (const file of sortedFiles) {
        const entry = stub.files[file];
        if (entry === undefined) continue;
        entries.push({
          path: `package/${file}`,
          data: entry.data,
          mode: entry.mode ?? 0o644,
        });
      }
      const file = tarballFileFor(pkg.name, stub.version);
      tarballs.set(`/tarballs/${file}`, craftTarGz(entries));
    }
  }

  const documents = new Map<string, string>();
  const server: Server = createServer((request, response) => {
    if (request.method !== "GET") {
      response.writeHead(405, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    const tarball = tarballs.get(pathname);
    if (tarball !== undefined) {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(tarball);
      return;
    }
    const decoded = decodeURIComponent(pathname);
    for (const [name, doc] of documents) {
      if (decoded === `/${name}`) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(doc);
        return;
      }
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("stub registry failed to bind");
  }
  const origin = `http://127.0.0.1:${address.port}`;

  // Packument documents reference the bound origin, so they are built now.
  for (const pkg of packages) {
    const versions: Record<string, unknown> = {};
    for (const stub of pkg.versions) {
      const file = tarballFileFor(pkg.name, stub.version);
      const tarball = tarballs.get(`/tarballs/${file}`);
      if (tarball === undefined)
        throw new Error(`missing tarball for ${pkg.name}`);
      versions[stub.version] = {
        name: pkg.name,
        version: stub.version,
        dist: {
          tarball: `${origin}/tarballs/${file}`,
          integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
        },
        ...(stub.deps === undefined ? {} : { dependencies: stub.deps }),
        ...(stub.optionalDeps === undefined
          ? {}
          : { optionalDependencies: stub.optionalDeps }),
        ...(stub.peerDeps === undefined
          ? {}
          : { peerDependencies: stub.peerDeps }),
        ...(stub.peerMeta === undefined
          ? {}
          : { peerDependenciesMeta: stub.peerMeta }),
        ...(stub.bin === undefined ? {} : { bin: stub.bin }),
      };
    }
    const sortedVersions = Object.keys(versions).sort();
    const latest = sortedVersions[sortedVersions.length - 1] ?? "0.0.0";
    documents.set(
      pkg.name,
      JSON.stringify({
        name: pkg.name,
        "dist-tags": pkg.tags ?? { latest },
        versions,
      }),
    );
  }

  return {
    url: origin,
    origin,
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error === undefined) resolveClose();
          else rejectClose(error);
        });
      }),
  };
}
