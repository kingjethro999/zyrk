# Addendum implementation status

Reviewed 2026-10-26 against `plan_files/ZYRK_CLAUDE_XML_ADDENDUM.md` and
`plan_files/ZYRK_UPGRADE_ADDENDUM.md`, the maintainer brief, and the local
0.8.5 source. This is a source-and-test inventory, not a fresh platform or
framework compatibility run. The two addenda share the same nine upgrade
phases; the Claude addendum adds a concrete website and CLI backlog.

## Completed implementation slices

| Slice                                   | Commit               | Evidence                                                                                                                                                                                                                                                                                                            |
| --------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W01 — accessible command copy control   | `1b88ce2` (`v0.7.6`) | Unit tests cover exact clipboard content, unavailable clipboard, and denied writes. The full repository hook passed: 69 test files, 693 passed, 1 skipped.                                                                                                                                                          |
| WEB-02/W02 — native documentation route | `93006ac` (`v0.7.7`) | `web/app/docs/page.tsx` provides getting started, command index, platform and framework boundaries, build-script trust, timeout troubleshooting, source links, and in-site navigation. Web lint/build and local HTTP 200 route check passed; the full repository hook passed: 69 test files, 693 passed, 1 skipped. |
| CLI-05 — focused command help           | `71240c7` (`v0.7.8`) | Native commands have command-specific usage, supported options, and examples; `docker init/build/run --help` has action-level help. Integration coverage checks the full native command surface and side-effect-free dispatch. The full hook passed: 69 test files, 721 passed, 1 skipped.                          |
| CLI-03 — focused install remedies       | `8e130b2` (`v0.7.9`) | Install failures now retain stable codes while naming the failed state and a concrete recovery action. Table-driven integration coverage verifies human and JSON guidance without exposing unsafe source URLs.                                                                                                      |
| W03/W04/W05 — bounded onboarding        | `b0103a3` (`v0.8.1`) | The website places Node and native-platform limits before bootstrap, separates verification from code trust, and adds responsive platform/trust layouts with skip navigation and control focus. Web lint/build passed; Chrome captures at 320px and 1440px showed no horizontal clipping.                           |
| CLI-04 — policy-aware build review      | `v0.8.2`             | Exact build sources are classified as approved, pending, or denied with their policy scope; human review shows lifecycle commands, persistence, and unsandboxed risk. Mandatory denies retain precedence without blocking approval of an unrelated permitted source. Full check: 71 files, 729 passed, 1 skipped.   |

## Progress-output slice (`v0.8.3`)

Redirected installs coalesce repeated source and download updates at a one-second
interval, flush the latest values at phase changes and close, and preserve
committed package link lines. Unknown totals no longer appear as a fictitious
zero total in TTY output. Install and dependency mutation footers distinguish
intentionally-unbuilt readiness with an attention marker. JSON output stays
outside the progress renderer. Clock-controlled tests reproduce a burst of 500
source events, exercise periodic downloads, failure close, final flush, and
idempotent closure. Narrow-terminal and full output-schema coverage remain
follow-up CLI-01/02 work.

## Current evidence

CI follow-up: the first approval-review fixture assumed Linux config paths;
`v0.8.4` uses the shared platform-aware user-config helper instead. Windows CI
also exposed a pre-existing npm-lock peer-placement defect. The `v0.8.5` slice
places peers beside or above their consumers before traversing child packages.
An Arborist regression reproduced `PEER LOCAL` before the fix. After refreshing
the checkout lock, all 464 npm entries have valid Arborist edges, the Zyrk graph
extension is byte-equivalent as JSON, and `npm ci --dry-run --ignore-scripts`
accepts the refreshed layout. Real macOS/Windows CI results must still be checked
after pushing these corrections.

| Area                   | Verified current state                                                                                                                                                                                                                  | Assessment                                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Package/store core     | Verified source objects, context-specific realizations, project links, transactional publication, and recovery are implemented under `src/install/` and `src/store/`. Root check passed at 0.7.4: 68 test files, 690 passed, 1 skipped. | Existing; preserve invariants I-001 through I-014.                                                                           |
| Install progress       | `src/cli/progress.ts` renders installation phases, downloading bytes, verified-source counts, linked packages, and readiness-aware completion. Progress is quiet when requested and plain when not attached to a TTY.                   | Existing; future work should test the complete TTY, pipe, JSON, and narrow-terminal matrix before changing output contracts. |
| Lifecycle approval     | Interactive install reviews exact candidates; separate review reports approved, pending, and denied states and persists permitted exact-source decisions to `zyrk-workspace.json`.                                                      | Policy-aware review is implemented; checkbox navigation and explicit revocation remain separate follow-up slices.            |
| Script shorthand       | `zyrk <script>` is documented in CLI help and dispatches to project scripts.                                                                                                                                                            | Existing; preserve behavior and add command-help coverage where needed.                                                      |
| Website copy panel     | The landing-page command panel has an accessible copy button, selectable command fallback, and polite success/failure status.                                                                                                           | Implemented and tested in `1b88ce2`.                                                                                         |
| Website docs           | A native `/docs` route provides task-oriented onboarding, command examples, evidence-bounded compatibility guidance, troubleshooting, and links to the detailed README and policies.                                                    | Implemented; web lint, production build, and local HTTP route check passed.                                                  |
| Website trust model    | Landing page separates archive verification, immutable dependency contexts, project-local writable state, and the unsandboxed script-approval boundary.                                                                                 | Implemented in the current W03/W04/W05 slice; claims remain bounded by recorded compatibility evidence.                      |
| Website accessibility  | Skip navigation, link and button focus styles, responsive platform/trust layouts, long-command wrapping, and reduced-motion handling exist in `web/app/globals.css`.                                                                    | Implemented in the current W03/W04/W05 slice; browser verification is recorded before commit.                                |
| CLI command help       | Native commands provide focused usage, supported options, and examples through `zyrk <command> --help`; npm-delegated help still goes to npm.                                                                                           | Implemented in the current CLI-05 slice; integration coverage checks every native command and side-effect-free dispatch.     |
| Errors and JSON        | Stable `ZYRK_*` errors, redaction helpers, schema-versioned JSON output, and focused install recovery guidance exist.                                                                                                                   | Focused install remedies shipped in `8e130b2`; continue expanding only from reproduced failures.                             |
| Platform compatibility | Compatibility docs and CI describe Ubuntu/macOS gates and Windows contract tests; native Windows store installation remains explicitly gated.                                                                                           | Documented, not independently rerun for this review; do not claim universal platform support.                                |
| Performance            | A benchmark/evidence plan exists, but this review did not run controlled npm/pnpm comparisons or gather performance profiles.                                                                                                           | Unverified; optimize only after reproducible measurements.                                                                   |

## Ordered implementation slices

1. **CLI-01/02/04 — output and approval review.** Add golden tests for TTY/plain/
   JSON and readiness cases; refine exact-source approval details while keeping
   headless and deny-precedence behavior fail-closed.
2. **CLI-06/07 — explainability and previews.** Evaluate update planning and
   dependency/GC details only with explicit no-write proofs and stable JSON.
3. **CORE-01/02/03 — reliability and compatibility.** Expand fault injection,
   real OS runners, and pinned framework smokes. Treat unsupported platform
   states as gates, not implementation targets inferred from Linux.
4. **CORE-04 — performance evidence.** Establish reproducible baselines before
   tuning or making speed/storage claims. No telemetry is introduced.

Each slice must include tests and user-facing docs where behavior changes, pass
the repository check gate, and land in its own commit. No slice may weaken
verified-content immutability, project isolation, explicit script trust,
transaction recovery, portability, or machine-readable output.

## Not verified in this review

No real Windows/macOS filesystem test, browser assistive-technology audit,
cross-framework compatibility matrix, controlled performance benchmark, or
concurrent install/GC fault-injection campaign was run as part of this source
review. Existing docs and CI declarations are not substitutes for those runs.
