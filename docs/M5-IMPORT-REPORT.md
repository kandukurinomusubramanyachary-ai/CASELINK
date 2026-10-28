# M5 — CSV import identity, validation and safe re-import

CaseLink (SIH26264) · milestone report · verified 2026-10-28

M5 is **complete and executed**. Every claim below is backed by a check in `test/import-m5.mjs`
(41 checks) or by a suite re-run in `test/run-m5.sh`. All imported rows in every fixture are synthetic.

```
$ bash test/run-m5.sh
M5 CSV import identity, classification, binding and retries   executed: 41  passed: 41  failed: 0  skipped: 0
Acceptance suite T01–T12                                      21/21 checks passed
Migration check (v1–v5 on a copy of the existing database)    executed: 17  passed: 17  failed: 0
M5 verification: ALL SUITES PASSED
```

## 1. Import identity

A row's identity is `(source system, owning bureau, external reference)`, normalised as
`lower(trim(source system)) | bureau | lower(trim(external reference))` by `importIdentity()` in
`server/src/csv.ts`. It is stored on the case (`cases.source_identity`, unique index
`cases_import_identity`) and used identically by the preview and the commit, so the same reference
cannot be imported twice into the same bureau while staying independent across bureaus and regions
(checks 2h, 2l, 7d, 8a, 8b).

The previous build keyed de-duplication on `source_channel = 'CSV import'` plus the raw reference, which
was case-sensitive, ignored the source system and ignored the bureau; migration v1 added the provenance
columns and v4 backfills the normalised identity for existing imported rows without touching their
stored `source_system` / `source_reference` (migration check 16 and 17).

## 2. Classification

| Class | Meaning | Check |
|---|---|---|
| valid | new identity, all fields valid | 2b |
| unchanged duplicate | same identity, identical content | 2c, 3a, 3b |
| conflict | same identity, **different** content — never overwritten | 3c, 3d |
| rejected | field errors, reported with the row number | 2d, 2j |
| triage | institution name only, left unresolved | 2e |

Rejections are row-numbered and never affect the valid rows in the same file (2d, 2j). A reference
repeated inside one file is reported as a duplicate rather than silently dropped (2c, 2k).

## 3. Validation before reserving the key

The preview validates every row *before* anything is written (2g: no case rows exist after a preview),
and only a commit reserves the identity. Validation rules: required PRD template columns (1c), the ≤500
row limit (1d), known categories, real dates, an institution that exists and is inside the actor's
region (7a), an assigned officer in the actor's bureau (7b), and a resolvable institution identity
otherwise triage. Import itself is a lead-only capability (1b); a batch can only be committed by the
bureau that created it (7c).

## 4. Deadline policy is never invented

A row with no `policy_id` is created with **no deadline** and labelled `No deadline configured` in the
preview (2f, 2n). The previous build silently defaulted to the shortest active policy; that is gone.
When a policy is supplied it is stored on the case and shown as its due date.

## 5. Preview/commit binding

The preview stores a fingerprint of the normalised input (`import_batches.input_hash`) and the deadline
policies the officer saw (`policy_snapshot_json`). The commit re-computes the fingerprint and refuses a
batch whose stored input no longer matches with `409 batch_changed` (4a–4e). Between preview and commit
another officer may have imported the same identity: the commit re-checks duplicates against the live
database, creates nothing for that row and returns it under `newConflicts` so the officer is told rather
than silently skipped (5a–5c).

## 6. Idempotent retries with accurate counts

The commit stores its outcome (`result_json`). A retried commit returns the recorded counts with
`replayed: true` and creates no second case (6a–6c), which is also T10 in the acceptance suite.

## 7. Migrations

| Version | Name | Effect |
|---|---|---|
| v1 | `m3_lifecycle_outcomes_and_import_source` | adds `outcome`, `decision_reference`, `source_system`, `source_identity` |
| v2 | `m3_flag_legacy_dispositions` | flags pre-existing disposals instead of inventing outcomes |
| v3 | `m4_idempotency_request_fingerprint` | `idempotency_keys.request_hash` |
| v4 | `m5_import_batch_identity_and_snapshot` | `import_batches.input_hash`, `policy_snapshot_json`, `result_json`; backfills import identities |
| v5 | `m6_case_list_indexes` | indexes used by the SQL case list (M6) |

`node test/migration-check.mjs <db>` proves the migrations are additive: 17/17 checks, including that
every case id, status, version, receipt time and history event survives and that a second run changes
nothing.

## 8. Changed files for M5

```
server/src/csv.ts          importIdentity(), identity/policyId/deadlineLabel on ParsedImportRow
server/src/service.ts      createCase() accepts and stores sourceSystem / sourceIdentity
server/src/index.ts        validateImport() rewrite, preview fingerprint + policy snapshot, commit rewrite
server/src/migrations.ts   v4 (and v5 for M6)
server/src/schema.sql      import_batches.input_hash / policy_snapshot_json / result_json
web/src/screens/Import.tsx deadline column, no-deadline wording, new-conflict disclosure
test/import-m5.mjs         new — 41 checks
test/run-m5.sh             new — isolated seed, suite, acceptance, migration check
test/migration-check.mjs   checks 14–17 for the M5 migration and identity backfill
```

## 9. Remaining work for M5

Nothing outstanding. Behaviour that is deliberately *not* implemented: fuzzy matching of references,
merging of conflicting rows, and automatic institution resolution for triage rows — all three are
decisions reserved for a human reviewer.
