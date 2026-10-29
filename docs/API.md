# CaseLink API reference (P0 + Milestone 1)

Base path `/api`. All responses are JSON unless noted. Authentication is a server-side session cookie
(`caselink_session`, HttpOnly, SameSite=Lax, 8 hours) or an `Authorization: Bearer <token>` header for
frames that block cookies. There is no client-supplied role.

**Sign-in is required by default.** `POST /auth/demo-login` — the passwordless fixture entry — exists only
when the server is started with `CASELINK_DEMO=true`; in every other configuration it returns `403`. The
default deployment publishes no demo accounts, no demo password and no identity switcher.
Normal startup does not seed accounts or complaint data. Provision the first administrator explicitly
with `npm run bootstrap:admin`; use demo mode or an explicit seed command only for synthetic fixtures.

Unsafe browser requests must have a same-host Origin and must not have `Sec-Fetch-Site: cross-site`.
Non-browser clients can use the existing Bearer transport. Login inputs are bounded to a 60-character
username and a 256-character password; repeated failed logins return `429` with `Retry-After`.

## Authorisation model

Every endpoint resolves the caller's **scope** from the authenticated account:

```
role × bureau membership × region × explicit case grant
```

Two visibility levels are computed per request:

| Level | Fields |
| --- | --- |
| **content** | complaint summary, source reference, complainant contact, attachments, history remarks, before/after values |
| **metadata** (coordination) | institution, case number, category, bureau, status, owner role, received time, last action time, deadlines |

Lists, counts, pagination, search, matching candidates, exports and downloads are all filtered before
counting. A bureau officer/lead sees content for their own bureau inside their region; a supervisor sees
metadata across their region and content only where a grant exists; a read-only reviewer and an
administrator see nothing without a grant.

## Permission questions (Milestone 1)

Six separate questions, each answered from the authenticated account (role, bureau, authorised region,
approved grants) by the shared functions in `server/src/domain.ts`. Route handlers *and* service
operations call the same function, so a direct API call cannot bypass an interface restriction.

| Question | Function | Rule |
| --- | --- | --- |
| View coordination metadata | `canViewCoordinationMetadata` | own-bureau cases; cases at an institution where the caller's bureau holds an active case; supervisor region; explicit grants |
| Read restricted contents | `canReadCaseContent` | bureau membership inside the region, or an approved content grant |
| Modify a case | `canModifyCase` | read access **and** owning bureau **and** region **and** a case-worker role; officers only their own assignments; supervisor, reviewer and administrator never |
| Upload evidence | `canUploadEvidence` | case-worker authority only — **a content grant is not an upload authorisation** |
| Manage case access (grant/revoke) | `canManageCaseAccess` | owning bureau lead inside the region; supervisor inside oversight scope including approved cross-bureau coordination; never officer, reviewer or administrator; independent of the actor's own grants |
| Acknowledge a coordination alert (shared state) | `canAcknowledgeCoordination` | authorised against **the alert**: its institution must be inside the caller's authorised region and at least one listed case must be inside the caller's coordination scope; bureau officer/lead/supervisor only (reviewers and administrators are refused); `region` null preserves the national-oversight policy |
| Decide a transfer (accept/reject) | `canDecideTransfer` | lead of the **target** bureau **and** regional authority over the actual case; not an owning-bureau guard, since the receiving lead does not own the case yet |
| Manage administrative configuration | `canManageAdminConfig` | administrator only |

Consequences enforced over HTTP:

* A lead who can see a foreign case's coordination metadata **cannot** grant access to its contents (403).
* A read-only reviewer holding a legitimate content grant can read, but cannot modify the case, upload
  evidence, assign, transfer, change deadlines, reopen, manage grants, or confirm/revoke a relationship (403).
* A content grant given to a foreign-bureau officer allows reading only.
* Acknowledging a coordination alert changes shared state and needs authority over **that alert's region**;
  acknowledging a *personal notification* (`POST /notifications/:id/acknowledge`) does not. A regional
  supervisor cannot acknowledge another region's alert, and a read grant never substitutes for regional
  authority.
* Transfer decisions require the target bureau's lead to have authority over the case's own region. A lead
  from another region — even the receiving bureau's lead — is refused, and the transfer stays pending with
  ownership, assignment, version and history untouched.
* All denials return `403 access_denied` and append a security-denial record; grants, case records and
  business history are left untouched.

## Error contract

| HTTP | `error` | When |
| --- | --- | --- |
| 401 | `authentication_required` / `invalid_credentials` | no or invalid session |
| 403 | `access_denied` | outside scope, or role not permitted for the action |
| 404 | `not_found` | unknown record (also used for an attachment reached through another case) |
| 409 | `stale_version`, `transfer_pending`, `already_decided`, `already_committed`, `conflict` | concurrency or duplicate action |
| 413 | `file_too_large` | attachment above 10 MB |
| 422 | `validation_error`, `invalid_transition`, `attachment_limit`, `invalid_type` | field or state-machine problems (`fields` map included) |
| 500 | `server_error` | nothing was saved; the transaction rolled back |

## Auth

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/auth/login` | `{ username, password }` → sets session cookie |
| `POST` | `/auth/logout` | clears the session |
| `GET` | `/session` | current user, capabilities, demo accounts (demo builds only) |
| `GET` | `/meta` | categories, channels, statuses, bureaus, regions, active deadline policies |

## Institutions

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/institutions?q=` | visible directory with per-institution case counts, active bureaus and overlap state |
| `GET` | `/institutions/resolve?name=` | fuzzy **suggestions** (score + `suggestionOnly: true`); never an automatic merge |
| `GET` | `/institutions/:id` | profile, reviewed aliases, visible case history, overlap, suggestions, relationships |
| `POST` | `/institutions/:id/aliases` | bureau lead or supervisor records a reviewed alias with its source |

## Cases

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/cases` | create; server generates UUID and case number. Accepts `Idempotency-Key`. Unconfirmed identity ⇒ `triage_state = unresolved` |
| `GET` | `/cases` | filters: `q, bureau, status, category, region, receivedFrom, receivedTo, institutionId, mine, unassigned, overdue, pending, escalated, triage, sort, page, pageSize` |
| `GET` | `/cases/:idOrNumber` | full workspace payload (case, history, relationships, suggestions, transfers, attachments, grants, options, next states); body is masked when content access is absent |
| `PATCH` | `/cases/:id` | versioned update: status, category, summary, contact, next action/due, response due/role, decision reference, remarks |
| `POST` | `/cases/:id/actions` | append an action event (remarks required); used for pure notes |
| `POST` | `/cases/:id/assign` | bureau lead assigns/clears the owner (reason required) |
| `POST` | `/cases/:id/transfer` | request a transfer `{ toBureau, reason }`; idempotency key supported |
| `POST` | `/transfers/:id/decision` | a **lead of the target bureau with authority over the case's region** accepts (`officerId` optional ⇒ assignment queue) or rejects; both branches guarded before any write, 403 otherwise |
| `POST` | `/cases/:id/escalate` | open an escalation flag with reason and responsible supervisor |
| `POST` | `/cases/:id/escalation/close` | supervisor/lead records completion |
| `POST` | `/cases/:id/reopen` | bureau lead reopens a disposed/closed case with a reason |
| `POST` | `/cases/:id/deadline` | authorised deadline change with reason (or `null` for "no deadline configured") |
| `POST` | `/cases/:id/triage` | resolve an unresolved institution identity |
| `POST` | `/cases/:id/grants` | grant or revoke ( `revoke: true` ) explicit case access, with a note. Requires `manage_access` authority (403 otherwise); the case payload returns the full grant list only to access managers |
| `POST` | `/cases/:id/attachments` | multipart file; PDF/PNG/JPEG validated from content, 10 MB, 5 per case. Requires `upload_evidence` authority (403 otherwise) |
| `GET` | `/cases/:id/attachments/:attachmentId` | authorised download; audited |

## Coordination

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/coordination` | institution overlaps visible to the caller, permitted case references, suggestions with evidence, recorded relationships, matching mode |
| `POST` | `/alerts/:id/acknowledge` | acknowledgement is awareness, not resolution. Authorised against the alert's institution region and listed cases (403 outside the caller's region) |
| `POST` | `/suggestions/:id/decision` | `{ decision: 'Related issue' \| 'Duplicate report' \| 'Separate issues', reason, caseAVersion, caseBVersion }`; both versions are required |
| `GET` | `/relationships` | reviewer-confirmed links visible to the caller |
| `POST` | `/relationships/:id/revoke` | revoke with a required reason; both cases stay intact |

## Notifications, reports, import, my work

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/my-work` | assigned / unassigned / overdue / approaching / escalated / triage queues with counts |
| `GET` | `/notifications` | persisted notifications for the caller |
| `POST` | `/notifications/:id/read`, `/notifications/:id/acknowledge` | read state and acknowledgement |
| `GET` | `/reports/summary` | totals, definitions, status/bureau/category breakdown, ageing, workload |
| `GET` | `/reports/export` | CSV of permitted rows/fields; header carries snapshot time, timezone and filters; formula-like cells are prefixed |
| `GET` | `/import/template` | CSV template |
| `POST` | `/import/preview` | validate a batch and return per-row status (`valid`, `triage`, `rejected`, `duplicate`, `conflict`) |
| `POST` | `/import/:batchId/commit` | commit valid rows only; returns accepted/rejected/skipped and per-line detail |

## Operations endpoints (administrator only)

`/system/worker/tick`, `/system/matching-mode` and `/system/inject-audit-failure` are administrative
configuration changes: they require the `admin` role and return `403` for every other account.
`/system/inject-audit-failure` additionally requires demo mode or `CASELINK_TEST_HOOKS=true`, because it is
a fault-injection test hook.

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/system/status` | authenticated scheduler/matching state; includes `pendingJobs`, `retryingJobs`, `failedJobs`, `oldestPendingAt` and a redacted `lastError` |
| `POST` | `/system/worker/tick` | run the scheduled deadline/escalation scan now (admin) |
| `POST` | `/system/matching-mode` | switch between `rule-based` and `unavailable` to demonstrate the outage path (admin) |
| `POST` | `/system/inject-audit-failure` | fault injection to prove atomic rollback (T12); admin + demo/test hooks only |

`GET /users` lists accounts inside the caller's bureau; a cross-bureau listing requires the administrator
role (403 otherwise).

## Concurrency and idempotency

* Case mutations submit the `version` the client was shown; a stale version returns `409 stale_version`
  with the current version, and the interface keeps the user's text for reconciliation.
* `POST /cases` and `POST /cases/:id/transfer` accept an idempotency key; identical replays return the
  original response and create nothing new.
* A case change, its action event and any pending background work are committed in one transaction. A
  failing audit write rolls the business mutation back.
