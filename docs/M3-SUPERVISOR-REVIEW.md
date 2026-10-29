# M3 — Supervisor Review (isolated implementation)

## Dependency and isolation

M3 is stacked on the M2 draft PR branch (commit 7458d4f), but does not write to that branch.
The M2 handoff is an explicit assignment to one named supervisor. There are no fallback mock handoffs
in the production API. M3's tables are migration 10, following M2 migration 9.
**Do not merge M3 before M2 passes CI and is approved.** If the parent branch is changed, rebase M3
and rerun every suite.

## Routes

- `GET /api/m3/reviews`: only handoffs addressed to the authenticated supervisor;
  current case region and content grants are checked for both complaints.
- `GET /api/m3/reviews/:handoffId`: two full complaint summaries, stored rule explanations,
  separate case timelines, current published attachment metadata, M3 action history.
- `POST /api/m3/reviews/:handoffId/actions`: `accept`, `needs_review`,
  `request_evidence`, `resume`; requires reason of 10–1000 characters and
  review `expectedVersion`. Validated and committed transactionally.
- `GET /api/m3/reviews/:handoffId/evidence/:attachmentId`: authorized
  inline preview for supported MIME or protected download; no public file URLs.

The applicant role and region are read from the authenticated session on every request.
Supervisor authorization also requires current content access to **both** complaints.
A handoff ID is not a capability: knowing it grants no access. No new rights are awarded by M3.
Case histories, complaint ownership and complaint statuses remain unchanged by review actions.
M3 **does not** create a Same/Related/Separate decision; M4 must enforce the accepted state.

## Durable state

- `m3_reviews`: per-handoff review state and optimistic integer version.
- `m3_review_events`: append-only supervisor actions with actor, before/after state,
  reason, timestamp and version. These records are not generated from UI fixtures.
- M2's original handoff row remains unchanged.
- The M3 review ledger does not overwrite `action_events` or `relationships`.

## Manual testing (synthetic data)

1. Run `npm ci` and `npm run seed` against a fresh, isolated `CASELINK_DATA_DIR`.
2. Start server with `CASELINK_DEMO=false npm run dev`; demo user password for seeded fixtures is
   `caselink-demo` (never use seeded demo accounts with real complaints).
3. Sign in as seeded bureau lead `m.nair`; **before handoff**, grant supervisor `a.desai`
   explicit content-read access to **both** complaints using each case's access-management controls.
   An M2 handoff does **not** confer content access.
4. Use M2 Overlap Detection to send the South-region candidate to `a.desai`.
   Then sign in as `a.desai`, open `#/supervisor-review` and select the assigned pair.
5. Inspect evidence and both timelines. Use Request More Evidence with a detailed reason.
   Verify `awaiting_evidence` and a persisted audit entry. Resume and accept for decision.
6. Sign in as officer `p.rao` and West supervisor `v.kumar`; direct M3 routes
   must deny access or hide the pair. Revoking case grants or regional scope must also deny access.

## Verification

`npm run verify` includes independent M3 API + security suite (`test/m3-supervisor.mjs`)
and desktop/mobile Playwright suite (`test/m3-ui.mjs`).
The browser suite captures files named `m3-*.png` in the verification screenshots directory.

**Status at authorship:** All gates are NOT RUN until CI executes the new branch.
Do not interpret test source or past M2 results as passing M3.
