# Concurrent Zyrk Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `zyrk run`/`exec`/`dlx` sessions and installs run concurrently across projects (and same-project double-`dev`) without `ZYRK_PROJECT_LOCKED`, while keeping store/GC safety and fixing stale leases that block GC forever.

**Architecture:** The store-global `liveness.lock` is currently held for the entire lifetime of every session and install commit. Sessions only need it to serialize lease _registration_; the sqlite `leases` row is what actually protects generations from GC. Shorten the critical section to registration, reconcile dead lease holders before GC, and surface per-project session state.

**Tech Stack:** TypeScript (strict, `.ts` import extensions), node:sqlite via `openStoreDb`, file locks via `src/util/locks.ts`, Vitest + hermetic stub registry (`test/helpers/registry-stub.ts`).

**Spec:** Design approved in session 2026-11-14 (conversation): registration-only barrier for sessions; dlx barrier through publication only; per-project session visibility; stale-lease reconciliation; non-goals = concurrent installs across projects, per-generation GC granularity.

## Global Constraints

- Never weaken store integrity, lease/GC protection, or transaction recovery (repo `AGENTS.md` + addendum principles).
- Errors use stable `ZYRK_*` codes from `src/errors.ts` with action + remedy; human and `--json` output agree.
- Every behavior ships with a hermetic test; no network in tests.
- One feature/fix per commit; hooks run the full `zyrk run check` gate — never bypass.
- Lock ordering note in `leasedChild`: project lock → store lock order must be preserved where both are held.

## Review Focus

- Orphaned child outliving the zyrk parent: lease `holder_pid` is updated to the child pid in `onSpawn`; if the parent dies but the child lives, the lease must stay active (GC stays blocked) — test that reconciliation does NOT release a lease whose recorded holder is alive.
- Lease registration vs GC race: registration must complete its `INSERT` before releasing `liveness.lock`, and GC must keep acquiring the same lock so it cannot scan leases mid-registration.
- `projects forget` with a live session must fail closed; with only dead sessions it must proceed after reconciliation.
- dlx: releasing the barrier before `runTool` must not allow GC to collect the temp generation — the active lease row must already be committed first.
- Non-Linux platforms: `isProcessAlive` falls back to `kill(pid, 0)`; reconciliation must treat "cannot verify" as alive (conservative), matching `definitelyDead` semantics in `src/util/locks.ts`.

---

### Task 1: Registration-only barrier for `zyrk run`/`exec` sessions

**Files:**

- Modify: `src/commands/project.ts:610-713` (`leasedChild`)
- Test: `test/session-concurrency.test.ts` (create)

**Interfaces:**

- Consumes: `acquireLock`, `openStoreDb`, `superviseChild`, `currentProcessIdentity`, `hostname`, `randomId`, `Store`, `resolveStoreRoot` — all already imported in `project.ts`.
- Produces: no new exports; `leasedChild` signature unchanged.

- [ ] **Step 1: Write the failing test** — `test/session-concurrency.test.ts`, modeled on `test/project-commands.test.ts` (same fixture: stub registry with `alpha` bin, `isolateUserConfig`, `Store.open`, `installProject`). Manifest scripts add `"sleep": "node -e \"setTimeout(()=>{},30000)\""`.
  - `it("runs a session while another install proceeds on the same project")`: start `runProjectCommand({command:"run", args:["sleep"], ...})` (do not await); wait ~300ms; assert `installProject({projectDir, store, registry})` resolves `readiness === "ready"`; then kill the session's process group / await it after shortening the sleep (use a shorter sleep like 2s and await both).
  - `it("runs two sessions concurrently in one project")`: two `runProjectCommand` sleep calls in parallel, both exit 0.
  - `it("keeps the lease active for the session lifetime")`: while sleep session runs, `openStoreDb` shows a lease `state='active'`; after it exits, `state='released'`.

- [ ] **Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/vitest run test/session-concurrency.test.ts`
Expected: the install-while-session test fails (times out or `ZYRK_PROJECT_LOCKED` after 30s — use a short `timeoutMs`? No: `acquireLock` default is 30s; to keep the test fast, assert failure differently — see Step 3 note).

- [ ] **Step 3: Implement in `leasedChild`**

Restructure so `barrier.release()` happens immediately after `registered = true` (lease INSERT committed), before `superviseChild`. The `finally` block keeps the lease `released` UPDATE + `db.close()` but no longer releases the barrier (guard with a `barrierHeld` boolean or release-then-null pattern since `release()` throws `LockLostError` if not owner). `onSpawn`'s lease UPDATE runs on the still-open `db` without the barrier (sqlite serializes writers).

Key correctness: the `INSERT INTO leases` must complete before `barrier.release()` — it already does (synchronous better-sqlite-style call via `openStoreDb`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `./node_modules/.bin/vitest run test/session-concurrency.test.ts test/project-commands.test.ts test/project-runtime-supervision.test.ts test/child-supervision.test.ts`
Expected: PASS (existing lease-lifecycle tests must still pass — lease is still registered and released, just without the lock held throughout).

- [ ] **Step 5: Commit**

```bash
git add src/commands/project.ts test/session-concurrency.test.ts
git commit -m "Release the store liveness barrier after session lease registration"
```

---

### Task 2: Scope the dlx barrier to store publication

**Files:**

- Modify: `src/dlx/run.ts:155-348`
- Test: `test/session-concurrency.test.ts` (extend) or `test/dlx.test.ts`

**Interfaces:**

- Consumes: same lock/db helpers as Task 1; `Transaction` (`txn.finish()`), `installProjection`, `registerGeneration`.
- Produces: no new exports.

- [ ] **Step 1: Write the failing test** — a dlx run of a sleep-like tool while `installProject` runs on a separate project resolves without `ZYRK_PROJECT_LOCKED`. Check `test/dlx.test.ts` for the existing dlx fixture pattern first and reuse it (dlx needs a resolvable tool package in the stub registry — mirror whatever `test/dlx.test.ts` already does).

- [ ] **Step 2: Run test to verify it fails** — expect `ZYRK_PROJECT_LOCKED` or timeout while the dlx child runs.

- [ ] **Step 3: Implement** — in `src/dlx/run.ts`, release `barrier` after `installProjection` completes (lease INSERT at ~line 276 is already committed by then, so GC stays blocked by the active lease). `txn.finish()` and the lease `released` UPDATE + generation `abandoned` UPDATE in the `finally` blocks are sqlite/journal writes — verify `txn.finish()` semantics first: if it finalizes store publication it must run BEFORE `barrier.release()`; if it only cleans the journal it can run after. Keep `envDir` cleanup (`rmrfNoFollow`) outside the barrier — it touches only the temp dir. Use a `barrierHeld` flag so the outer `finally` doesn't double-release.

- [ ] **Step 4: Run tests** — `./node_modules/.bin/vitest run test/dlx.test.ts test/session-concurrency.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/dlx/run.ts test/session-concurrency.test.ts
git commit -m "Release the dlx liveness barrier once tool publication commits"
```

---

### Task 3: Reconcile dead lease holders before collection and status

**Files:**

- Modify: `src/commands/store.ts` (`collect` ~line 555, `status` ~line 480, `listProjects`/`forgetProject` shared helper)
- Test: `test/session-concurrency.test.ts` or `test/maintenance-commands.test.ts`

**Interfaces:**

- Consumes: `isProcessAlive` from `src/util/proc.ts`, `hostname` from `src/util/fsx.ts` (check actual export location — `locks.ts` imports it from `./fsx.ts`), `openStoreDb`.
- Produces: `reconcileLeases(db: ReturnType<typeof openStoreDb>): Promise<number>` — returns count of leases marked released; placed in `src/commands/store.ts` or a small shared module if `project.ts`/`dlx` need it (they don't — only store commands reconcile).

- [ ] **Step 1: Write the failing test** — insert a lease row directly via `openStoreDb` with `state='active'`, `holder_pid` = a definitely-dead pid (e.g., spawn `process.execPath -e ""` wait for exit, reuse its pid — or use pid 999999 which cannot exist; `isProcessAlive` returns false for nonexistent pid), `holder_start_id=null`, `holder_host=hostname()`. Then run the store collect/status path and assert the lease becomes `state='released'` and GC is no longer blocked by it. Also assert a lease with `holder_host` = a different hostname is left untouched.

- [ ] **Step 2: Run test to verify it fails** — lease stays `active`, GC reports the protection reason.

- [ ] **Step 3: Implement `reconcileLeases`** — `SELECT lease_id, holder_pid, holder_start_id, holder_host FROM leases WHERE state='active'`; skip rows where `holder_host !== hostname()`; `await isProcessAlive({pid: holder_pid, startId: holder_start_id})`; if false → `UPDATE leases SET state='released', heartbeat_at=? WHERE lease_id=?`. Call it inside `collect()` right after `openStoreDb` (before the `state != 'released'` check at ~line 560) and inside `status()`. Do NOT call it in `forgetProject` yet — Task 4 adds that.

- [ ] **Step 4: Run tests** — `./node_modules/.bin/vitest run test/session-concurrency.test.ts test/maintenance-commands.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/commands/store.ts test/session-concurrency.test.ts
git commit -m "Reconcile dead lease holders before store collection"
```

---

### Task 4: Per-project session visibility and forget guard

**Files:**

- Modify: `src/commands/store.ts` (`listProjects` ~line 194, `forgetProject` ~line 229, `status` ~line 480)
- Test: `test/session-concurrency.test.ts`

**Interfaces:**

- Consumes: `reconcileLeases` (Task 3), `openStoreDb`, lease `scope_json` → `generationId` → `generations.project_id` join (done in JS: query active leases, parse `scope_json`, look up `SELECT project_id FROM generations WHERE generation_id=?`).
- Produces: `projects list` rows gain `activeSessions: number`; `store status` output gains `activeSessions: number`; `projects forget <id>` throws `ZYRK_POLICY_DENIED` ("active sessions are using this project's generations; stop them first") when reconciled-active leases reference the project.

- [ ] **Step 1: Write the failing test** — with a sleep session running on `project`, `runStoreCommand({command:"projects", args:["list"], ...})` shows `activeSessions: 1` for that project; `projects forget <projectId>` rejects with `ZYRK_POLICY_DENIED`; after the session exits, forget succeeds. Mirror the `runStoreCommand` invocation style from `test/maintenance-commands.test.ts`.

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement** — in `listProjects`, after building the projects map, query `SELECT scope_json FROM leases WHERE state='active'`, parse each `generationId`, resolve `project_id` via `generations`, increment `activeSessions` on matching projects (default 0). In `status`, add total active-session count. In `forgetProject`, run `reconcileLeases(db)` then the same lease→project check; throw `new ZyrkError("ZYRK_POLICY_DENIED", ...)` with remedy "stop the running zyrk sessions for this project, then retry" when count > 0.

- [ ] **Step 4: Run tests** — `./node_modules/.bin/vitest run test/session-concurrency.test.ts test/maintenance-commands.test.ts test/project-commands.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/commands/store.ts test/session-concurrency.test.ts
git commit -m "Surface active sessions per project and guard projects forget"
```

---

## Self-Review notes

- Spec coverage: registration-only barrier (T1), dlx scoping (T2), reconciliation (T3), visibility+forget (T4), same-project concurrent runs (T1 test), cross-project install-during-session (T1 test uses same project; cross-project follows identical code path — the store barrier is the only shared resource and T1 proves it's released).
- deploy.ts barriers intentionally unchanged (deploy is a bounded read-mostly export; it now only contends with installs/GC, not sessions).
- Workspace installs unchanged (they hold the same barrier through commit — installs still serialize store-wide, documented non-goal).
