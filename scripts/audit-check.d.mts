export type AuditOutcome =
  | { kind: "clean"; exitCode: 0; total: 0 }
  | { kind: "vulnerabilities"; exitCode: 1; total: number }
  | { kind: "unavailable"; exitCode: 2 };

export function classifyAudit(result: {
  status: number | null;
  stdout: string;
  signal?: string | null;
  error?: unknown;
}): AuditOutcome;

export function runAudit(): number;
