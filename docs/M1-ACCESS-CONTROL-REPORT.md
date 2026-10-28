# Milestone 1 — Access controls: completion report

Project: **CaseLink (SIH26264)** — React + TypeScript interface, Node TypeScript API, SQLite in place of
PostgreSQL (documented deviation). Date: 27–28 October 2026. All fixtures synthetic.

> **Follow-up:** two regional-authorisation defects found after this report are fixed in
> [M1.1](M1.1-REGIONAL-AUTH-REPORT.md) (alert acknowledgement and transfer decisions across regions).
> M1 itself is unchanged by that work; its regressions were re-run and still pass (66/66, updated suite).

**Verdict: M1 complete.** The three reported defects are fixed and proved fixed over HTTP on a
sign-in-only instance; the 11 required regressions pass; legitimate officer, lead and supervisor workflows
(including supervisor cross-bureau coordination) still work; typecheck and production build are clean.
Later-milestone issues are listed in §7 as **not fixed**.

---

## 1. Reported defects — cause and fix

| # | Defect | Root cause found in the code | Fix |
| --- | --- | --- | --- |
| 1 | A PGRC lead could see restricted RB coordination metadata, POST the case's grants endpoint and read the contents | `grantCaseAccess` / `revokeCaseAccess` checked only `role in ('bureau_lead','supervisor')`; the grants route checked metadata visibility only. Bureau ownership and region were never consulted, so seeing metadata was enough to self-grant | `canManageCaseAccess(user, c)` (role **+** owning bureau **+** region, or supervisor oversight scope) enforced in the service **and** on the route via `requireCasePermission(req, c, 'manage_access')`. Denial logged, no write |
| 2 | A read-only reviewer holding a legitimate content grant could upload evidence and receive HTTP 201 | The attachments route only called `requireContent(...)`; the reviewer's grant satisfied it and the insert proceeded | New `canUploadEvidence(user, c)` (case-worker authority only) + `assertCanUploadEvidence` in the service **and** `requireCasePermission(req, c, 'upload_evidence')` on the route. Reviewer ⇒ 403, no attachment row, no `evidence_uploaded` event |
| 3 | Default configuration auto-signed visitors in as a lead and allowed account switching | `DEMO_MODE` defaulted to `'true'` in `server/src/index.ts` and `start.sh`; the interface booted a fixture session from `session.demoMode` | Demo mode is now opt-in (`CASELINK_DEMO=true`). Default is `false` in server, `start.sh`, and the interface. `/api/auth/demo-login` returns 403, no demo accounts or passwords are published, no switcher is rendered, `?as=` cannot change identity, and an existing authenticated session is never overridden |

Before/after transcripts (same probe script, fresh seed, default configuration):
[`docs/m1-evidence-before.log`](m1-evidence-before.log) → [`docs/m1-evidence-after.log`](m1-evidence-after.log)

```
PROBE 1  self-grant on RB-2026-00027   200 → 403   (contents readable: true → false)
PROBE 2  foreign lead evidence upload  201 → 403
PROBE 3  granted reviewer upload       201 → 403
PROBE 4  passwordless demo entry       200 → 403   (demoMode true → false, 6 → 0 published accounts)
PROBE 0  unauthenticated GET /cases    401 → 401   (unchanged baseline)
```

---

## 2. Permission model (shared by routes and services)

Implemented in `server/src/domain.ts`; called from `server/src/index.ts` (route guards) and
`server/src/service.ts` (operation guards), so a direct API call cannot behave differently from the
interface.

| Question | Function | Rule |
| --- | --- | --- |
| View coordination metadata | `canViewCoordinationMetadata` | own-bureau cases; cases at an institution where the caller's bureau holds an active case; supervisor region; explicit grants |
| Read restricted contents | `canReadCaseContent` | bureau membership inside the region, or an approved content grant |
| Modify a case | `canModifyCase` | read access **and** owning bureau **and** region **and** a case-worker role; officers only their own assignments; supervisor, reviewer, administrator never |
| Upload evidence | `canUploadEvidence` | case-worker authority only; a content grant is never an upload authorisation |
| Manage case access | `canManageCaseAccess` | owning bureau lead inside the region; supervisor inside oversight scope (incl. approved cross-bureau coordination); **never** officer, reviewer or administrator; **independent** of the actor's own content grant |
| Manage administrative configuration | `canManageAdminConfig` | administrator only |

Supporting pieces: `regionAllows` (unresolved-intake cases are own-bureau only), `hasCasePermission`
(named-question entry point), `describeAuthority` (denial-log reason), `recordSecurityDenial`
(security-log sink), `requireCasePermission` / `requireAdminConfig` (route guards).

Two invariants that the tests pin down:

1. **A read grant answers exactly one question.** It never widens writing, uploading or access management
   (checks 5, 7e–7j).
2. **Seeing coordination metadata never authorises granting contents** (checks 1, 2, 4).

---

## 3. Files changed

| File | Change |
| --- | --- |
| `server/src/domain.ts` | New permission layer (table above). `Capability` list is now interface/navigation guidance only and no longer contains `manage_access`; added `manage_admin_config`. Region-aware `canAssign` / `canDecideRelationship`. `maskCase().grantable` now derives from `canManageCaseAccess` |
| `server/src/service.ts` | `grantCaseAccess` / `revokeCaseAccess` gated by `canManageCaseAccess` (403 + denial log; revoking a non-existent active grant ⇒ 422). New `assertCanUploadEvidence`. Region-aware guards in `updateCase`, `assignCase`, `requestTransfer`, `escalateCase`, `closeEscalation`, `changeDeadline`, `reopenCase`, `resolveTriage`, `decideRelationship`, `revokeRelationship` (12 denial-log sites) |
| `server/src/auth.ts` | `recordSecurityDenial` (existing sink) now imported and used by the service layer as well as the routes |
| `server/src/index.ts` | New guards `requireCasePermission(..., 'modify_case' \| 'upload_evidence' \| 'manage_access')` and `requireAdminConfig`; applied to grants, attachments, case patch/action/assign/transfer/escalate/close/reopen/deadline/triage, relationship decision/revoke; alert acknowledgement uses `canAcknowledgeCoordination`; `/system/worker/tick`, `/system/inject-audit-failure`, `/system/matching-mode` admin-only; `/users` cross-bureau listing admin-only; institution alias review region-scoped; case detail returns the full grant list only to access managers; `permissions` block derived from the shared functions. `DEMO_MODE` default `false`; `TEST_HOOKS` gate for fault injection |
| `start.sh` | `CASELINK_DEMO` default `false` (was `true`), prints the resolved mode |
| `web/src/App.tsx` | Fixture auto-entry, account switcher and `?as=` require `session.demoMode`; an authenticated session is never overridden in a normal configuration |
| `web/src/screens/Login.tsx` | Demo accounts, shortcuts, direct-entry button and password hint render only when the server reports demo mode; normal mode states that sign-in is required |
| `package.json` | Added `test:m1`, `test:security`, `test:demo` |
| `test/security-m1.mjs` | **new** — 63 access-control regressions |
| `test/demo-mode.mjs` | **new** — 8 demo-mode checks (demo instance only) |
| `test/m1-probe.mjs` | **new** — before/after probe for the three defects |
| `test/run-m1.sh` | **new** — starts an isolated sign-in-only instance (8091) and an isolated demo instance (8092) from fresh seeds, runs every suite, cleans up process groups |
| `test/login-check.mjs` | Demo-account shortcut assertion now runs only in demo mode; in normal mode it asserts the opposite (no shortcuts, no password hint, no session created, protected route asks for sign-in) — sign-in assertions unchanged |
| `test/direct-entry.mjs` | Explicitly demo-mode only (exits with a message otherwise) |
| `test/acceptance.mjs` | T12 fault injection and S07 matching mode now use an administrator account (administrative configuration is admin-only since M1); assertions unchanged |
| `README.md`, `docs/API.md`, `docs/TRACEABILITY.md`, `docs/TEST-RESULTS.md`, `docs/DEMO-SCRIPT.md` | M1 behaviour, permission table, results, default-config guidance |

---

## 4. Commands and results

```
npx tsc --noEmit          → exit 0 (no errors)
npx vite build            → exit 0, dist/assets/index-*.js 266.76 kB (gzip 77.36 kB)
bash test/run-m1.sh       → M1 verification: ALL SUITES PASSED
```

`bash test/run-m1.sh` (full transcript: [`docs/m1-verification.log`](m1-verification.log)):

| Suite | Instance | Result |
| --- | --- | --- |
| `test/security-m1.mjs` — M1 access-control regressions | `CASELINK_DEMO=false`, fresh seed, port 8091 | **63/63 pass** |
| `test/demo-mode.mjs` — demo configuration | `CASELINK_DEMO=true`, fresh seed, port 8092 | **8/8 pass** |
| `test/acceptance.mjs` — T01–T12 + S01–S07 | sign-in-only instance | **21/21 pass** |
| `test/login-check.mjs` — sign-in, cookie-cleared Bearer fallback, reload, sign-out, wrong password, no demo shortcuts | sign-in-only instance | **14/14 pass** |
| `test/direct-entry.mjs` — fixture entry, switcher, `?as=`, `#/login` | demo instance | **13/13 pass** |
| `test/ui-smoke.mjs` — 10 screens, 4 accounts, action save, restricted case, reviewer scope | sign-in-only instance | 20 screens captured, **0 console errors** |

The 11 required regressions each map to a check in `test/security-m1.mjs`; the mapping and observed values
are tabulated in [`docs/TEST-RESULTS.md`](TEST-RESULTS.md#required-m1-regressions).

---

## 5. Legitimate workflows verified as still working

| Actor | Workflow | Evidence |
| --- | --- | --- |
| Bureau officer (`p.rao`, `s.iyer`) | create case, update own assigned case, upload evidence, request transfer, read own bureau | security 7d; T01–T12, T11 |
| Bureau lead (`l.verma`, `m.nair`) | assign, dispose, reopen, escalate, deadline change, triage resolution, CSV import, grants on own bureau | 3a, 7a–7c; T07–T10 |
| Supervisor (`a.desai`) | cross-bureau coordination, grant access across bureaus, relationship decisions, escalation | 3c–3e; T06 |
| Read-only reviewer (`r.khan`) | read granted records, list coordination visible to them, acknowledge **own** notification | 5d, 6y; T06 (revocation path is lead/supervisor) |
| Administrator | account directory, worker tick, matching mode, fault injection (test hooks) | T12, S07 |
| All | sign-in, reload, token fallback, sign-out | login 14/14 |

---

## 6. Residual M1 notes (known, deliberate)

* `CANONICAL` region logic: cases whose institution is still unresolved (triage) have no region, so only the
  owning bureau may manage access to them. This is intentional but must be revisited if a cross-bureau
  coordinator needs to grant on unresolvable intake records.
* The security-denial log is append-only with **no read endpoint**. Verification reads the database file
  directly (`test/security-m1.mjs` §11). A staff-facing security log screen needs a retention and access
  decision first.
* `CASELINK_TEST_HOOKS=true` exposes the audit-failure injection to administrators. It is a test hook; it must
  never be set in a production deployment. `CASELINK_DEMO=true` is likewise a fixture-only configuration.
* Sign-in has no rate limiting, lockout or MFA — outside M1 scope, listed below as later work.
* Benchmarks remain sequential (single client); 20 concurrent sessions are still unmeasured.

---

## 7. Remaining work — **not fixed in M1**

These are later milestones. Nothing in this report should be read as claiming them fixed.

1. **Relationship-content checks.** `GET /relationships`, `/coordination` and the case-detail relationship
   block redact reasons/evidence by content scope, but confirming or revoking a link is still authorised by
   role + bureau only — it does not verify that the deciding actor can read both cases' contents
   (`canDecideRelationship` checks `canReadCaseContent` for suggestions only, not on every path).
2. **Evidence redaction and retention.** Attachment contents are access-controlled, but there is no
   redaction pass, no antivirus/scanning pipeline, no retention or deletion policy.
3. **Notification disclosure review.** Notification bodies are generated from institution/case identifiers
   only, but no automated assertion prevents a future template from including complaint text; a disclosure
   review and a lint/test guard are still needed.
4. **Lifecycle correctness.** Transfer acceptance, closure rules and escalation-close semantics follow the
   P0 matrix; edge cases (reopen after transfer, escalation close by a non-designated supervisor, deadline
   recalculation on category change) are not exhaustively specified or tested.
5. **CSV import hardening.** Import enforces bureau, row cap, duplicate/conflict classification and
   idempotency, but not per-field content checks (PII detection, encoding edge cases, adversarial formulae
   beyond export escaping).
6. **Reporting.** Summaries and CSV export reconcile with drill-downs; there is no scheduled reporting,
   no report-level permissioning beyond scope filtering, and no PRD §10 matching-accuracy evaluation.
7. **Authentication hardening.** Rate limiting, lockout, MFA, password policy and session revocation across
   devices are not implemented.
8. **Administrative surface.** No UI for the security log; account creation/role change is seed/config only.

---

## 8. Conclusion

The reported defects are fixed at the API level, not hidden in the interface. Every restriction introduced
here is enforced by the same shared functions used to shape the interface, so a direct API call behaves
identically. The required regressions pass on a demo-disabled instance, demo fixtures still work when
explicitly enabled, and the previously delivered officer, lead, supervisor and reviewer workflows all still
function. **Milestone 1 is complete**; items in §7 remain open for later milestones.
