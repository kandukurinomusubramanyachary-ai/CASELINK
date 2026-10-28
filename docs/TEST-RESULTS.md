# Test results

Environment: Linux sandbox, Node 20.20.2, 2 vCPU, SQLite (better-sqlite3), single process. Dataset is
entirely synthetic (`server/src/seed.ts`). Results are prototype observations; they are not measurements
of a production deployment.

Commands: `npm run test:m1` (which starts an isolated sign-in-only instance and an isolated demo
instance from fresh seeds and runs everything below), `npm run test:login`, `npm run test:acceptance`,
`npm run test:ui`, `npm run bench`.

---

## 0. Milestone 1 — access-control regressions (63/63 pass on a sign-in-only instance)

`bash test/run-m1.sh` starts **two** isolated instances — `CASELINK_DEMO=false` on port 8091 and
`CASELINK_DEMO=true` on port 8092 — each from a freshly seeded database, then runs:

| Suite | Instance | Result |
| --- | --- | --- |
| `test/security-m1.mjs` | sign-in only (`CASELINK_DEMO=false`) | **66/66 pass** |
| `test/security-m1-1.mjs` | sign-in only (`CASELINK_DEMO=false`) | **59/59 pass** (0 skipped) |
| `test/demo-mode.mjs` | demo (`CASELINK_DEMO=true`) | **8/8 pass** |
| `test/acceptance.mjs` (T01–T12 + S01–S07) | sign-in only | **21/21 pass** |
| `test/login-check.mjs` | sign-in only | **14/14 pass** |
| `test/direct-entry.mjs` | demo | **13/13 pass** |
| `test/ui-smoke.mjs` (screens + screenshots) | sign-in only | 20 screens captured, **0 console errors** |

Full transcript: [`docs/m1-verification.log`](m1-verification.log). Before/after probe transcripts:
[`docs/m1-evidence-before.log`](m1-evidence-before.log) and
[`docs/m1-evidence-after.log`](m1-evidence-after.log).

### Required M1 regressions

| # | Regression | Expected | Observed |
| --- | --- | --- | --- |
| 1 | PGRC lead self-grants on a restricted RB case | 403; case still restricted | PASS — 403; `access=restricted`; no complaint text; no grant row; history remarks redacted |
| 2 | PGRC lead revokes another bureau's grant | 403; grant unchanged | PASS — 403; grant rows byte-identical before/after |
| 3 | Owning bureau lead grants; supervisor grants cross-bureau | success, audited | PASS — 200 + `access_granted` in business history; supervisor cross-bureau 200 and revocable |
| 4 | Out-of-region access management | 403 | PASS — West lead on a non-West case 403 |
| 5 | Granted reviewer uploads evidence | 403; no attachment, no upload event | PASS — 403; attachment count and history length unchanged |
| 6 | Granted reviewer mutates the case | 403 for every mutation | PASS — PATCH, action, assign, transfer, deadline, reopen, triage, escalate, grants, relationship confirm and revoke all 403; record version unchanged |
| 7 | Authorised case worker uploads | 201 | PASS — bureau lead 201 (attachment + `evidence_uploaded`), assigned officer 201 |
| 8 | No credentials, normal config | 401 | PASS — `/cases`, `/my-work`, `/notifications`, `/reports/summary`, `/users`, `/coordination`, forged token |
| 9 | Normal config demo entry | refused | PASS — `demo-login` 403; `demoMode=false`; 0 demo accounts; no demo password anywhere |
| 10 | Explicit demo config | fixture entry works | PASS — 8/8 on the demo instance, including "fixture accounts are still bound by the permission rules" (403) |
| 11 | Normal sign-in, reload, sign-out | works | PASS — sign-in, cookie-cleared Bearer fallback, reload, sign-out, protected route asks for sign-in again |

Additional checks in the same suite: a content grant given to a **foreign-bureau officer** allows reading
only (7e–7j); client-supplied `role`/`bureau`/`region` cannot widen grant authority (10a–10c); denials are
logged to the security log without complaint text and authorised changes keep their audit trail (11a–11e).

### Before/after evidence for the reported defects

Same probe script (`test/m1-probe.mjs`) against a build with the three pre-fix checks restored, then against
the fixed build (fresh seed, default configuration):

| Probe | Before | After |
| --- | --- | --- |
| PGRC lead self-grant on `RB-2026-00027`, then read it | HTTP **200**, contents readable, complaint text exposed | HTTP **403**, still restricted |
| Foreign lead evidence upload (after self-grant) | HTTP **201** | HTTP **403** |
| Granted read-only reviewer upload | HTTP **201** | HTTP **403** |
| Passwordless demo entry, default config | HTTP **200**, `demoMode=true`, 6 accounts published | HTTP **403**, `demoMode=false`, 0 accounts |
| Unauthenticated `GET /api/cases` | 401 | 401 (unchanged baseline) |

---

## 0b. M1.1 — regional authorisation regressions (59/59 pass, 0 skipped)

`bash test/run-m1.sh` also runs `test/security-m1-1.mjs` against the sign-in-only instance
(`CASELINK_DEMO=false`). Fixtures are created through the API in the seeded West institution
(`AICTE-DEMO-1010`) using the genuine West cohort (`s.bose` PGRC lead, `m.joshi` PGRC officer,
`r.pillai` RB lead, `k.menon` RB officer, `v.kumar` supervisor) and the South cohort, plus a national-scope
supervisor (`n.iyer`, `region` null). Every check asserts HTTP **and** persisted database state.

| Area | Check | Observed |
| --- | --- | --- |
| Alert acknowledgement | South supervisor → West alert | 403; alert `state`, `acknowledged_by`, `acknowledged_at` and case history unchanged |
| | West supervisor → West alert | 200; persisted `acknowledged_by = u-supervisor-west`, audited |
| | West bureau officer → West alert (in-scope) | 200 |
| | National supervisor (`region` null) → West alert | 200 (existing national-oversight policy preserved) |
| | South supervisor → South alert (in-region control) | 200 |
| | Personal notification acknowledgement | 200 (personal, not shared state) |
| | Reviewer / administrator → coordination alert | 403 both, state unchanged |
| Transfer decisions | South RB lead rejects a West transfer | 403; transfer pending, owner/bureau/version/history unchanged |
| | South RB lead accepts a West transfer | 403; transfer pending, ownership still PGRC, version unchanged, no `transfer_accepted` event |
| | Reviewer decides a transfer | 403, still pending |
| | West RB lead accepts / rejects West transfers | 200 both; persistence asserted (`accepted` + owner RB; `rejected` + owner PGRC) with the matching history events |
| | Same-region cross-bureau accept and reject (South) | 200 both (legitimate workflow preserved) |
| Grants | Exceptional read grant to the South RB lead | read 200 (`canViewContent=true`), transfer decision on the same case 403, ownership unchanged |
| | Exceptional read grant to the South supervisor | read 200, alert acknowledgement 403, alert state unchanged |
| | Exceptional read grant to the reviewer | read 200, acknowledgement 403, transfer decision 403 |
| | Grant revocation | read access returns to 403 |
| Forgery | `role`/`bureau`/`region` in body or query | cannot widen either permission (403) |

Before/after probe: [`docs/m11-evidence-before.log`](m11-evidence-before.log) /
[`docs/m11-evidence-after.log`](m11-evidence-after.log). The M1.1 suite reports skipped checks separately
and never counts them as passes (this run: **59 executed, 0 skipped**).

---

## 1. Acceptance suite — 21/21 pass

`test/acceptance.mjs` drives the running API over HTTP (never the interface), so every permission
check is exercised against the server. Machine-readable output: `test/acceptance-results.json`.

| ID | Scenario | Pass condition | Observed |
| --- | --- | --- | --- |
| T01 | Same institution with active cases in RB and PGRC | One coordination alert listing both permitted cases | PASS — one alert for `AICTE-DEMO-1001` containing both bureaus |
| T02 | Same institution, two unrelated topics (certificate vs infrastructure) | Institution alert appears; no institution-only duplicate claim | PASS — alert present, no duplicate candidate between the two, every candidate carries ≥2 evidence reasons |
| T03 | Same wording at different institution IDs | No automatic duplicate relationship | PASS — Kaveri case and Vaigai case share wording but no candidate exists |
| T04 | Ambiguous college name / unresolved ID | Triage required; no speculative canonical merge | PASS — unresolved case excluded from overlaps; name matches flagged `suggestionOnly` |
| T05a | Officer opens a restricted case | Access denied or fields redacted consistently | PASS — HTTP 200 with coordination metadata only; no `complaintSummary` key present |
| T05b | Region scope, same bureau | Denied | PASS — HTTP 403 for a West case read by a South officer |
| T05c | List responses | No restricted complaint text leaks | PASS |
| T06 | Reviewer links then revokes two cases | Both intact; reasons and actors recorded | PASS — link 200, revoke 200, owners and lifecycle unchanged, both events in history |
| T07 | Transfer pending, rejected and accepted | Exactly one owner remains; history reflects each event | PASS — pending keeps PGRC, reject keeps PGRC, accept moves to RB with the chosen officer, repeat accept 409, one `transfer_accepted` event |
| T08 | No policy / approaching / overdue | No invented deadline; correct configured reminders | PASS — a case with no policy reports `no_deadline`, configured cases report `overdue` and `approaching` |
| T09 | Dispose and reopen | Alerts respect state; earlier outcome and dates persist | PASS — disposed then reopened; receipt time unchanged; prior disposal event retained |
| T10 | Repeat import or retried mutation | No duplicate case, transfer or notification | PASS — same idempotency key returns the same case; first commit accepted 1 / rejected 1 / skipped 1; repeat commit accepted 0 |
| T11 | Two editors save the same version | One saves; stale edit reports a conflict | PASS — first 201, stale 409, version increments exactly once |
| T12 | Failure during mutation and audit commit | Atomic rollback; no partial ownership or action | PASS — invalid transition 422; injected audit failure 500 with version unchanged and no partial event |
| S01 | Unauthenticated read | 401 | PASS |
| S02 | Client claims another bureau in the body | Ignored; 403 | PASS |
| S03 | Read-only reviewer reads/writes an ungranted case | 403 for both | PASS |
| S04 | Attachment reached through another case ID | 404 | PASS |
| S05 | CSV export of a formula-like value | Escaped, snapshot header present | PASS — cell written as `'=SUM(1+1)` |
| S06 | Report totals vs drill-down lists | Equal | PASS — overdue 31/31, pending 87/87 |
| S07 | Matching service unavailable | Case still saves, rule-based overlap continues, mode shown | PASS |

---

## 1b. Sign-in checks — 11/11 pass

`test/login-check.mjs` (Playwright, Chromium) verifies the authentication path in the conditions that
matter for a hosted preview:

| Check | Result |
| --- | --- |
| Normal sign-in reaches My work | PASS |
| My work renders its queue tiles | PASS (6 tiles) |
| No console or page errors during sign-in | PASS |
| Session cookie cleared after sign-in (simulating a blocked cookie / preview frame) | PASS |
| Session stays alive on the Bearer token with zero cookies | PASS |
| Cases load with a token-only session | PASS (25 rows) |
| Hard reload with no cookies stays signed in | PASS |
| Sign out returns to the sign-in screen and clears the token | PASS |
| Protected route after sign-out asks for sign-in | PASS |
| Wrong password shows a readable error instead of failing silently | PASS |
| Demo-account shortcut fills the form and signs in | PASS |

## 1c. Direct-entry checks — 13/13 pass

`test/direct-entry.mjs` covers the demo entry path used for review:

| Check | Result |
| --- | --- |
| Opening the app lands directly in the workspace (no sign-in form) | PASS |
| Default page is My work | PASS |
| Signed in as the bureau lead by default | PASS |
| Account switcher present in the header | PASS |
| Switching account changes the session | PASS |
| `?as=p.rao` deep link enters as that account | PASS |
| Cases screen loads for the chosen account | PASS |
| Sign out shows the login page | PASS |
| After sign out, a protected route asks for sign-in | PASS |
| Login page offers a one-click direct-entry button | PASS |
| Direct-entry button opens the workspace | PASS |
| `#/login` shows the sign-in page even with an active session | PASS |
| No console or page errors during the flow | PASS |

## 2. Interface smoke run — pass, 0 console errors

`test/ui-smoke.mjs` (Playwright, Chromium; the app must already be running). It signs in as a bureau lead,
a supervisor, a bureau officer and a read-only reviewer, then:

* renders My work, Institutions, Institution profile, Cases, Case workspace, Coordination, Reports,
  Alerts, CSV import and Settings;
* saves a case action through the form (toast confirms the server timestamp; the timeline shows the new
  event with `version: 1 → 2`);
* opens a relationship review modal and checks the side-by-side comparison and rule evidence;
* loads the CSV sample, runs validation and shows the preview table with accepted/rejected/skipped counts;
* opens a restricted RB case as a PGRC officer (coordination metadata only);
* checks the read-only reviewer's empty scope state, the 430 px mobile layout and a 900 px narrow desktop.

Result: every step completed, **0 console and 0 page errors**. 19 screenshots are in `docs/screenshots/`.

Note: observed counts inside individual tests (for example "overdue 31") reflect the accumulated state of
the demo database at the moment of that run; acceptance and UI runs add cases by design. Reseed with
`npm run seed` before a demonstration.

---

## 3. Reference-scale benchmark — `npm run bench`

Isolated scratch database copied from the demo, then grown to the PRD reference scale; API on port 8099;
same machine; 20–40 sequential requests per measurement (no concurrency), mixed filters.

| Measure | n | p50 | p95 | PRD target | Status |
| --- | --- | --- | --- | --- | --- |
| Filtered case list (mixed filters) | 30 | 105 ms | **145 ms** | < 1500 ms | met |
| Individual case read | 40 | 22 ms | **34 ms** | < 1500 ms | met |
| Mutation confirmation (append action) | 20 | 579 ms | **643 ms** | < 2000 ms | met |
| Institution overlap visible after saving a new case | 1 | — | **1.75 s** | < 5000 ms | met |

Dataset: 10,000 cases across 100 synthetic institutions, 1 simulated officer session per run. The PRD
also proposes 20 concurrent simulated officer sessions and a shared dashboard refresh under 10 s; the
iteration above is sequential, and the dashboard refresh is exercised by the 10–15 s polling in the
interface rather than load-tested. **Concurrent 20-session load is therefore still unmeasured**, and the
mutation figure includes synchronous background job draining for that institution.

---

## 4. What is not evidenced

* **Matching evaluation** (PRD §10): the 60-complaint / 120-pair labelled fixture set, tuning vs held-out
  split and precision/recall figures were not produced. No accuracy claim is made for suggestions.
* **Concurrent multi-user load**, backup/restore, and evidence scanning.
* **Cross-browser and assistive-technology testing**: keyboard paths and focus styling are implemented,
  but only Chromium was exercised here.
* **Milestone 2+ behaviour** (relationship-content checks, evidence redaction, notification disclosure,
  lifecycle correctness, CSV import hardening, reporting) — see the remaining-work list in
  [`docs/M1-ACCESS-CONTROL-REPORT.md`](M1-ACCESS-CONTROL-REPORT.md).
