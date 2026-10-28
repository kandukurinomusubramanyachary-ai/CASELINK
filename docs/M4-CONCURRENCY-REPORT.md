# M4 — concurrency, transactions, retries and evidence staging

CaseLink (SIH26264) · milestone report · verified 2026-10-28

M4 is **complete and executed** against an isolated database. Every claim below is backed by a check in
`test/concurrency-m4.mjs` (38 checks) or by the suites re-run in `test/run-m4.sh`.

---

## 1. Inventory of versioned mutations

Every write that can race is listed here with the version it validates and what it guards. The version
checked is always **the version the caller was shown** (sent in the request), never a silently reloaded
one; a mismatch is `409 stale_version` and nothing is written.

| # | Operation | Entry point | Version check | Guarded writes |
|---|---|---|---|---|
| 1 | Field/lifecycle update | `PATCH /api/cases/:id` | `updateCase` → `assertVersion(body.version)` | `cases` update with `WHERE version = ?` + affected-row count |
| 2 | Action log with optional lifecycle change | `POST /api/cases/:id/actions` | same `updateCase` path | as above (**strict schema**: no lifecycle field here) |
| 3 | Assignment / unassignment | `POST /api/cases/:id/assign` | `assignCase` → `assertVersion` | `cases` update + event + notification |
| 4 | Transfer request | `POST /api/cases/:id/transfer` | `requestTransfer` → `assertVersion` | `transfers` insert + `cases` version bump + event |
| 5 | Transfer decision (accept/reject) | `POST /api/transfers/:id/decision` | `decideTransfer` → `assertVersion` + `transfers.state = 'pending'` | `transfers` decision + `cases` owner/bureau/status + event |
| 6 | Escalate | `POST /api/cases/:id/escalate` | `escalateCase` → `assertVersion` | `cases` escalation flag + event + notifications |
| 7 | Close escalation | `POST /api/cases/:id/escalation/close` | `closeEscalation` → `assertVersion` | `cases` flag + event |
| 8 | Reopen disposed/closed case | `POST /api/cases/:id/reopen` | `reopenCase` → `assertVersion` | `cases` status/outcome clear + `dispositions.reopened_at` + event |
| 9 | Deadline change | `POST /api/cases/:id/deadline` | `changeDeadline` → `assertVersion` | `cases` deadline + event |
| 10 | Triage resolution | `POST /api/cases/:id/triage` | `resolveTriage` → `assertVersion` | `cases` institution/triage + event |
| 11 | Grant / revoke access | `POST /api/cases/:id/grants` | `grantCaseAccess` / `revokeCaseAccess` → `assertVersion` | `case_grants` + `cases` version bump + event |
| 12 | Relationship decision | `POST /api/suggestions/:id/decision` | **both** case versions (`caseAVersion`, `caseBVersion`) + suggestion state | `relationships` insert, `suggestions` state, both cases' events |
| 13 | Relationship revoke | `POST /api/relationships/:id/revoke` | both case versions + `relationships.state = 'active'` | relationship revoke + suggestion state + both cases' events |
| 14 | Evidence upload | `POST /api/cases/:id/attachments` | `version` field (multipart) when supplied | `attachments` insert + event + `cases` version bump |
| 15 | Evidence removal | `DELETE /api/cases/:id/attachments/:id?version=` | `assertVersion` | `attachments` delete + event + `cases` version bump |

Status ordering is fixed: **401** unauthenticated → **403** unauthorised (checked first, and logged to
the security log) → **422** invalid input → **409** stale version / already-decided / already-pending.

## 2. Guarded writes and affected-row counts

`guardWrite(changed)` (in `service.ts`) throws `409 stale_version` unless exactly one row changed. It is
applied to every versioned `UPDATE`, to the transfer decision, to the suggestion state transition, to
the relationship revoke and to the attachment delete, so a write that loses a race can never continue
into the event/notification code.

## 3. One transaction per mutation

Mutation + business event + queued background work commit together; jobs drain **after** the commit:

* `updateCase`, `assignCase`, `requestTransfer`, `decideTransfer`, `escalateCase`, `closeEscalation`,
  `reopenCase`, `changeDeadline`, `resolveTriage`, grants, relationship decisions and evidence writes
  all run inside `tx(...)` on the route, with `drainJobs()` after it returns.
* `enqueue()` now honours an administrator-controlled fault hook, which is what makes the rollback
  provable: with `inject_job_failure` on, a `PATCH` that changes status fails with 500 and the case
  version, status, event count and job count are all unchanged (4b). With the hook off the same
  mutation succeeds and enqueues three jobs (4c).

## 4. Idempotency

`idempotency_keys` gained a `request_hash` column (migration v3). Behaviour:

* same key + same payload → the original response is replayed with `Idempotent-Replay: true`, no second
  case, transfer or notification (3a–3c, 3e–3f);
* same key + **different payload** → `409 idempotency_conflict` (3d);
* the idempotency record is written in the same transaction as the mutation, so a retry after a failed
  commit creates nothing;
* authority is re-checked on every attempt *before* the replay lookup, so replaying a transfer request
  after the case has moved to another bureau returns `403`, not a cached success (3g).

## 5. Evidence staging and cleanup

Upload path: validate authority → validate file → write to `.staging-<uuid>-<name>` → insert row + event
+ version bump in one transaction → move the staged file into place. On any failure the staged bytes are
removed, so no orphan file and no phantom row (5a). Deleting evidence removes the row (guarded, versioned)
and then removes the file **only when no other attachment row references it** — the same bytes uploaded
twice share one stored file, deleting one of the two keeps the file (5h), deleting the last reference
removes it (5i). A stale delete is refused with 409 (5g).

## 6. Fault injection stays administrative and opt-in

`POST /api/system/inject-audit-failure` requires an administrator and is refused unless the instance was
started with `CASELINK_TEST_HOOKS=true` (or demo mode). The M4 runner proves both directions: with the
hook on, 38/38 checks pass; with the hook off the same suite reports **33 passed, 2 skipped** — the two
fault-injection checks are reported as skipped, never as passes.

## 7. Security log vs business history

Denied attempts are written to `security_log` and never to `action_events` (6a–6c). A stale save is an
ordinary business conflict: it writes no business event and is not a security incident (6d–6e).

## 8. Executed verification

```
bash test/run-m4.sh

=============== M4 concurrency, transactions, retries (hooks on) ===============
executed: 38   passed: 38   failed: 0   skipped: 0
M4 concurrency, transactions and retries: PASS

=============== M3 lifecycle, outcomes and reporting ===============
executed: 79   passed: 79   failed: 0   skipped: 0
M3 lifecycle, outcomes and reporting: PASS

=============== Acceptance suite T01–T12 ===============
21/21 checks passed.

=============== M4 suite on an instance with the fault-injection hook disabled :8108 ===============
executed: 33   passed: 33   failed: 0   skipped: 2
  skipped: 4a-4d fault injection (rollback proof) — the administrator-only fault-injection hook is disabled…
  skipped: 5a a failed upload leaves no row and no file — the administrator-only fault-injection hook is disabled…
M4 concurrency, transactions and retries: PASS

=============== M2 relationship privacy regressions ===============
40/40 executed checks passed

=============== In-place migration of a copy of the existing database ===============
executed: 13   passed: 13   failed: 0   skipped: 0 (applies migrations 1, 2, 3)

M4 verification: ALL SUITES PASSED
```

`bash test/run-m1.sh` on the same build: 65/65 M1 security checks, 58/58 M1.1 regional checks, 8/8
demo-mode checks, 21/21 acceptance, the 14 sign-in checks, the 13 direct-entry checks and the interface
smoke run (20 screenshots, 0 console errors) — all passed.

## 9. Files changed in M4

```
server/src/service.ts    guardWrite + assertVersion on assign/transfer request/decision/escalate/
                         closeEscalation/changeDeadline/resolveTriage/grants/relationship decisions;
                         guarded suggestion + relationship state writes
server/src/index.ts      version in every mutation body; tx + drain-after-commit everywhere;
                         idempotency fingerprint + conflict + atomic key write; staged, rollback-safe
                         uploads; DELETE evidence route; injectable audit/job faults
server/src/worker.ts     enqueue() honours the administrator-only job fault hook
server/src/migrations.ts migration v3: idempotency_keys.request_hash
server/src/schema.sql    mirrored request_hash column
web/src/api.ts           every mutation sends the record version; upload/delete evidence helpers
web/src/screens/CaseWorkspace.tsx  passes the loaded version to each action
test/concurrency-m4.mjs  38-check M4 suite
test/run-m4.sh           repeatable M4 verification (hooks on and off)
test/acceptance.mjs      T06/T07 send versions (same assertions)
test/security-m1*.mjs, test/security-m2.mjs  send the version they read; M2 read-back helper fixed
```

## 10. Remaining work after M4

M5 (CSV import identity), M6 (refresh, matching evaluation and performance) and M7 (full acceptance
pass with the test-reporting fix, docs, demo script, clean archive) are still open.
