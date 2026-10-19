import type { InstallProgress } from "../install/run.ts";

const labels: Record<InstallProgress["phase"], string> = {
  planning: "Preparing installation",
  resolving: "Resolving dependencies",
  fetching: "Verifying package sources",
  realizing: "Preparing shared realizations",
  building: "Preparing approved private builds",
  linking: "Linking project dependencies",
  complete: "Installation complete",
};

/** Presentation only: never writes to stdout or exposes package URLs or paths. */
export function createInstallProgress(
  stream: { write(chunk: string): unknown; isTTY?: boolean },
  quiet: boolean,
): { update(event: InstallProgress): void; close(): void } {
  let timer: ReturnType<typeof setInterval> | undefined;
  let current = "",
    last = "",
    frame = 0,
    closed = false;
  let lastDownload = 0;
  const write = (text: string) => {
    try {
      stream.write(text);
    } catch {
      /* A display failure cannot alter installation. */
    }
  };
  const render = () =>
    write(`\r\u001b[2K${["|", "/", "-", "\\"][frame++ % 4]} ${current}`);
  return {
    update(event) {
      if (quiet || closed) return;
      const pkg = event.package;
      // Registry names are validated elsewhere; strip control characters here
      // as presentation defense for direct API callers and hostile metadata.
      const label = pkg
        ? `${pkg.name}@${pkg.version}`.replace(/[\x00-\x1f\x7f-\x9f]/g, "")
        : "";
      if (pkg?.status === "linked") {
        if (stream.isTTY) write("\r\u001b[2K");
        write(`✓ ${label} linked\n`);
        return;
      }
      const downloading = pkg?.status === "downloading";
      if (downloading && pkg.bytes && Date.now() - lastDownload < 100) return;
      if (downloading) lastDownload = Date.now();
      current =
        (downloading
          ? `Downloading ${label}: ${((pkg.bytes ?? 0) / 1024).toFixed(1)} KiB`
          : labels[event.phase]) +
        (event.total === undefined
          ? ""
          : ` (${event.completed ?? 0}/${event.total})`) +
        (event.reused === undefined
          ? ""
          : ` — reused ${event.reused}, downloaded ${event.downloaded ?? 0}`);
      if (stream.isTTY) {
        render();
        if (!timer) {
          timer = setInterval(render, 100);
          timer.unref();
        }
      } else if (current !== last) write(`zyrk: ${current}\n`);
      last = current;
    },
    close() {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      if (!quiet && stream.isTTY && current) write("\r\u001b[2K");
    },
  };
}
