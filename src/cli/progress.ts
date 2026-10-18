import type { InstallProgress } from "../install/run.ts";

const labels: Record<InstallProgress["phase"], string> = {
  planning: "Preparing installation",
  resolving: "Resolving dependencies",
  fetching: "Verifying package sources",
  realizing: "Preparing shared realizations",
  building: "Preparing approved private builds",
  linking: "Linking project dependencies",
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
      current =
        labels[event.phase] +
        (event.total === undefined
          ? ""
          : ` (${event.completed ?? 0}/${event.total})`);
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
