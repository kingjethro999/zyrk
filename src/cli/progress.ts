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

/** Past-tense stage names for the animated display's completed lines. */
const finished: Record<string, string> = {
  "Preparing installation": "Prepared installation",
  "Verifying package sources": "Verified package sources",
  "Preparing shared realizations": "Prepared shared realizations",
  "Preparing approved private builds": "Prepared approved private builds",
  "Linking project dependencies": "Linked project dependencies",
};

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const BAR_WIDTH = 22;
/** 256-color ramp, violet to cyan, applied across the filled bar. */
const RAMP = [99, 105, 111, 117, 123, 159];

function elapsedLabel(ms: number): string {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function bytesLabel(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(1)} KiB`
    : `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

export type InstallCompletion = {
  title: string;
  detail?: string;
  tone?: "success" | "attention";
};

/** Presentation only: never writes to stdout or exposes package URLs or paths. */
export function createInstallProgress(
  stream: { write(chunk: string): unknown; isTTY?: boolean; columns?: number },
  quiet: boolean,
  /**
   * `motion` selects the animated single-line display. It defaults to the
   * color setting, so NO_COLOR and TERM=dumb terminals keep static lines.
   */
  options: { color?: boolean; motion?: boolean } = {},
): {
  update(event: InstallProgress): void;
  close(completion?: InstallCompletion): void;
} {
  const tty = Boolean(stream.isTTY);
  const color = tty && options.color !== false;
  const dim = (value: string) => (color ? `\u001b[2m${value}\u001b[0m` : value);
  const green = (value: string) =>
    color ? `\u001b[32m${value}\u001b[0m` : value;
  const cyan = (value: string) =>
    color ? `\u001b[36m${value}\u001b[0m` : value;
  const bold = (value: string) =>
    color ? `\u001b[1m${value}\u001b[0m` : value;
  const motion = tty && (options.motion ?? color);
  let closed = false;
  let currentStage = "";
  let statusLine = false;
  let lastDownload = 0;
  let lastPlain = "";
  let pendingPlain = "";
  let lastPlainAt = -Infinity;
  let downloadAnnounced = false;
  const startedAt = Date.now();
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
  const flushPlain = () => {
    if (pendingPlain && pendingPlain !== lastPlain) {
      write(`zyrk: ${pendingPlain}\n`);
      lastPlain = pendingPlain;
      lastPlainAt = Date.now();
    }
    pendingPlain = "";
  };

  // Animated display: one live line (spinner, stage, bar, facts, elapsed)
  // redrawn in place; completed stages and packages scroll above it.
  type Live = {
    stage: string;
    startedAt: number;
    detail: string;
    facts: string;
    ratio?: number | undefined;
  };
  let live: Live | undefined;
  let frame = 0;
  let lastDraw = -Infinity;
  let timer: ReturnType<typeof setInterval> | undefined;
  let download: { label: string; bytes: number; at: number } | undefined;
  const bar = (ratio: number) => {
    const filled = Math.round(Math.min(1, Math.max(0, ratio)) * BAR_WIDTH);
    let out = "";
    for (let i = 0; i < filled; i++) {
      const code = RAMP[Math.floor((i / BAR_WIDTH) * RAMP.length)] ?? 159;
      out += color ? `\u001b[38;5;${code}m━\u001b[0m` : "━";
    }
    return out + dim("─".repeat(BAR_WIDTH - filled));
  };
  const draw = () => {
    if (!live || closed) return;
    lastDraw = Date.now();
    // One column short of the edge: a wrapped line cannot be redrawn in place.
    const width = Math.max(24, (stream.columns ?? 80) - 1);
    const elapsed = elapsedLabel(Date.now() - live.startedAt);
    const fixed = 2 + live.stage.length + 2 + elapsed.length;
    const showBar =
      live.ratio !== undefined &&
      fixed + 2 + BAR_WIDTH + (live.detail ? 2 + live.detail.length : 0) <=
        width;
    const room = width - fixed - (showBar ? 2 + BAR_WIDTH : 0) - 2;
    const detail =
      live.detail.length <= room
        ? live.detail
        : room > 1
          ? `${live.detail.slice(0, room - 1)}…`
          : "";
    write(
      `\r\u001b[2K${cyan(FRAMES[frame % FRAMES.length]!)} ${bold(live.stage)}` +
        (showBar ? `  ${bar(live.ratio!)}` : "") +
        (detail ? `  ${dim(detail)}` : "") +
        `  ${dim(elapsed)}`,
    );
    statusLine = true;
  };
  const persist = (line: string) => {
    if (statusLine) write("\r\u001b[2K");
    statusLine = false;
    write(`${line}\n`);
    draw();
  };
  const finishStage = () => {
    if (!live) return;
    const stage = live;
    live = undefined;
    persist(
      `${green("✓")} ${finished[stage.stage] ?? stage.stage}` +
        (stage.facts ? `  ${dim(stage.facts)}` : "") +
        `  ${dim(elapsedLabel(Date.now() - stage.startedAt))}`,
    );
  };
  const stopTimer = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };
  const animate = (event: InstallProgress, packageLabel: string) => {
    const pkg = event.package;
    if (pkg?.status === "linked") {
      const clean = (value: string) =>
        value.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
      persist(`${green("+")} ${clean(pkg.name)} ${dim(clean(pkg.version))}`);
      return;
    }
    if (pkg?.status === "built") {
      if (live) live.detail = "";
      persist(
        `${green("✓")} ${packageLabel} built${event.stage ? ` [${event.stage}]` : ""}${dim(event.durationMs !== undefined ? ` (${event.durationMs}ms)` : "")}`,
      );
      return;
    }
    if (event.phase === "complete") return;
    const stage = labels[event.phase];
    const entered = live?.stage !== stage;
    if (entered) {
      finishStage();
      live = { stage, startedAt: Date.now(), detail: "", facts: "" };
      download = undefined;
      if (timer === undefined) {
        timer = setInterval(() => {
          frame++;
          draw();
        }, 80);
        // The spinner never keeps a finished command alive.
        timer.unref?.();
      }
    }
    const current = live!;
    const counted =
      event.total !== undefined && event.total > 0
        ? `${event.completed ?? 0}/${event.total}`
        : undefined;
    if (pkg?.status === "building") {
      current.ratio = undefined;
      current.detail = `${counted && event.index !== undefined ? `[${event.index}/${event.total}] ` : ""}${packageLabel}${event.stage ? ` (${event.stage})` : ""}`;
    } else if (pkg?.status === "downloading") {
      const bytes = pkg.bytes ?? 0;
      if (download?.label !== packageLabel)
        download = { label: packageLabel, bytes, at: Date.now() };
      const span = Date.now() - download.at;
      const rate =
        span >= 250
          ? ` · ${bytesLabel(((bytes - download.bytes) * 1000) / span)}/s`
          : "";
      current.detail = `↓ ${packageLabel} ${bytesLabel(bytes)}${rate}`;
    } else if (event.phase === "fetching") {
      if (counted) current.ratio = (event.completed ?? 0) / event.total!;
      current.facts = `${counted ?? event.completed ?? 0} · reused ${event.reused ?? 0} · downloaded ${event.downloaded ?? 0}`;
      current.detail = current.facts;
    } else if (event.phase === "building" && counted) {
      current.ratio = (event.completed ?? 0) / event.total!;
      current.facts = `${counted} packages materialized`;
      current.detail = current.facts;
    }
    // Bursts of events share one repaint; the timer covers quiet periods.
    if (entered || Date.now() - lastDraw >= 40) draw();
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
      if (motion) return animate(event, packageLabel);
      if (pkg?.status === "linked") {
        if (tty) clearStatus(true);
        else flushPlain();
        write(`${green("✓")} ${packageLabel} linked\n`);
        return;
      }

      if (pkg?.status === "building") {
        const stageLabel = event.stage ? ` (${event.stage})` : "";
        const indexStr =
          event.index !== undefined && event.total !== undefined
            ? ` [${event.index}/${event.total}]`
            : "";
        const label = `Executing build${indexStr}: ${packageLabel}${stageLabel}`;
        if (tty) {
          clearStatus(false);
          write(`\r\u001b[2K${dim(`› zyrk: ${label}...`)}`);
          statusLine = true;
        } else {
          write(`zyrk: ${label}...\n`);
        }
        return;
      }

      if (pkg?.status === "built") {
        const durationStr =
          event.durationMs !== undefined ? ` (${event.durationMs}ms)` : "";
        const stageLabel = event.stage ? ` [${event.stage}]` : "";
        if (tty) clearStatus(true);
        else flushPlain();
        write(
          `${green("✓")} ${packageLabel} built${stageLabel}${dim(durationStr)}\n`,
        );
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
              : `  Sources verified ${event.completed ?? 0}${event.total === undefined ? "" : `/${event.total}`} · reused ${event.reused ?? 0} · downloaded ${event.downloaded ?? 0}`;
          write(`\r\u001b[2K${dim(status)}`);
          statusLine = true;
        }
        if (event.phase === "building" && event.total !== undefined) {
          const status = `  Preparing private graph: ${event.completed ?? 0}/${event.total} packages materialized`;
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
      const newStage = stage !== currentStage;
      if (newStage) {
        flushPlain();
        currentStage = stage;
        downloadAnnounced = false;
      }
      const firstDownload = pkg?.status === "downloading" && !downloadAnnounced;
      if (pkg?.status === "downloading") downloadAnnounced = true;
      pendingPlain = current;
      const sourcesComplete =
        event.phase === "fetching" &&
        pkg?.status !== "downloading" &&
        event.total !== undefined &&
        event.completed === event.total;
      if (
        newStage ||
        firstDownload ||
        sourcesComplete ||
        Date.now() - lastPlainAt >= 1000
      )
        flushPlain();
    },
    close(completion) {
      if (closed) return;
      stopTimer();
      // A stage is only ticked when the command reports success.
      if (completion && !quiet) finishStage();
      live = undefined;
      if (motion && statusLine) {
        // Failure: remove the unfinished stage so the diagnostic stands alone.
        write("\r\u001b[2K");
        statusLine = false;
      }
      closed = true;
      if (quiet) return;
      if (!tty) flushPlain();
      if (tty) {
        clearStatus(true);
        if (completion) {
          write(`${dim("─".repeat(46))}\n`);
          const marker =
            completion.tone === "attention"
              ? color
                ? "\u001b[33m!\u001b[0m"
                : "!"
              : green("✓");
          write(`${marker} ${completion.title}\n`);
          if (completion.detail) write(`${dim(completion.detail)}\n`);
          write(
            `${dim(`Done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)}\n`,
          );
        }
      }
    },
  };
}
