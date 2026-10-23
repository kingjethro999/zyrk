# Addendum implementation status

Reviewed 2026-10-23 against `plan_files/ZYRK_CLAUDE_XML_ADDENDUM.md` and
`plan_files/ZYRK_UPGRADE_ADDENDUM.md`, the maintainer brief, and the local
0.7.4 source. This is a source-and-test inventory, not a fresh platform or
framework compatibility run. The two addenda share the same nine upgrade
phases; the Claude addendum adds a concrete website and CLI backlog.

## Current evidence

| Area                   | Verified current state                                                                                                                                                                                                                  | Assessment                                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Package/store core     | Verified source objects, context-specific realizations, project links, transactional publication, and recovery are implemented under `src/install/` and `src/store/`. Root check passed at 0.7.4: 68 test files, 690 passed, 1 skipped. | Existing; preserve invariants I-001 through I-014.                                                                           |
| Install progress       | `src/cli/progress.ts` renders installation phases, downloading bytes, verified-source counts, linked packages, and readiness-aware completion. Progress is quiet when requested and plain when not attached to a TTY.                   | Existing; future work should test the complete TTY, pipe, JSON, and narrow-terminal matrix before changing output contracts. |
| Lifecycle approval     | `src/cli/main.ts` has an interactive candidate selection flow; `src/install/private.ts` and workspace policy code enforce persisted policy.                                                                                             | Existing; improve source and deny-precedence clarity without changing trust defaults.                                        |
| Script shorthand       | `zyrk <script>` is documented in CLI help and dispatches to project scripts.                                                                                                                                                            | Existing; preserve behavior and add command-help coverage where needed.                                                      |
| Website copy panel     | `web/app/page.tsx` shows a static command panel with an `npm` hint, but no button or clipboard behavior.                                                                                                                                | Missing interaction; first P1 slice (W01).                                                                                   |
| Website docs           | Main documentation links leave the site for GitHub README. No `/docs` route exists.                                                                                                                                                     | Missing; next P1/P2 slice (W02).                                                                                             |
| Website trust model    | Landing page covers verified sources, context separation, private builds, portable locks, ordinary imports, and recovery; the terminal display is explicitly illustrative.                                                              | Existing but needs compatibility and limitations information closer to onboarding (W03/W05).                                 |
| Website accessibility  | Focus styles, responsive rules, and reduced-motion handling exist in `web/app/globals.css`; no evidenced browser matrix for 320px, zoom, keyboard, or contrast was found.                                                               | Partially implemented; runtime accessibility remains unverified (W04).                                                       |
| CLI command help       | `helpText()` lists command names and brief descriptions, but does not provide per-command options/examples.                                                                                                                             | Existing but limited; improve as a separate tested slice (CLI-05).                                                           |
| Errors and JSON        | Stable `ZYRK_*` errors, redaction helpers, and schema-versioned JSON output exist.                                                                                                                                                      | Existing; audit targeted high-friction errors before editing (CLI-03).                                                       |
| Platform compatibility | Compatibility docs and CI describe Ubuntu/macOS gates and Windows contract tests; native Windows store installation remains explicitly gated.                                                                                           | Documented, not independently rerun for this review; do not claim universal platform support.                                |
| Performance            | A benchmark/evidence plan exists, but this review did not run controlled npm/pnpm comparisons or gather performance profiles.                                                                                                           | Unverified; optimize only after reproducible measurements.                                                                   |

## Ordered implementation slices

1. **W01 — working install-command copy control.** Add a real keyboard-accessible
   button, polite success/failure feedback, and manual-selection fallback when
   clipboard access is unavailable or denied. Test success and failure paths.
2. **CLI-05 — accurate command help.** Add focused command usage/options/examples
   that match the parser. Preserve npm delegation and existing script shorthand.
3. **WEB-02/W02 — native documentation route.** Add task-oriented getting-started,
   command, compatibility, and troubleshooting content with working in-site
   navigation and a README/source link.
4. **CLI-03 — evidence-backed error improvements.** Select the top recurring or
   confusing codes from source/tests, then improve concise remedies without
   changing stable codes or leaking private data.
5. **W03/W04/W05 — onboarding and accessibility.** Surface Node/platform support
   limits, validate links and claims, and test keyboard, narrow viewport, zoom,
   reduced motion, and contrast behavior.
6. **CLI-01/02/04 — output and approval review.** Add golden tests for TTY/plain/
   JSON and readiness cases; refine exact-source approval details while keeping
   headless and deny-precedence behavior fail-closed.
7. **CLI-06/07 — explainability and previews.** Evaluate update planning and
   dependency/GC details only with explicit no-write proofs and stable JSON.
8. **CORE-01/02/03 — reliability and compatibility.** Expand fault injection,
   real OS runners, and pinned framework smokes. Treat unsupported platform
   states as gates, not implementation targets inferred from Linux.
9. **CORE-04 — performance evidence.** Establish reproducible baselines before
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
