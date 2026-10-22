# Zyrk engineering and CLI baseline

Reviewed 2026-10-22 against commit `3a813f2` (`v0.7.2`). This is a local
source-and-test review, not a claim that every advertised workflow has been
independently exercised on every supported platform. The provided upgrade
addendum is treated as a backlog, not as evidence about the current
implementation.

## Reproducible baseline

- Environment: Node.js 24.18.0, Linux x64.
- `zyrk run format:check`: passed.
- `zyrk run check`: typecheck, build, and 67 test files passed; 686 tests passed
  and one was skipped.
- CI for `v0.7.2`: the tag release verification and publish workflow passed.
  Platform-specific claims must still be read from the linked evidence and CI
  runs, not inferred from this local Linux result.
- npm reported `0.7.2` as `latest` during this review. At that snapshot, the
  historical releases `0.6.8`, `0.6.9`, and `0.7.0` had not yet been backfilled.
  A follow-up later verified and published the missing versions through `0.7.0`
  under the separate `backfill` dist-tag; `latest` remained `0.7.2`.

## Inventory

| Area                                              | Assessment                        | Evidence and limits                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Verified shared store and reuse                   | Existing and substantial          | `src/store/objects.ts`, `src/store/verify.ts`, `src/store/realize.ts`; corruption and concurrency coverage in `test/store-verify.test.ts` and store tests. This does not establish a measured disk-saving percentage.                                                                                                                                                                                                   |
| Transactional project changes and recovery        | Existing and substantial          | `src/store/txn.ts`, `src/install/repair.ts`, `test/install-recovery.test.ts`; fault injection still needs broader coverage for cancellation, disk-full, and cross-device failures.                                                                                                                                                                                                                                      |
| Lockfiles, workspaces, and npm adoption           | Existing                          | `src/install/workspace-lock.ts`, `src/install/import-npm-workspace.ts`, `test/import-npm-workspace.test.ts`, and workspace tests. Compatibility remains limited to the formats and cases represented by those tests.                                                                                                                                                                                                    |
| Registry scopes, overrides, and credential policy | Existing                          | `src/install/registry-policy.ts`, `src/resolve/overrides.ts`, `test/mixed-registry.test.ts`, `test/overrides-install.test.ts`, `test/network-security.test.ts`; test matrices do not cover every real registry configuration.                                                                                                                                                                                           |
| Lifecycle script trust                            | Improved in `v0.7.0`              | `src/install/private.ts`, `src/cli/main.ts`, and `test/private-builds.test.ts`: TTY install can select exact reviewed sources, only selected scripts run, and selections are persisted in `zyrk-workspace.json`. The picker accepts numbers or `all`; arrow-key checkbox navigation, policy explanations in the picker, and revocation UX remain open. Enter skips scripts and reports intentionally-unbuilt readiness. |
| Install visibility                                | Existing, needs refinement        | `src/cli/progress.ts`, `src/install/progress.ts`, `src/install/run.ts`, and `test/install-progress.test.ts` implement progress and per-package results. Large installs can still produce a long package-by-package wall of text; an optional concise summary/detail split should be evaluated with terminal snapshots.                                                                                                  |
| Errors and scriptable output                      | Existing, needs contract coverage | `src/errors.ts`, `src/log.ts`, and `src/cli/main.ts` provide stable codes, redaction, and versioned JSON. A complete table-driven contract across TTY, redirected output, and JSON is not yet present.                                                                                                                                                                                                                  |
| Framework and OS evidence                         | Partial and evidence-gated        | `docs/compatibility-gates.md`, `docs/framework-smoke.md`, `docs/next-compatibility.md`, and `docs/next-turbopack.md` record specific scenarios. They do not establish universal compatibility; review each evidence file for exact OS, Node, framework, and command.                                                                                                                                                    |
| Performance and storage efficiency                | Unverified                        | No controlled npm/pnpm comparison or statistically meaningful cold/warm benchmark is claimed. Existing reuse output is operational evidence, not a benchmark or disk-savings measurement.                                                                                                                                                                                                                               |
| Documentation site                                | Missing as a site                 | README and task-specific Markdown guides exist; repository docs do not define or operate a standalone documentation website. A site is optional and should follow a verified information architecture.                                                                                                                                                                                                                  |
| Release automation                                | Implemented, recently corrected   | `.github/workflows/npm-publish.yml` publishes from pushed version tags after Linux verification; manual backfills use a non-latest dist-tag. `v0.7.0` exposed and fixed token availability in the publishing job. Historical registry versions remain subject to per-tag checks.                                                                                                                                        |

## Prioritized implementation backlog

### P0 — Trust and operational correctness

1. Finish and verify the npm version backfill from `0.6.7` through the current
   release. Keep `latest` on the newest release and verify every intended exact
   version through `npm view` after registry processing completes.
2. Add fault-injection cases for interrupted installs, disk-full writes,
   cross-device projection, and simultaneous install/GC/repair. Existing
   transaction and concurrency tests are a base, not complete proof of safety.
3. Exercise cancellation through downloads, extraction, build execution, and
   child-process cleanup on Linux, macOS, and Windows CI.

### P1 — Everyday CLI clarity and build review

1. Add terminal snapshots for TTY, non-TTY, `--json`, `NO_COLOR`, `TERM=dumb`,
   narrow output, and interruption. Assert that stdout remains clean for JSON
   and progress never appears in piped output.
2. Evaluate a concise default install summary with an opt-in package breakdown;
   preserve exact package names, versions, reuse counts, skipped builds, and
   readiness without implying time or disk savings.
3. Improve build review with keyboard-selectable choices and visible policy
   denials, while keeping Enter-to-skip, headless installs, mandatory user
   denials, and explicit review semantics intact. Add CLI-level tests for
   selection persistence and deny precedence.
4. Audit error code, exit code, and recovery text together through a
   table-driven test matrix for human and JSON modes.

### P2 — Explainability and onboarding

1. Expand `list` and `why` explanations for importer, peer context, optional and
   platform filtering, override, patch, and physical realization identity.
2. Document migration boundaries for npm, pnpm, and Yarn with verified lock,
   workspace, registry, script, and source-type support. Keep unsupported
   scenarios explicit.
3. Add command examples and parser-backed checks where practical so README and
   help do not drift.

### P3 — Evidence-gated expansion

1. Add reproducible cold, warm, offline, workspace, no-op, and concurrent
   benchmarks before optimizing or making speed claims. Record hardware, OS,
   filesystem, exact graph, cache state, and variance.
2. Extend framework and OS coverage only through real runners and checked-in
   evidence. Do not promote a smoke result into a universal compatibility claim.
3. Consider a documentation site only after task-oriented content and
   accessibility requirements are agreed; keep all package-manager operations
   available from the CLI.
4. Defer GUI/editor dashboards until CLI output, shell completion, and
   machine-readable inspection have demonstrated a remaining user need.

## Scope notes

The source already contains many capabilities listed in the addendum, so they
should not be reimplemented from scratch. This backlog records gaps and
verification work; it does not authorize weakening integrity checks, silently
running scripts, rewriting arbitrary project files, adding telemetry, or
claiming compatibility without evidence. The current approval flow is a
maintainer-requested interactive opt-in: selected lifecycle scripts run with
the invoking user's OS permissions and are not sandboxed.
