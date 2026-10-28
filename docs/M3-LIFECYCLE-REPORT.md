# M3 — lifecycle, structured outcomes and reporting definitions

CaseLink (SIH26264) · milestone report · verified 2026-10-28

M3 is **complete and executed**. Everything below was run on an isolated database, not on the working
demo database. Command block and real output are at the end of this report.

---

## 1. What M3 had to fix

The P0 build had one lifecycle table duplicated in the API layer, no durable place to store a
disposition decision, a status picker that could move a disposed case back to review, and report
totals that mixed "disposed now" with "disposed during the period". M3 replaces that with one
authority for lifecycle rules, a structured disposition record, a protected reopening operation and
explicitly defined report metrics.

## 2. One lifecycle matrix

`server/src/domain.ts` now owns the only transition table:

| From | Allowed next states | Protected path |
|---|---|---|
| Received | Assigned | — |
| Assigned | Under review, Awaiting response, Received | — |
| Under review | Awaiting response, Disposed | — |
| Awaiting response | Under review, Disposed | — |
| Disposed | Closed | **Under review — reopening operation only** |
| Closed | — | **Under review — reopening operation only** |

* `TRANSITIONS`, `REOPEN_FROM`, `REOPEN_TO`, `isValidTransition`, `requiresReopenOperation` and
  `nextStatesFor` live in `domain.ts`; the API's `optionsFor()` (which feeds the interface's status
  picker) and the service's validation both call them, so the interface and the backend cannot drift.
* Reopening is **not** in the generic matrix. `updateCase` rejects a `PATCH` that tries to move a
  Disposed/Closed case to Under review with `422 use_reopen_operation`, logs the attempt in the
  security log, and leaves the record untouched.
* The action form (`POST /api/cases/:id/actions`) now rejects unknown fields (`.strict()`), so a
  client cannot smuggle `status` into an action request and expect it to be ignored silently — it is
  refused with `422 validation_error`.
* Disposal and closing remain bureau-lead actions (`transitionNeedsLead`).

## 3. Structured disposition (durable, reload-safe, reopen-safe)

* Case columns `outcome` and `decision_reference` (migration v1) plus a `dispositions` table holding
  the durable record: outcome, decision reference, note, actor, timestamp, version, and
  `reopened_at` when a later reopening supersedes it.
* Recording a disposition requires **both** a structured outcome (closed vocabulary:
  `DISPOSITION_OUTCOMES`) and a decision reference. Remarks are the narrative and can never stand in
  for either — verified: a remarks-only disposal returns `422` with `fields.outcome`.
* Visibility: the case response carries `outcome` / `decisionReference`, the case detail carries a
  `dispositions` history (newest first) and report exports gained `outcome` and
  `decision_reference` columns. Restricted (coordination-only) views expose `outcomeRecorded: true`
  and nothing else — no free text, no reference.
* Reopening clears the *current* outcome fields and stamps `reopened_at` on the disposition row; the
  historical record is never deleted, rewritten or recreated.
* Legacy records: cases disposed before this schema existed are **flagged, never invented**.
  Migration v2 writes one `migration_notes` row per such case ("…were not recorded and have not been
  invented"), and the report counts them in `legacyDisposedWithoutOutcome`. The interface shows
  "No structured disposition recorded — flagged rather than filled in with a guessed outcome".

## 4. Canonical transition events

* `updateCase` writes one event whose type is the lifecycle change itself
  (`status_disposed`, `status_closed`, `status_assigned`, …). The officer's chosen note category is
  stored as `after.noteCategory`, and `after.transition` records `{from, to}`.
* Consequence: a disposition recorded under the "Internal note" category is still a disposition in
  history, in exports and in reporting. Verified (3a–3e): exactly one `status_disposed` event, no
  duplicates per version, `max(event.version_after) === case.version`.

## 5. Protected reopening

`POST /api/cases/:id/reopen` requires the owning-bureau lead (`modify_case` + lead authority), a
reason of at least 5 characters and the version the reviewer was shown.

Verified behaviour: officer `403`, foreign-bureau lead `403`, missing reason `422`, stale version
`409`, reopening a case that is not disposed/closed `422`, `PATCH` bypass `422`, action-form bypass
`422`. A successful reopening keeps the receipt time, keeps the earlier disposition (with
`reopened_at`) and writes exactly one `reopened` event with its reason.

## 6. Next-action semantics

`undefined` = field not submitted → stored value kept. `null` = explicit clear. Verified: an edit
that does not mention the next action keeps it; an explicit `null` clears it; an action-form
submission that omits the next step keeps it; an explicit `null` from the action form clears it.
The route previously coerced `undefined` to `null` (silently erasing the field) — that is fixed.

## 7. Ownership through transfers, and escalation

* A pending transfer changes nothing (owner, bureau and status unchanged). The sending bureau cannot
  decide its own request (`403`). A recipient decision naming an officer from the wrong bureau, a
  non-case-worker role, or an officer outside the case region is rejected (`422`) **before** any
  write, leaving the case untouched.
* Acceptance moves bureau + owner + status in one guarded update guarded by the transfer state and
  the case version; a second acceptance returns `409` and writes no second event.
* Escalation remains a flag, never a lifecycle state: opening/closing the flag leaves the status and
  version semantics alone, a second open escalation is `409`, and the responsible supervisor must be
  authorised for the case region (`422` otherwise).

## 8. Reporting definitions

`GET /api/reports/summary` returns `totals` plus a `definitions` block so the numbers cannot be read
ambiguously:

| Metric | Definition |
|---|---|
| `pending` | Received + Assigned + Under review + Awaiting response |
| `overdue` | Pending cases past the **configured** disposal deadline |
| `noDeadlineConfigured` | Pending cases with no policy applied — never given an invented deadline |
| `transferred` | Accepted transfer decisions in the period (not a lifecycle state) |
| `escalated` | Cases with an open escalation flag, counted alongside their state |
| `disposalsInPeriod` | Canonical `status_disposed` events in the period (throughput) |
| `structuredDisposalsInPeriod` | Disposition rows in the period carrying outcome + reference |
| `currentlyDisposed` | Cases whose **current** state is Disposed — deliberately separate from throughput |
| `legacyDisposedWithoutOutcome` | Disposed/closed rows predating structured outcomes |

Verified reconciliation (section 8 of the suite): pending + disposed + closed = total; overdue ⊆
pending; `escalated` equals the database's open-flag count; `transferred` equals accepted decisions
in the period; throughput is strictly greater than the current disposed count once any case has been
reopened.

## 9. Background work follows the lifecycle

Disposing, reopening and accepting a transfer each enqueue and drain an institution recompute
(`recompute_overlap`, `recompute_suggestions`, `notify_overlap`). Verified from the `jobs` table:
dispose +1, reopen +1, transfer **acceptance** +1 while the pending request adds none; no job failed.

## 10. Migrations

`server/src/migrations.ts` (run from `db.ts` after `schema.sql`, and runnable alone):

| Version | Name | Effect |
|---|---|---|
| 1 | `m3_lifecycle_outcomes_and_import_source` | adds `cases.outcome`, `cases.decision_reference`, `cases.source_system`, `cases.source_identity`; creates `dispositions` + index, `migration_notes`, `schema_migrations`; backfills import provenance from `import_batches` |
| 2 | `m3_flag_legacy_dispositions` | flags every disposed/closed case without a structured record in `migration_notes` |

`schema.sql` mirrors the same shape for a fresh database (`cases_import_dedupe` replaced by the
unique index `cases_import_identity`). `npx tsx server/src/migrate.ts` applies and reports, and
`reportMigrationGaps()` exposes the unresolved rows.

Proof (`node test/migration-check.mjs data/caselink.db`, a **copy** of the pre-M3 demo database with
73 cases and 163 history events): migrated columns/tables/indexes identical to a freshly created
database; every case id, case number, status, version, receipt time and history event preserved;
`foreign_key_check` and `integrity_check` clean; second run applies nothing; 15 legacy disposals
flagged and reported instead of being given an invented outcome. **13/13 checks passed.**

## 11. Interface

* Case workspace: outcome selector + decision-reference field (both required for a disposal), the
  structured outcome and reference shown in the case summary, and a new **Disposition record** card
  listing every disposal with its actor, version and reopening marker.
* The status picker filters the protected reopen target out for disposed/closed cases, with the hint
  that reopening has its own action; the server rejects it regardless.
* `web/src/api.ts` types follow the new payloads (`outcome`, `decisionReference`, `outcomeRecorded`,
  `DispositionRecord`, `options.outcomes`).

## 12. Executed verification

```
bash test/run-m3.sh

=============== M3 lifecycle, outcomes and reporting ===============
executed: 79   passed: 79   failed: 0   skipped: 0
M3 lifecycle, outcomes and reporting: PASS

=============== Acceptance suite T01–T12 (same instance) ===============
21/21 checks passed.

=============== M2 relationship privacy regressions (same instance) ===============
40/40 executed checks passed
M2 relationship authorisation and privacy: PASS

=============== In-place migration of a copy of the existing database ===============
executed: 13   passed: 13   failed: 0   skipped: 0
Migration check: PASS

M3 verification: ALL SUITES PASSED
```

Earlier milestones on the same build (`bash test/run-m1.sh`): **65/65** M1 security checks, **58/58**
M1.1 regional checks, **8/8** demo-mode checks, **21/21** acceptance checks, sign-in suite (14
checks), direct-entry suite (13 checks) and the interface smoke run (20 screenshots, 0 console
errors) all passed.

Note on `T12`: the acceptance suite's rollback check needs the administrator-only fault-injection
hook, which is off by default and only enabled by `CASELINK_TEST_HOOKS=true` or demo mode. Both
verification scripts start their instance that way; on an instance started without the hook the
check reports `inject=403` and fails, which is the correct behaviour of the hook, not a lifecycle
defect.

## 13. Files changed in M3

```
server/src/domain.ts          one TRANSITIONS matrix, reopen rules, DISPOSITION_OUTCOMES, projections
server/src/service.ts         disposition validation + dispositions row, guarded write, canonical
                              events, reopen protection/notification, next-action semantics,
                              transfer recipient validation, escalation supervisor scope
server/src/index.ts           nextStatesFor, disposition history + outcome options on case detail,
                              strict action schema, outcome columns in reports/exports, report
                              definitions and structured/legacy counters
server/src/migrations.ts      numbered, transactional, idempotent migrations + gap report
server/src/migrate.ts         CLI: apply and report
server/src/schema.sql         mirrored columns/tables, unique import-identity index
server/src/db.ts              runs migrations after schema.sql (single source of truth at boot)
server/src/seed.ts            structured outcomes in seeded dispositions, force-reseed clears new tables
server/src/api types (web)    outcome/decisionReference/dispositions/outcomes
web/src/screens/CaseWorkspace.tsx  outcome fields, disposition card, reopen filtering
test/lifecycle-m3.mjs         79-check M3 suite
test/migration-check.mjs      13-check in-place migration proof
test/run-m3.sh                repeatable M3 verification
test/acceptance.mjs           T09 aligned with the PRD sequence and structured outcomes (stronger, not weaker)
```

## 14. Known remaining work (not M3)

* Concurrency/transaction work is M4: only the transfer acceptance and the new disposition write are
  guarded by affected-row counts today; `escalate`, `closeEscalation`, `resolveTriage`,
  `changeDeadline` and `assignCase` still need `assertVersion`, and the mutation + event + job writes
  are not yet wrapped in one transaction for every route.
* CSV import identity (M5), refresh/matching/performance (M6) and the full acceptance/browser pass
  with the test-reporting fix (M7) remain open.
