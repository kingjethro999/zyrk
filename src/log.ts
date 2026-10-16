/**
 * Logging for humans goes to stderr; command results go to stdout (the CLI
 * layer owns result rendering). Nothing here ever prints a credential
 * (SPEC 15.4): all strings pass through redaction.
 */

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // key=value pairs common in registry configuration and URLs
  [
    /((?:_authToken|_auth|_password|password|token|secret|key)=)([^&\s"']+)/gi,
    "$1***",
  ],
  // npm classic tokens
  [/\bnpm_[A-Za-z0-9]{36}\b/g, "npm_***"],
  // Authorization header values and bare bearer tokens
  [/(Bearer)\s+[A-Za-z0-9._~+/-]+=*/gi, "$1 ***"],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,})/g, "***"],
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export type Logger = {
  level: LogLevel;
  debug(message: string, detail?: Record<string, unknown>): void;
  info(message: string, detail?: Record<string, unknown>): void;
  warn(message: string, detail?: Record<string, unknown>): void;
  error(message: string, detail?: Record<string, unknown>): void;
};

export function createLogger(
  options: { level?: LogLevel; stream?: NodeJS.WritableStream } = {},
): Logger {
  const level = options.level ?? "info";
  const stream = options.stream ?? process.stderr;

  const emit = (
    at: LogLevel,
    message: string,
    detail?: Record<string, unknown>,
  ): void => {
    if (LEVEL_ORDER[at] < LEVEL_ORDER[level]) return;
    let line = message;
    if (detail !== undefined) {
      const rendered = Object.entries(detail)
        .map(([key, value]) => `${key}=${renderValue(value)}`)
        .join(" ");
      if (rendered !== "") line += ` (${rendered})`;
    }
    stream.write(`${redactSecrets(line)}\n`);
  };

  return {
    level,
    debug: (message, detail) => emit("debug", message, detail),
    info: (message, detail) => emit("info", message, detail),
    warn: (message, detail) => emit("warn", message, detail),
    error: (message, detail) => emit("error", message, detail),
  };
}

function renderValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  if (value === null || value === undefined) return String(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "[unrenderable]";
  }
}

/** A logger that drops everything; for tests and library use. */
export const silentLogger: Logger = {
  level: "error",
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
