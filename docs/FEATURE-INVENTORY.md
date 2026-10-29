# CaseLink — existing feature inventory

Baseline: `56113283e66fb656635adb34b2eed32e7e7369b6` and the Milestone 0 documentation branch.  
Status meanings:

- **Verified (synthetic P0):** the listed current-scope flow was exercised by API and/or Playwright tests.
- **Partial:** the implemented slice is verified, but an explicitly limited or production-facing part remains.
- **Not verified:** no adequate execution evidence was found; no working claim is made.

All results are for synthetic fixtures. See `docs/BASELINE.md` for commands, counts and release limits.

## 1. Authentication, sessions and login restrictions

- **Purpose:** officer sign-in/out, eight-hour server-side sessions, expired-session handling and protection against cross-site writes/password guessing.
- **Frontend files:** `web/src/screens/Login.tsx`, `web/src/App.tsx`, `web/src/api.ts`.
- **Backend/API files:** `server/src/auth.ts`, `server/src/request-security.ts`, `server/src/index.ts`; `/api/auth/login`, `/api/auth/logout`, `/api/session`, `/api/auth/demo-login` (demo only).
- **Database tables:** `users`, `sessions`, `security_log`.
- **Existing automated tests:** `test/login-check.mjs` (14), `security-m1.mjs`, `reliability.mjs` request-security group, `ux-m7.mjs` expired-session group.
- **Verified functional status:** **Verified (synthetic P0)** — login/logout, reload, blocked-cookie Bearer fallback, wrong/expired credentials, unauthorized API calls, same-host writes, credential bounds, malformed cookies and failed-login limits.
- **Known defects/limitations:** no sponsor SSO/OIDC; per-process limiter is not shared across replicas; Secure cookies require HTTPS outside local testing.
- **Recommended future improvements:** sponsor identity integration and shared rate limiting/session controls designed for the approved deployment topology.

## 2. Role, bureau, region and explicit case-grant authorization

- **Purpose:** separate coordination metadata from private complaint content and prevent grants from widening write authority.
- **Frontend files:** `web/src/App.tsx`, `web/src/screens/CaseWorkspace.tsx`, `web/src/screens/Settings.tsx`, `web/src/components/CaseTable.tsx`.
- **Backend/API files:** `server/src/domain.ts`, `server/src/privacy.ts`, `server/src/service.ts`, `server/src/index.ts`; `/api/cases/:id/grants`, `/api/users`.
- **Database tables:** `users`, `bureaus`, `institutions`, `cases`, `case_grants`, `security_log`, `action_events`.
- **Existing automated tests:** `security-m1.mjs` (65), `security-m1-1.mjs` (59), `security-m2.mjs` (40), `search-access.mjs` (13), A01/A02/A06 checks in `audit-m7.mjs`.
- **Verified functional status:** **Verified (synthetic P0)** — scoped lists/details/search/exports, grant/revoke, regional denial, reviewer read-only behavior and denial logging.
- **Known defects/limitations:** no sponsor account provisioning or organizational-directory synchronization; administrator content still requires a grant.
- **Recommended future improvements:** approved account/role lifecycle and organizational mapping without weakening the shared permission engine.

## 3. My Work queues and deadlines

- **Purpose:** assigned, unassigned, overdue, approaching, escalated and triage queues with transparent priority/deadline reasons.
- **Frontend files:** `web/src/screens/MyWork.tsx`, `web/src/components/CaseTable.tsx`, `web/src/refresh.ts`.
- **Backend/API files:** `server/src/index.ts` (`/api/my-work`), `server/src/rules.ts`, `server/src/worker.ts`, `server/src/domain.ts`.
- **Database tables:** `cases`, `institutions`, `users`, `transfers`, `deadline_policies`, `jobs`.
- **Existing automated tests:** `acceptance-ui.mjs`, `refresh-m6.mjs` (19), `lifecycle-m3.mjs`, `ui-smoke.mjs`.
- **Verified functional status:** **Verified (synthetic P0)** — queue rendering, scoped counts, assignment/deadline updates, polling/local refresh and mobile My Work.
- **Known defects/limitations:** no independently rerun benchmark for large concentrated queues in this milestone; DEMO deadline policies are not official service levels.
- **Recommended future improvements:** queue performance and prioritization review using approved larger synthetic workloads.

## 4. Institution directory, canonical IDs, aliases and triage identity

- **Purpose:** canonical synthetic permanent IDs, reviewed aliases, suggestion-only name resolution and unresolved-intake triage.
- **Frontend files:** `web/src/screens/Institutions.tsx`, triage portions of `web/src/screens/CaseWorkspace.tsx` and `web/src/screens/Cases.tsx`.
- **Backend/API files:** `server/src/index.ts` institution routes, `server/src/rules.ts`, `server/src/service.ts`; `/api/institutions`, `/api/institutions/resolve`, `/api/institutions/:id`, `/api/institutions/:id/aliases`, `/api/cases/:id/triage`.
- **Database tables:** `institutions`, `institution_aliases`, `cases`, `alerts`, `suggestions`, `relationships`, `action_events`.
- **Existing automated tests:** acceptance T04, `audit-m7.mjs` A13, `concurrency-m4.mjs` stale triage, institution smoke screens; supplementary Milestone 0 alias API check.
- **Verified functional status:** **Verified (synthetic P0)** — search/profile/canonical IDs, alias creation and reviewer metadata, alias-informed suggestion-only resolution, invalid/officer/cross-region alias denial, triage exclusion and resolution.
- **Known defects/limitations:** synthetic institution master only; no external AICTE directory connector; alias insertion and its security-audit record are not one business transaction.
- **Recommended future improvements:** transactional alias audit and an approved institution-master adapter with reconciliation tests.

## 5. Case list, filters, pagination and global search

- **Purpose:** permission-filtered case discovery with URL-preserved filters, pagination and content-safe history search.
- **Frontend files:** `web/src/screens/Cases.tsx`, `web/src/components/CaseTable.tsx`, `web/src/components/SearchDialog.tsx`, `web/src/App.tsx`.
- **Backend/API files:** `server/src/index.ts` (`/api/cases`, `/api/search`), `server/src/domain.ts`, `server/src/privacy.ts`.
- **Database tables:** `cases`, `institutions`, `users`, `action_events`, `case_grants`.
- **Existing automated tests:** `search-access.mjs` (13), acceptance and acceptance-UI suites, `refresh-m6.mjs`, `security-m2.mjs`, legacy unpaired-history reliability test.
- **Verified functional status:** **Verified (synthetic P0)** — scoped results, filters/pagination, drill-down navigation, restricted-history exclusion and account-switch refresh.
- **Known defects/limitations:** no new large-scale search benchmark; lexical search only.
- **Recommended future improvements:** search relevance/performance work after matching and workflow correctness sprints.

## 6. Case creation, validation and idempotent intake

- **Purpose:** register manual complaints with validated source/category/date/owner fields, server identifiers and safe retries.
- **Frontend files:** `web/src/screens/Cases.tsx`, `web/src/screens/CaseWorkspace.tsx`, `web/src/api.ts`.
- **Backend/API files:** `server/src/index.ts` (`POST /api/cases`, idempotency middleware), `server/src/service.ts#createCase`, `server/src/csv.ts`.
- **Database tables:** `cases`, `sequences`, `institutions`, `users`, `idempotency_keys`, `action_events`, `jobs`.
- **Existing automated tests:** acceptance T10/T11, `audit-m7.mjs` A04/A06, `concurrency-m4.mjs`, reliability replay/bootstrap groups.
- **Verified functional status:** **Verified (synthetic P0)** — valid persistence, invalid input, regional owner refusal, duplicate prevention, request fingerprint conflict and replay re-authorization.
- **Known defects/limitations:** no public intake or external source connector, by scope; idempotency storage is local to one database.
- **Recommended future improvements:** intake field usability and retry observability after higher-priority matching work.

## 7. Case lifecycle, actions, assignment, escalation and reopening

- **Purpose:** manage Received → Assigned → Under review/Awaiting response → Disposed → Closed with protected reopening, notes, deadlines and append-only history.
- **Frontend files:** `web/src/screens/CaseWorkspace.tsx`, `web/src/components/CasePrintView.tsx`.
- **Backend/API files:** `server/src/service.ts`, `server/src/domain.ts`, `server/src/index.ts` case mutation routes.
- **Database tables:** `cases`, `action_events`, `dispositions`, `users`, `deadline_policies`, `jobs`, `notifications`.
- **Existing automated tests:** `lifecycle-m3.mjs` (79), `concurrency-m4.mjs` (38), acceptance T09/T11/T12, `audit-m7.mjs` A03/A04, `acceptance-ui.mjs`.
- **Verified functional status:** **Verified (synthetic P0)** — legal/illegal transitions, assignment/unassignment, outcomes, close/reopen, stale versions, deadline change, escalation and rollback.
- **Known defects/limitations:** disposition/deadline rules remain prototype policy; no real official SLA configuration has been approved. Print styling exists but lacks a separate print-output visual regression suite.
- **Recommended future improvements:** workflow edge-case review and approved policy configuration, without changing the state machine silently.

## 8. Bureau transfers

- **Purpose:** request, accept or reject cross-bureau ownership transfers while preserving regional authority and an auditable owner.
- **Frontend files:** `web/src/screens/CaseWorkspace.tsx`, `web/src/screens/MyWork.tsx`.
- **Backend/API files:** `server/src/service.ts#requestTransfer` / `decideTransfer`, `server/src/privacy.ts`, `server/src/index.ts`; `/api/cases/:id/transfer`, `/api/transfers/:id/decision`.
- **Database tables:** `transfers`, `cases`, `action_events`, `notifications`, `idempotency_keys`, `jobs`.
- **Existing automated tests:** acceptance T07/T10, `security-m1-1.mjs`, `lifecycle-m3.mjs`, `concurrency-m4.mjs`, `audit-m7.mjs` A01.
- **Verified functional status:** **Verified (synthetic P0)** — request/accept/reject, pending/repeated-decision guards, regional permissions, atomic ownership/history and reason privacy.
- **Known defects/limitations:** no multi-instance transfer worker or external bureau-system reconciliation.
- **Recommended future improvements:** transfer queue usability and integration reconciliation only after baseline approval.

## 9. Evidence upload, download, deletion and recovery

- **Purpose:** attach private PDF/PNG/JPEG evidence with type/size/count checks, hashes, versioned writes and failure recovery.
- **Frontend files:** evidence sections of `web/src/screens/CaseWorkspace.tsx`, `web/src/api.ts`.
- **Backend/API files:** `server/src/index.ts` attachment routes and `reconcileUploads`, `server/src/service.ts#assertCanUploadEvidence`, `server/src/db.ts` storage configuration.
- **Database tables:** `attachments`, `cases`, `action_events`, `migration_notes`, `security_log`.
- **Existing automated tests:** `audit-m7.mjs` A05/A07, `concurrency-m4.mjs` upload/stale-delete/shared-file groups, acceptance S04, `security-m1.mjs`.
- **Verified functional status:** **Verified (synthetic P0)** — upload, authorized download, denied access, version requirements, deletion, failed publication compensation and interrupted-row reconciliation.
- **Known defects/limitations:** no malware scanning, retention policy or multi-writer evidence protocol; abrupt power/filesystem failure matrix is not exhaustive.
- **Recommended future improvements:** dedicated evidence hardening sprint covering startup crash tests, scanning pipeline and retention before real data.

## 10. Institution overlap and coordination alerts

- **Purpose:** identify active cases at one canonical institution owned by at least two bureaus and route a persistent coordination signal.
- **Frontend files:** `web/src/screens/Coordination.tsx`, `web/src/screens/Institutions.tsx`, `web/src/screens/Alerts.tsx`.
- **Backend/API files:** `server/src/rules.ts#recomputeOverlap`, `server/src/worker.ts`, `server/src/index.ts`; `/api/coordination`, `/api/alerts/:id/acknowledge`.
- **Database tables:** `alerts`, `cases`, `institutions`, `jobs`, `notifications`.
- **Existing automated tests:** acceptance T01/T02/T09, matching exact-ID overlap evaluation, `security-m1-1.mjs`, reliability paused-backlog group.
- **Verified functional status:** **Verified (synthetic P0)** — one alert per institution, close/recompute behavior, cross-bureau signals without automatic duplicate claims and regional acknowledgement.
- **Known defects/limitations:** jobs run in the API process; previously mishandled historical jobs are not retroactively inferred.
- **Recommended future improvements:** durable worker deployment and queue coalescing after correctness feature sprints.

## 11. Related-case suggestions and human relationship decisions

- **Purpose:** show evidence-based related/duplicate candidates and require an authorized human to confirm, dismiss or revoke relationships without merging cases.
- **Frontend files:** `web/src/screens/Coordination.tsx`, relationship portions of `web/src/screens/CaseWorkspace.tsx`.
- **Backend/API files:** `server/src/rules.ts#evaluatePair` / `recomputeSuggestions`, `server/src/service.ts#decideRelationship` / `revokeRelationship`, `server/src/privacy.ts`.
- **Database tables:** `suggestions`, `relationships`, `cases`, `action_events`, `jobs`.
- **Existing automated tests:** `security-m2.mjs` (40), acceptance T02/T03/T06, `audit-m7.mjs` A02/A07, reliability relationship-version/outage groups, `matching-eval.ts`.
- **Verified functional status:** **Partial — verified current rules, accuracy needs improvement** — permissions, human decisions, revocation, privacy, stale versions and controls pass; one related pair is missed on the synthetic labelled set.
- **Known defects/limitations:** lexical recall limitations; no semantic ranking or relationship graph by scope; metrics are not real-world accuracy claims.
- **Recommended future improvements:** **next feature sprint** — related-case recall and evidence quality using labelled tune/held-out synthetic data while preserving cross-institution negatives and human review.

## 12. Notifications and personal acknowledgement

- **Purpose:** persist overlap, assignment, transfer, deadline, overdue and escalation notices for authorized recipients without leaking private details.
- **Frontend files:** `web/src/screens/Alerts.tsx`, notification controls in `web/src/App.tsx`, `web/src/refresh.ts`.
- **Backend/API files:** `server/src/worker.ts`, `server/src/privacy.ts#projectNotification`, `server/src/index.ts` notification routes.
- **Database tables:** `notifications`, `cases`, `alerts`, `transfers`, `users`, `case_grants`.
- **Existing automated tests:** `audit-m7.mjs` A01/A11/A12, `security-m1.mjs` persisted reviewer acknowledgement, regional acknowledgement checks, `refresh-m6.mjs`.
- **Verified functional status:** **Partial — verified in-app delivery** — recipient scope, redaction, read/acknowledge persistence and refresh pass; external delivery is not implemented.
- **Known defects/limitations:** no email/SMS/external delivery; notification retry is database-backed but not a distributed delivery system.
- **Recommended future improvements:** delivery preferences and approved external adapters only after core workflow/evidence work.

## 13. Reports, drill-downs and CSV export

- **Purpose:** scoped counts, ageing, workload and throughput with consistent definitions and exportable permitted rows.
- **Frontend files:** `web/src/screens/Reports.tsx`, report links in `web/src/screens/Cases.tsx`.
- **Backend/API files:** `server/src/index.ts` report functions/routes, `server/src/csv.ts`, `server/src/domain.ts`; `/api/reports/summary`, `/api/reports/export`.
- **Database tables:** `cases`, `action_events`, `dispositions`, `transfers`, `institutions`, `users`, `migration_notes`.
- **Existing automated tests:** `lifecycle-m3.mjs`, acceptance S05/S06, `security-m2.mjs` export scope, Reports smoke screen.
- **Verified functional status:** **Partial — verified HTML/CSV scope** — counts/drill-down reconciliation, date handling, scope and CSV formula escaping pass.
- **Known defects/limitations:** no PDF/XLSX output; no new 10,000-case report benchmark in this milestone; legacy unresolved outcomes remain separately reported rather than invented.
- **Recommended future improvements:** reporting performance/definitions review and additional export formats only if approved.

## 14. CSV import preview, commit and retry handling

- **Purpose:** validate up to 500 rows, classify valid/triage/rejected/duplicate/conflict rows, preview then commit safely and preserve source identity.
- **Frontend files:** `web/src/screens/Import.tsx`, `web/src/api.ts`.
- **Backend/API files:** `server/src/csv.ts`, `server/src/index.ts` import routes, `server/src/service.ts#createCase`; `/api/import/template`, `/api/import/preview`, `/api/import/:batchId/commit`.
- **Database tables:** `import_batches`, `cases`, `idempotency_keys`, `action_events`, `jobs`, `migration_notes`.
- **Existing automated tests:** `import-m5.mjs` (41), acceptance T10, `audit-m7.mjs` A08–A10, reliability cross-system/collision groups, full migration check.
- **Verified functional status:** **Verified (synthetic P0)** — template, per-row validation, triage/no-policy rows, policy snapshot binding, changed-record conflicts, commit/retry dedupe, canonical cross-system identity and unique-index enforcement.
- **Known defects/limitations:** CSV only; ambiguous legacy identities require manual reconciliation; no live source-system connector.
- **Recommended future improvements:** import mapping/reconciliation UX and approved adapter work after core accuracy/workflow improvements.

## 15. Settings, runtime status and administrative test controls

- **Purpose:** show runtime/deadline/account scope, worker health and matching mode; provide administrator-only synthetic fault controls.
- **Frontend files:** `web/src/screens/Settings.tsx`, `web/src/screens/Login.tsx`.
- **Backend/API files:** `server/src/index.ts` `/api/system/*` and `/api/users`, `server/src/worker.ts`, `server/src/bootstrap-admin.ts`.
- **Database tables:** `settings`, `jobs`, `deadline_policies`, `users`, `sessions`, `migration_notes`.
- **Existing automated tests:** reliability status/outage/restart/bootstrap groups, `security-m1.mjs` administrator denial, Settings smoke screen, demo-mode tests.
- **Verified functional status:** **Partial — verified current administration slice** — authenticated/redacted status, admin-only controls, queue health and bootstrap checks pass.
- **Known defects/limitations:** no full web account provisioning/deactivation workflow, no shared multi-instance configuration, and production serving requires the TypeScript loader dependency.
- **Recommended future improvements:** approved operational administration and deployment configuration after feature correctness work.

## 16. Background jobs, transaction consistency and schema migrations

- **Purpose:** preserve atomic case/event/job changes, retry failed work, survive matching outages and upgrade existing records additively.
- **Frontend files:** status surfaces in `web/src/screens/Settings.tsx` and stale-data handling in `web/src/screens/CaseWorkspace.tsx`.
- **Backend/API files:** `server/src/db.ts`, `server/src/service.ts`, `server/src/worker.ts`, `server/src/migrations.ts`, `server/src/migrate.ts`, `server/src/schema.sql`.
- **Database tables:** all core tables; especially `jobs`, `schema_migrations`, `migration_notes`, `idempotency_keys`, `action_events`, `attachments`.
- **Existing automated tests:** `concurrency-m4.mjs` (38), reliability worker/migration groups, `migration-check.mjs` (17), `lifecycle-m3.mjs`, backup/restore supplementary check.
- **Verified functional status:** **Verified (synthetic single-host P0)** — fresh initialization, v1–v8 upgrade, idempotent second run, record/version/history preservation, foreign keys, rollback, retry/failure observability and restart.
- **Known defects/limitations:** no automatic down-migration, distributed job claiming or operational production migration; multi-active-replica use is unsupported.
- **Recommended future improvements:** deployment-specific persistence, worker claiming and rollback drills before real data.

## 17. Shared interface shell, refresh, accessibility and demo navigation

- **Purpose:** responsive navigation, global search/help, loading/error states, theme, keyboard/mobile behavior and direct demo account switching.
- **Frontend files:** `web/src/App.tsx`, `web/src/ui.tsx`, `web/src/styles.css`, `web/src/theme.tsx`, `web/src/refresh.ts`, `web/src/components/*`.
- **Backend/API files:** `/api/session`, `/api/search`, `/api/meta`, demo-login route; frontend asset serving in `server/src/index.ts`.
- **Database tables:** indirectly `users`, `sessions`, `cases`, `institutions`, `action_events`, `notifications`.
- **Existing automated tests:** `ui-smoke.mjs` (19 captures), `acceptance-ui.mjs` (13), `refresh-m6.mjs` (19), `ux-m7.mjs` (15), `direct-entry.mjs` (13).
- **Verified functional status:** **Verified (synthetic P0 runtime)** — desktop/mobile/narrow layouts, action save, restricted states, keyboard/mobile flows, refresh and account switching; zero smoke console errors.
- **Known defects/limitations:** this was not a full visual-design, screen-reader or cross-browser certification; optional design-polish sweeps were not added to the required gate.
- **Recommended future improvements:** UX simplification and accessibility audit after correctness, evidence and reporting sprints.

## 18. Demo seeding, first administrator and release verification

- **Purpose:** make synthetic demonstration explicit, keep normal startup empty, provision a unique first administrator and provide one reproducible release gate.
- **Frontend files:** demo account controls in `web/src/App.tsx` and password hints in `web/src/screens/Login.tsx`.
- **Backend/API files:** `server/src/seed.ts`, `server/src/bootstrap-admin.ts`, `start.sh`, `test/verify.mjs`, `test/required-checks.mjs`, `.github/workflows/verify.yml`.
- **Database tables:** all fixture tables; normal empty startup leaves `users` and `cases` empty.
- **Existing automated tests:** reliability bootstrap/setup/skip-detection groups, `demo-mode.mjs` (8), `direct-entry.mjs` (13), complete 36-command gate.
- **Verified functional status:** **Partial pending release publication** — behavior and tests pass locally; the new branch has no GitHub Actions run because credentials are unavailable.
- **Known defects/limitations:** the previous gate could disguise a skipped required check as PASS and did not exercise a full old-schema upgrade; both are repaired in `56113283…`. Existing seeded credentials are not rotated by disabling demo mode.
- **Recommended future improvements:** publish a stacked PR, run CI, obtain human review, merge with approval and rerun against the resulting `main` SHA.
