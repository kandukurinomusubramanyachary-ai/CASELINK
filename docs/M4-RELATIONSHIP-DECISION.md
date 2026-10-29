# M4 — Human Relationship Decisions

## Isolation and prerequisites

- This is a separate draft PR stacked on M3 PR #6, itself stacked on M2 PR #5.
- M3 must have review state `accepted` for the selected handoff before drafting or confirming.
- The authenticated caller must be the supervisor to whom that M2 handoff was addressed,
  hold **current content access to both cases** and pass the shared relationship authorization policy.
- An M2 handoff does not itself grant content access; the responsible bureau lead must issue
  appropriate case grants. Every read, write and idempotency replay checks the grants again.
- No merge into main and no production deployment until reviewed and tested.

## API

- `GET /api/m4/decisions/:handoffId`: current case summaries, original independent case histories,
  published evidence metadata, M3 eligibility, draft, confirmed/reversed decisions and database audit events.
- `POST /api/m4/decisions/:handoffId/draft`: decision, category, reason, expectedDraftVersion.
  Optimistic draft update, append-only audit; DOES NOT create a confirmed relationship.
- `POST /api/m4/decisions/:handoffId/confirm`: decision (Same / Related / Separate),
  category, 10–1000 character reason, both current case versions and M3 review version.
  Requires `Idempotency-Key` header. All case changes, relationship decision and audit are atomic.
- `POST /api/m4/decisions/:handoffId/reverse`: confirmed decision ID, expected decision
  version, current case versions and nonempty reason. Requires `Idempotency-Key`.
  Reversal preserves original case and evidence history and allows a later revised classification.

## Relationship semantics

| UI choice | Existing hardened case service | Database behavior |
|---|---|---|
| Same | Duplicate report | Active, reversible relationship; originals intact |
| Related | Related issue | Active, reversible relationship; separate case ownership/status |
| Separate | Separate issues | Durable negative decision; **no active relationship row** |

The normalized canonical pair key is the sorted pair of internal case IDs, independent of
input ordering. A unique partial index prevents more than one confirmed active decision for a
pair, even across distinct handoffs or concurrent supervisors.

Existing service functions perform permission and version validation as well as independent
case history events. M4 adds a layer of M3 eligibility, durable draft/decision records,
idempotency and immutable audit. Reversals restore the suggestion to a pending state;
earlier relationship and decision history remains stored in full.

## Schema and security

Migration 11 creates:
- `m4_drafts` — versioned unapproved decisions.
- `m4_decisions` — versioned, canonical relationship decisions, soft reversal.
- `m4_decision_events` — append-only event ledger; SQLite UPDATE/DELETE prevention triggers.
- `m4_idempotency` — request-hash-bound per-actor keys; atomic with the decision.

No client authority claims are trusted. An idempotent replay is authorized before reading a
stored response. Cross-region callers and users who lost a content grant do not see
private relationship explanations.

## Independent regression gates

`npm run verify` now runs `test/m4-relationship.mjs` and `test/m4-ui.mjs` in
separate seeded synthetic databases. This covers:
- all three decision classifications and a negative decision;
- mandatory M3 acceptance; role, region and dual-case content authorization;
- required reasons and case versions; optimistic draft/decision checks;
- idempotent retries, conflict detection, canonical pair consistency;
- persisted audit, DB-level immutable events, genuine rollback on transaction failures;
- reversal and subsequent revision with original complaint history preserved;
- actual browser interactions and mobile viewport screenshots.

`.github/workflows/m4-focused.yml` runs fast isolated API and browser gates; the shared
submission verification runs the full repository suite.

## Private interactive preview (no public deployment)

ChatGPT Sites has no verified deployable backend for this local SQLite service here. Use a
private GitHub Codespace or local machine; the app, API and SQLite are fully connected.

In the repository branch `feat/m4-relationship-decisions-secure`:

```bash
npm ci
export CASELINK_DATA_DIR=/tmp/caselink-review-preview
npm run seed
CASELINK_DEMO=false npm start
```

In a second terminal in the same workspace:

```bash
npm run demo:m3-m4
```

Open the M3 URL printed by that command on port 8080. The demo fixture creates
**real synthetic database rows** and a real M2 handoff, but makes no review or relationship
decisions for you. Login as `a.desai` / `caselink-demo`, test M3, then accept for M4.
Use the Codespaces **Ports** panel to open port 8080 privately; keep it private.
The link is created by your own Codespace and cannot be claimed or verified here.

## Exact manual test

1. On a fresh synthetic database, sign in as seeded bureau lead `m.nair`.
2. Use existing CaseLink workflows to create two overlapping South-region complaints.
   Grant `a.desai` current content access to both via each case's access management.
3. Send the M2 candidate to `a.desai` via M2 handoff.
4. Sign in as `a.desai`, open `#/supervisor-review`, inspect both originals and evidence,
   and record **Accept for Decision** with a reason.
5. Click **Proceed to Relationship Decision** or navigate to `#/relationship-decision/<handoff-id>`.
6. Select **Related**, choose reason category, enter an explanation and click **Save Draft**.
   Reload: the draft should remain, but **no confirmed relationship** should exist.
7. Click **Confirm Decision**. Reload: the confirmed link and actual audit events should remain.
8. Enter a reversal reason and click **Undo / Reverse Decision**. Reload: the old decision
   is marked reversed; both original case histories and evidence remain.
9. Change to **Same** or **Separate**, confirm, and verify the newly stored event.
10. Attempt the same route as officer `p.rao` or West supervisor `v.kumar`:
    the API must deny the request. Revoke a grant and try again: no content may be returned.

Do not use real complaint data, production secrets, or live AICTE systems.

## M5 interface (not implemented)

The read-only GET response returns an `assignmentBoundary` describing an approved pair,
with record IDs and relationship decision ID. No officer-assignment API, mutation or UI
is implemented. M5 must enforce its own assignment permissions.

**Verification at authorship: NOT RUN.** Only CI results can change this claim.
