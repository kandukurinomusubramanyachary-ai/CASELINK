# Milestone 1 — Overlap review and accountable officer assignment

## Status

**Slice 1: reviewer-approved relationship → case assignment handoff.** This is a narrow implementation, not completion of the milestone.

The existing rule engine already produces institution-level overlap alerts and related-case suggestions. Authorized reviewers already have a versioned, audited decision action for `Related issue`, `Duplicate report`, or `Separate issues`. Each complaint retains its original case ID and owner.

This slice connects the **review decision** to the next real task without broadening permissions:

1. Officer with access to both complaint contents reviews the evidence in Coordination.
2. Authorized reviewer confirms or dismisses the relationship; no case is merged automatically.
3. Confirmed relationships display **Next step: assign officers**, with one handoff per original case.
4. Only the lead of the owning bureau, in the institution's region (or with national scope), gets the **Open to assign** shortcut. The case workspace remains the source of truth and independently checks authorization, officer eligibility and case version on every assignment request.
5. Other readers see that the owning bureau lead must assign; a hidden case never gets a link or readable case reference through this handoff.
6. Revoking a relationship removes the handoff; case ownership is never rewritten as a side effect of relationship approval or revocation.

## Not yet implemented

The requested **one responsible coordinator for a multi-case investigation** requires its own persisted coordination record, not a label on an existing case assignment. Do not claim this slice implements it.

Next slices should add, with separate reviewed PRs:

- A supervisor-controlled overlap review task with a recorded reviewer, scope, pending/approved/rejected state and versioned decision; retain existing relationship review semantics.
- A persisted coordinator designation covering an approved relationship or overlap group; the responsible person must have the required region and access, and designation must never confer unrestricted case-content visibility.
- Bureau-lead acceptance/assignment for each underlying case, with separate owners, audit events and current-version checks. No cross-bureau direct assignment or bypass of a pending transfer.
- An accountable coordination timeline (accepted, in progress, resolved), avoiding silent case closure.
- Backend negative tests for unauthorized and out-of-region designation, revoked grants, stale versions, duplicate submit, reassignment, relationship revocation and matching outages.
- Browser acceptance tests covering full officer-review → coordinator designation → lead assignment → tracking with two bureaus and masked restricted cases.

## Verification

- `test/acceptance-ui.mjs` now checks that approving a relationship presents an explicit handoff for both original case IDs to the owning lead.
- All Milestone 0 verification commands remain required; run `npm ci`, `npm run typecheck`, `npm run build`, `npm run verify` and `npm audit --omit=dev --audit-level=high` on this branch.
- GitHub Actions must pass; do not merge before human review. The Milestone 0 baseline PR must be approved and integrated before the feature PR is promoted to `main`.

## Security design decisions

- Do not auto-approve overlaps or auto-merge cases.
- Never allow a reviewer from a different bureau to assign an owner unless the existing case-assignment policy explicitly authorizes it (currently it does not).
- Preserve content redaction, regional scope, ownership, deadlines and version checks.
- Do not persist an informal coordination assignment in complaint free-text or reuse case `assigned_officer_id` for multiple cases.
- Displaying a case link does not imply permission to modify it; the API remains authoritative.
