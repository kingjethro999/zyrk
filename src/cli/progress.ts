import type { InstallProgress } from "../install/run.ts";

const labels: Record<InstallProgress["phase"], string> = {
  planning: "Preparing installation",
  resolving: "Preparing installation",
  fetching: "Verifying package sources",
  realizing: "Preparing shared realizations",
  building: "Preparing approved private builds",
  linking: "Linking project dependencies",
  complete: "Installation complete",
};

export type InstallCompletion = {
  title: string;
  detail?: string;
};

/** Presentation only: never writes to stdout or exposes package URLs or paths. */
export function createInstallProgress(
  stream: { write(chunk: string): unknown; isTTY?: boolean },
  quiet: boolean,
  options: { color?: boolean } = {},
): {
  update(event: InstallProgress): void;
  close(completion?: InstallCompletion): void;
} {
  const tty = Boolean(stream.isTTY);
  const color = tty && options.color !== false;
  const dim = (value: string) => (color ? `\u001b[2m${value}\u001b[0m` : value);
  const green = (value: string) =>
    color ? `\u001b[32m${value}\u001b[0m` : value;
  let closed = false;
  let currentStage = "";
  let statusLine = false;
  let lastDownload = 0;
  let lastPlain = "";
  const write = (text: string) => {
    try {
      stream.write(text);
    } catch {
      /* A display failure cannot alter installation. */
    }
  };
  const clearStatus = (lineBreak: boolean) => {
    if (!statusLine) return;
    write(`\r\u001b[2K${lineBreak ? "\n" : ""}`);
    statusLine = false;
  };

  return {
    update(event) {
      if (quiet || closed) return;
      const pkg = event.package;
      // Strip control characters as presentation defense for direct API
      // callers and hostile registry metadata.
      const packageLabel = pkg
        ? `${pkg.name}@${pkg.version}`.replace(/[\x00-\x1f\x7f-\x9f]/g, "")
        : "";
      if (pkg?.status === "linked") {
        if (tty) clearStatus(true);
        write(`${green("✓")} ${packageLabel} linked\n`);
        return;
      }

      const stage = labels[event.phase];
      if (tty) {
        if (stage !== "Installation complete" && stage !== currentStage) {
          clearStatus(true);
          write(`${dim(`› zyrk: ${stage}`)}\n`);
          currentStage = stage;
        }
        if (pkg?.status === "downloading" || event.phase === "fetching") {
          if (
            pkg?.status === "downloading" &&
            pkg.bytes &&
            Date.now() - lastDownload < 100
          )
            return;
          lastDownload = Date.now();
          const status =
            pkg?.status === "downloading"
              ? `  Downloading ${packageLabel}: ${((pkg.bytes ?? 0) / 1024).toFixed(1)} KiB`
              : `  Sources verified ${event.completed ?? 0}/${event.total ?? 0} · reused ${event.reused ?? 0} · downloaded ${event.downloaded ?? 0}`;
          write(`\r\u001b[2K${dim(status)}`);
          statusLine = true;
        }
        return;
      }

      const current =
        (pkg?.status === "downloading"
          ? `Downloading ${packageLabel}: ${((pkg.bytes ?? 0) / 1024).toFixed(1)} KiB`
          : stage) +
        (event.total === undefined
          ? ""
          : ` (${event.completed ?? 0}/${event.total})`) +
        (event.reused === undefined
          ? ""
          : ` — reused ${event.reused}, downloaded ${event.downloaded ?? 0}`);
      if (current !== lastPlain) write(`zyrk: ${current}\n`);
      lastPlain = current;
    },
    close(completion) {
      if (closed) return;
      closed = true;
      if (quiet) return;
      if (tty) {
        clearStatus(true);
        if (completion) {
          write(`${dim("─".repeat(46))}\n`);
          write(`${green("✓")} ${completion.title}\n`);
          if (completion.detail) write(`${dim(completion.detail)}\n`);
        }
      }
    },
  };
}
