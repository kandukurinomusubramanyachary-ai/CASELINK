# PRD traceability — CaseLink v1.0 → prototype

Requirement-to-implementation map for the P0 scope, with the test that demonstrates it and the deviations
that a reviewer must know about. Test IDs refer to PRD section 10 (T01–T12) and to Supplementary checks
(S01–S07) added by this prototype.

## Scope and decisions

| PRD item | Status in prototype | Where |
| --- | --- | --- |
| Internal officer platform, no public intake | implemented | no public route; all screens require an authenticated session |
| P0 rules + reviewed identifiers + human relationship decisions | implemented | `server/src/rules.ts`, `server/src/service.ts#decideRelationship` |
| In-app alerts, synthetic records, demonstrable workflow | implemented | `server/src/worker.ts`, `server/src/seed.ts` |
| P1 (semantic ranking, graph, email, connectors) | **not built** — non-blocking, as specified | connector boundary is represented only by the CSV import adapter |
| Out-of-scope items (auto adjudication, auto merge, guilt scores, mobile apps) | not built, no hooks | — |

## Milestone 1 — access controls (implemented and verified)

The P0 prototype already separated coordination metadata from restricted content, but three authority
checks were too loose (grant/revoke, evidence upload, default sign-in). Milestone 1 replaced them with a
shared permission layer used by both routes and services.

| M1 requirement | Implementation | Evidence |
| --- | --- | --- |
| Shared backend rules for metadata / content / modify / upload / manage access / admin config | `server/src/domain.ts` — `canViewCoordinationMetadata`, `canReadCaseContent`, `canModifyCase`, `canUploadEvidence`, `canManageCaseAccess`, `canManageAdminConfig`, `hasCasePermission`, `describeAuthority`; called from `server/src/index.ts` (`requireCasePermission`, `requireAdminConfig`) and `server/src/service.ts` | `test/security-m1.mjs` 1–11 |
| Authority from the authenticated account only (role + bureau + region + grants) | session user rebuilt per request (`auth.ts#sessionUserById`); request bodies/queries never consulted for role, bureau or region | 10a–10c |
| Content-read grant must not confer write or access management | `canModifyCase`/`canUploadEvidence`/`canManageCaseAccess` never consult grants as authority | 5a–5d, 7e–7j |
| Mutation endpoint inventory completed with missing role/scope checks | all 20 mutating routes and their service operations reviewed; `assertCanUploadEvidence`, region-aware guards in `updateCase`, `assignCase`, `requestTransfer`, `escalateCase`, `closeEscalation`, `changeDeadline`, `reopenCase`, `resolveTriage`, relationship decision/revoke; admin-only `/system/*` and cross-bureau `/users` | 6, 10c, 11 |
| Grant/revocation authority (owning lead in region, supervisor in oversight scope, nobody else) | `canManageCaseAccess` enforced in `grantCaseAccess`/`revokeCaseAccess` **and** on the route | 1, 2, 3, 4 |
| Denial leaves records untouched and is logged separately | `recordSecurityDenial` (security log) + 403 before any write; business history only for authorised changes | 1b–1d, 2b, 11a–11e |
| Read-only enforcement at API level, not by hiding UI | reviewer reaches no mutation authority; personal notification acknowledgement remains allowed | 6 (11 mutation attempts) and 6y |
| Authenticated sign-in by default; demo only with `CASELINK_DEMO=true` | `DEMO_MODE` default `false` in `server/src/index.ts`, `start.sh`, `web/src/App.tsx`, `web/src/screens/Login.tsx`; `/api/auth/demo-login` returns 403 | 8, 9, 10 |
| Regression tests + build | `test/run-m1.sh` (two isolated instances), `test/security-m1.mjs`, `test/demo-mode.mjs`, `test/m1-probe.mjs`; `npx tsc --noEmit` and `npx vite build` clean | `docs/m1-verification.log` |

## Milestone 1.1 — regional authorisation (implemented and verified)

| M1.1 requirement | Implementation | Evidence |
| --- | --- | --- |
| No supervisor bypass for alert acknowledgement | `canAcknowledgeCoordination(user, { institutionRegion, caseIds })` — role limited to bureau officer/lead/supervisor, the alert's institution must be inside the caller's region, and one listed case must be inside the caller's coordination scope; the route loads the alert's institution region | `test/security-m1-1.mjs` 1a–1d, 2a–2h, 3a–3d |
| Reviewers and administrators never change shared acknowledgement state | role gate above; personal notification acknowledgement is a different route and stays available | 3a–3d, 2h |
| National oversight preserved | `inRegion` treats `region` null as national; seeded `n.iyer` proves it | 2e–2f |
| Transfer decisions need the target bureau's lead **with regional authority** | `canDecideTransfer(user, case, { toBureau })` used by `requireTransferDecision` (route) and `decideTransfer` (service) before either branch writes | 4a–4e, 5a–5f, 6a–6e |
| Denials leave records untouched | 403 before any write; `recordSecurityDenial` writes a separate security-log entry | 4c–4e, 7d–7e, 8b |
| Grants never widen these writes | neither function consults grants for authority | 7a–7m |
| `k.menon` mislabelled as `westLead` corrected | the M1 suite now proves the boundary with the West **lead** `s.bose`; the officer case is kept as a labelled secondary observation | `test/security-m1.mjs` 4a–4e |
| Region-complete fixtures | seed adds `s.bose`, `m.joshi`, `r.pillai`, `v.kumar`, `n.iyer` | `server/src/seed.ts` |

## Section 2 — Users and access

| Requirement | Implementation | Evidence |
| --- | --- | --- |
| Access = role + bureau + authorised region + explicit case grant | `server/src/domain.ts#getScope` (single visibility engine, cached per request) | T05a, T05b, S02, S03 |
| Backend enforces the same policy for screens, APIs, search, matching, downloads, exports (AC01) | scope applied before counting/paginating in `queryCases`, `coordination`, `relationships`, `reports`, attachment routes | S01, S04, S06 |
| Cross-bureau coordination view masks complainant identity, free text, attachments until a grant | `maskCase` vs `fullCase` in `domain.ts`; history remarks redacted (`HISTORY_REDACTED`) | T05a, T05c |
| Officer who cannot view both cases requests coordination; supervisor with access reviews | `decideRelationship` rejects a bureau lead unless both cases are in their bureau; UI states "Supervisor decision required" | T06 (supervisor path), UI screenshot `05-relationship-review` |
| Overlap explanations/notifications never reveal private excerpts | notification text contains institution name, bureaus and case numbers only | S05, code inspection of `notifyOverlap` |

## Section 3 — Screens and experience

| Requirement | Implementation |
| --- | --- |
| Navigation: My work, Institutions, Cases, Coordination, Alerts, Reports; Settings only for permitted users | `web/src/App.tsx`; Settings exposes live configuration, accounts and scope |
| My work shows next action, deadline, overdue reason, owner | `web/src/screens/MyWork.tsx` with priority reason tooltips |
| Case workspace keeps owner/status/next action above the timeline | `web/src/screens/CaseWorkspace.tsx` (four summary tiles above history) |
| Related cases open in a side-by-side review | `SuggestionModal` (two-column comparison + evidence list) |
| Successful save shows the new action and server timestamp | toast + re-fetch; timeline shows server time per event |
| Rejected save preserves text and explains the field/permission problem | controlled form state retained; `ErrorNote` lists field errors; 409 shows reconciliation notice |
| States: loading, empty, no results, access denied, validation error, failed save, unavailable matching, stale data | `web/src/ui.tsx` + per-screen handling; matching outage simulated in Settings; stale conflict banner in workspace |
| Failed notification must not remove a saved case action | notifications are separate rows keyed by dedupe key; case/action commit is independent | 
| Keyboard-accessible, visible focus, labelled inputs, status colours with text, explicit date formats | focus-visible outline, `<Field htmlFor>`, pills carry text, dates rendered as `DD Mon YYYY, HH:MM IST` |
| UTC storage, Asia/Kolkata display | `server` stores ISO UTC; `web/src/util.ts` formats in `Asia/Kolkata` |
| Preserve original complaint text, no silent translation | summary stored and rendered verbatim as text |
| AC02 open a case from institution/alert/report; filters and pagination survive the return | URL-synchronised filters (`#/cases?...`), drill-down links from reports and institution pages |

## Section 4 — Intake and records

| Requirement | Implementation | Evidence |
| --- | --- | --- |
| FR01 canonical permanent ID, separate internal UUID, reviewed aliases, fuzzy = suggestion only, unresolved ⇒ triage and excluded from overlap | `institutions` + `institution_aliases` tables, `/institutions/resolve`, `triage_state` | T04 |
| FR02 required-field/date/officer validation, server-generated identifiers, received ≠ import time, corrections record old/new values, no silent delete | `createCase` + `updateCase` (before/after objects in `action_events`) | T11, history in screenshots |
| FR03 template, preview, per-row errors, commit, 500-row cap, only valid rows imported, accepted/rejected/skipped reported, stable external reference required, repeat protection | `/import/preview`, `/import/:batchId/commit`, unique index on (`source_channel`, `bureau`, `source_reference`) | T10 |
| FR04 PDF/PNG/JPEG, 5 × 10 MB, server-side actual-type validation, private storage, authorised download, uploader/time/hash | `attachments` table, magic-byte check, SHA-256, uploads outside the web root | S04 |

## Section 5 — Lifecycle and ownership

| Requirement | Implementation | Evidence |
| --- | --- | --- |
| One owning bureau; assignment, transfer, escalation auditable | `cases.bureau`, `transfers` + `action_events` | T07 |
| State machine as specified (Received → Assigned → Under review → Awaiting response/Disposed → Closed, reopen) | `TRANSITIONS` in `domain.ts`, enforced in `updateCase`/`reopenCase` | T09, T12 (invalid transition) |
| FR05 safe transfer: original bureau responsible while pending, atomic acceptance, rejection keeps owner, repeated acceptance cannot transfer twice | `requestTransfer`/`decideTransfer` with `state = 'pending'` guard and single conditional UPDATE | T07 |
| FR06 every action records actor, bureau, server time, type, remarks, next step, before/after; escalation is a flag, not a state | `action_events`, `escalation_open` | history screenshots; T09 |
| FR07 reopening preserves previous outcome and receipt time; deadline changes are separate authorised actions; stale version ⇒ conflict | `reopenCase`, `changeDeadline`, `assertVersion` | T09, T11 |
| Acceptance: no orphaned case, invalid state rejected, failed audit write rolls back, second editor cannot overwrite | transactions via `tx()` covering mutation + event + job | T12, T11 |

## Section 6 — Overlap detection and relationships

| Requirement | Implementation | Evidence |
| --- | --- | --- |
| FR08 baseline: active cases at one canonical institution with ≥2 owning bureaus ⇒ one institution alert; historical cases do not trigger | `recomputeOverlap` with `dedupe_key = overlap:<institution>`; alert closed when the condition ends | T01, T09 |
| Different issues at the same college still warrant a coordination signal; never labelled duplicates on that basis | institution alert and relationship suggestions are separate objects | T02 |
| FR09 candidate evidence: shared external reference, reviewed alias, incident period, matching topics; each factual reason shown with its source field; different institution IDs block a duplicate suggestion | `evaluatePair` with signal counting; `sourceField` in every reason; explicit institution guard | T02, T03 |
| P0 engine explicit rules; P1 semantic ranking optional; if semantic matching fails keep baseline and show mode | `workerState.matchingMode` + `/system/matching-mode` | S07 |
| FR10 reviewer chooses Related issue / Duplicate report / Separate issues with reason; duplicate is a classification, not a merge; reviewer, evidence snapshot, rule version, decision time stored; revocation with reason; dismissed suggestions suppressed until evidence changes | `decideRelationship`, `revokeRelationship`, `suggestions.evidence_hash` + `state = outdated` | T06 |
| Required counterexample: certificate vs infrastructure at College A ⇒ coordination but no duplicate claim; identical wording at two colleges ⇒ separate | seeded fixtures at `AICTE-DEMO-1001` and `AICTE-DEMO-1002` | T02, T03 |
| Acceptance: no automatic merge, no restricted-excerpt disclosure, overlap unresolved until decision or condition ends | no merge code path; masked suggestions for restricted files | T02, T05, T06 |

## Section 7 — Deadlines, alerts, reports

| Requirement | Implementation | Evidence |
| --- | --- | --- |
| FR11 versioned policy, explicit due dates, never invent an SLA, "No deadline configured" tracked by age, Awaiting response never pauses | `deadline_policies`, `expected_disposal_at` nullable, `deadlineState` returns `no_deadline` | T08 |
| FR12 persisted notifications for the five event types, per-minute check, dedupe by rule/entity/due/threshold, acknowledgement ≠ resolution, disposed cases stop reminders | `scanDeadlines` + `notify` with dedupe keys | Alerts screen, `/api/notifications` |
| Priority uses transparent factors only | `priorityOf` returns score + human-readable reasons | My work "Critical (40)" tooltips |
| FR13 definitions: current total, pending, overdue, transferred, escalated, disposal throughput; search and filters; age vs completed duration; export only permitted rows/fields with snapshot and filters; escape formula-like values | `/reports/summary`, `/reports/export`, `csvCell` | S05, S06 |

## Section 8 — Data and implementation outline

| Requirement | Implementation |
| --- | --- |
| React + TypeScript, Node TypeScript API, relational database | implemented (SQLite substituted for PostgreSQL — see deviations) |
| Entity set (institution/alias, user/membership, case/grant, action event, transfer/relationship, suggestion/alert, attachment/import batch, policy/notification) | `server/src/schema.sql` |
| API boundaries listed for P0 | see `docs/API.md` |
| Idempotency keys for creation and transfer decisions | `idempotency_keys` table + `Idempotency-Key` header | 
| Validation / access / conflict status codes | error contract in `docs/API.md` |
| Permission-filter results before counting or paginating | `queryCases` | 
| Commit case change + action event + pending background work in one transaction; workers retry idempotently | `tx()` in `db.ts`, `jobs` table, `runJobs` |
| UI refreshes affected records after writes and polls within ten seconds | workspace re-fetch after every write; My work 15 s and notifications 10 s polling |
| Reports agree with drill-down lists | S06 |

## Section 9 — Security, reliability, limits

| Requirement | Implementation | Evidence |
| --- | --- | --- |
| Authenticated accounts, backend role/scope checks, no public role selector | sessions + `getScope` | S01, S02, S03 |
| Complaint text/contacts/attachments private, limited metadata for coordination, redaction in notifications and logs | masking engine, notification bodies contain no excerpts, `security_log` stores ids/actions only | T05, S05 |
| Input validation, parameterised SQL, text rendering, upload limits, secrets outside source | Zod schemas, prepared statements, React text rendering, multer limits | S02, S04 |
| Reason required for relationship decisions, transfers, deadline changes, reopening | enforced in service layer | T06, T07 |
| Failure behaviours (matching down, notification failure, transaction failure, expired session, stale version) | implemented and demonstrable | T11, T12, S07 |
| Performance targets at 10,000 cases / 100 institutions / 20 sessions | measured | `docs/TEST-RESULTS.md` |
| Deployment gates before real data | documented, not satisfied — real data must not be used | README §6 |

## Section 10 — Acceptance tests

All twelve PRD scenarios (T01–T12) are automated in `test/acceptance.mjs` and currently pass, together
with seven supplementary checks. See [`TEST-RESULTS.md`](TEST-RESULTS.md).

**Not done:** the matching-evaluation fixture set (60 complaints, 120 labelled pairs, tuning/held-out
split, precision/recall). The rule baseline that such an evaluation would compare against exists, but no
metric is claimed.

---

## Deviations

1. **SQLite instead of PostgreSQL.** The sandbox has no PostgreSQL server. Schema and queries are written
   for portability (text UUIDs, ISO-8601 UTC text timestamps, partial unique index, no engine-specific
   types); the driver is isolated in `server/src/db.ts`.
2. **Sessions instead of OIDC/SSO.** HttpOnly cookie sessions with scrypt-hashed passwords. A real
   deployment must use the sponsor's identity provider; nothing in the authorisation model depends on the
   session mechanism.
3. **Notification delivery is in-app only.** Email delivery (P1) is not implemented; the dedupe and retry
   structures that would carry it are in place.
4. **Attachments are stored on disk with hash + type checks.** Antivirus scanning and retention policy are
   deployment gates, as the PRD requires.
5. **No openpyxl/PDF report output.** Reports are HTML plus CSV; the PRD asks for filtered reports and
   exportable results, which are met by CSV.
6. **Seed volume.** The demo database seeds 73 records (15 narrative fixtures + 54 generated + 4 imported)
   to keep the demo readable; the 10,000-case reference scale is exercised by `npm run bench` instead.
7. **`Duplicate report` classifier threshold** is a documented rule (`same category` and wording
   similarity ≥ 0.34, or a shared external reference), not a learned model. It is a candidate ranking
   input for a human decision and carries no accuracy claim.

## Open decisions carried forward (from PRD section 12)

| Question | Provisional implementation in this prototype |
| --- | --- |
| Institution master and aliases | synthetic directory, reviewed aliases, no real import |
| Case visibility for restricted matters | scoped metadata + explicit grants |
| Official deadlines and escalation rules | clearly labelled DEMO policies; "No deadline configured" otherwise |
| Disposition and transfer authority | bureau lead disposes/transfers; supervisor decides cross-bureau relationships |
| Existing case systems | CSV import adapter only |
| Evidence and retention | private synthetic fixtures; scanning/retention are deployment gates |
