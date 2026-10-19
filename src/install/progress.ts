import type { InstallOptions, InstallProgress } from "./run.ts";

type Package = { name: string; version: string };
/** Counts verified source identities, independent of peer-split realizations. */
export function sourceProgress(
  onProgress: InstallOptions["onProgress"],
  total: number,
) {
  let reused = 0,
    downloaded = 0;
  const emit = (pkg: InstallProgress["package"]) =>
    onProgress?.({
      phase: "fetching",
      total,
      completed: reused + downloaded,
      reused,
      downloaded,
      ...(pkg ? { package: pkg } : {}),
    });
  return {
    downloading(pkg: Package) {
      let bytes = 0;
      emit({
        name: pkg.name,
        version: pkg.version,
        status: "downloading",
        bytes,
      });
      return (chunk: number) => {
        bytes += chunk;
        emit({
          name: pkg.name,
          version: pkg.version,
          status: "downloading",
          bytes,
        });
      };
    },
    verified(pkg: Package, status: "reused" | "downloaded") {
      if (status === "reused") reused++;
      else downloaded++;
      emit({ name: pkg.name, version: pkg.version, status });
    },
  };
}
/** Only called after transactional projection publication succeeds. */
export function reportLinked(
  onProgress: InstallOptions["onProgress"],
  packages: readonly Package[],
) {
  const unique = new Map(
    packages.map((pkg) => [JSON.stringify([pkg.name, pkg.version]), pkg]),
  );
  for (const pkg of unique.values())
    onProgress?.({
      phase: "complete",
      package: { name: pkg.name, version: pkg.version, status: "linked" },
    });
}
