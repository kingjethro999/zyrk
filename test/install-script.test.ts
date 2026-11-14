import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmrfNoFollow } from "../src/util/fsx.ts";

const installer = path.resolve(import.meta.dirname, "../install.sh");
const tarball = "not really a tarball; the stub npm never unpacks it\n";

let root: string, bin: string, served: string, log: string;

/** Stub curl, npm and zyrk so the installer never touches the network. */
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "zyrk-install-script-"));
  bin = path.join(root, "bin");
  served = path.join(root, "served");
  log = path.join(root, "calls.log");
  for (const dir of [bin, served]) await mkdir(dir);
  await writeFile(log, "");
  await writeFile(path.join(served, "zyrk-9.9.9.tgz"), tarball);
  await writeFile(
    path.join(served, "zyrk-9.9.9.tgz.sha256"),
    `${createHash("sha256").update(tarball).digest("hex")}  zyrk-9.9.9.tgz\n`,
  );
  const stub = async (name: string, body: string) => {
    await writeFile(path.join(bin, name), `#!/bin/sh\n${body}\n`);
    await chmod(path.join(bin, name), 0o755);
  };
  await stub(
    "curl",
    `out="" url="" effective=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift ;;
    -w) effective=1; shift ;;
    http*) url="$1" ;;
  esac
  shift
done
echo "curl $url" >> "${log}"
if [ -n "$effective" ]; then
  printf '%s' "https://github.com/kingjethro999/zyrk/releases/tag/v9.9.9"
  exit 0
fi
[ -f "${served}/\${url##*/}" ] || exit 22
cp "${served}/\${url##*/}" "$out"`,
  );
  await stub(
    "npm",
    `case "$1" in
  -v) echo 11.0.0 ;;
  prefix) echo /stub ;;
  *) echo "npm $*" >> "${log}" ;;
esac`,
  );
  await stub("zyrk", "echo 9.9.9");
});
afterEach(async () => {
  await rmrfNoFollow(root);
});

function install(...args: string[]) {
  const result = spawnSync("sh", [installer, ...args], {
    encoding: "utf8",
    env: {
      PATH: [bin, path.dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
      TMPDIR: root,
      NO_COLOR: "1",
    },
  });
  return { ...result, output: result.stdout + result.stderr };
}
const calls = async () => (await readFile(log, "utf8")).trim().split("\n");

describe.skipIf(process.platform === "win32")("install.sh", () => {
  it("installs the latest release tarball only after its digest matches", async () => {
    const result = install();
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("SHA-256 matches the release digest");
    expect(result.output).toContain("zyrk 9.9.9 is ready");
    const made = await calls();
    expect(made).toContain(
      "curl https://github.com/kingjethro999/zyrk/releases/download/v9.9.9/zyrk-9.9.9.tgz",
    );
    expect(made.at(-1)).toMatch(/^npm install --global .*\/zyrk-9\.9\.9\.tgz$/);
  });

  it("installs a pinned release without resolving the latest one", async () => {
    await writeFile(path.join(served, "zyrk-1.2.3.tgz"), tarball);
    await writeFile(
      path.join(served, "zyrk-1.2.3.tgz.sha256"),
      `${createHash("sha256").update(tarball).digest("hex")}\n`,
    );
    const result = install("--version", "1.2.3");
    expect(result.status, result.output).toBe(0);
    const made = await calls();
    expect(made.some((call) => call.includes("releases/latest"))).toBe(false);
    expect(made[0]).toBe(
      "curl https://github.com/kingjethro999/zyrk/releases/download/v1.2.3/zyrk-1.2.3.tgz",
    );
  });

  it("refuses to install a download whose digest differs or is unpublished", async () => {
    await writeFile(path.join(served, "zyrk-9.9.9.tgz"), "tampered\n");
    const altered = install();
    expect(altered.status).toBe(1);
    expect(altered.output).toContain("SHA-256 mismatch for zyrk-9.9.9.tgz");

    await rmrfNoFollow(path.join(served, "zyrk-9.9.9.tgz.sha256"));
    const unpublished = install();
    expect(unpublished.status).toBe(1);
    expect(unpublished.output).toContain("Refusing to install it");
    expect((await calls()).some((call) => call.startsWith("npm"))).toBe(false);
  });

  it("uses the legacy npm package only when asked and rejects unknown input", async () => {
    const legacy = install("--npm");
    expect(legacy.status, legacy.output).toBe(0);
    expect(await calls()).toEqual(["npm install --global zyrk@0.8.9"]);
    expect(install("--version", "../../evil").status).toBe(1);
    expect(install("--global").status).toBe(2);
  });
});
