# CaseLink M2 + M3 + M4 integration and QA

Date: 30 October 2026 (IST). Scope: synthetic institutional complaints only. No M5 work or merges into main.

## 1. Repository and exact source commits

Repository: https://github.com/kandukurinomusubramanyachary-ai/CASELINK

| Ref inspected | Exact commit | Pull request |
| --- | --- | --- |
| Initial local main | `2dca0383964d5f52ec63f224e0e35e193becb83a` | Initial project; not the integration baseline |
| Fetched main | `b36a002225fd6fec787ead84552ede6e8f15c1f4` | Includes earlier security hardening `1348aea` |
| M2: feat/m2-overlap-detection-review-handoff | `1392d2da93821373d70f75d4e19ecc02cf66a3a3` | [#5](https://github.com/kandukurinomusubramanyachary-ai/CASELINK/pull/5) |
| M3: feat/m3-supervisor-review-secure | `831c0b1af102192d25d7cdb6b6839d4459216e46` | [#6](https://github.com/kandukurinomusubramanyachary-ai/CASELINK/pull/6), draft |
| M4: feat/m4-relationship-decisions-secure | `c6f5b4aaf109919774e19a0a9a96a7e19623b977` | [#7](https://github.com/kandukurinomusubramanyachary-ai/CASELINK/pull/7), draft |

Integration branch: `integration/m2-m3-m4-final-qa`, created directly from the verified M4 head. Existing feature branches were not edited.

Implementation commit: `9fdccadfe147ccb2a92ca093204faf7e3d2c018e`. Subsequent delivery updates contain final evidence and documentation only.

`git merge-base --is-ancestor` succeeded for main → M2 → M3 → M4. All intended M2/M3 files are present on M4. Shared changes are incremental registrations, types, routes, schema, and verification entries; no duplicate module APIs were introduced. M4 reuses the hardened relationship service and blocks legacy endpoint bypasses for managed handoffs.

Read-only `git merge-tree --write-tree` checks for each adjacent branch completed without conflicts. No merge or rebase was performed.

## 2–5. Implementation and full integration status

| Module/boundary | Verified behavior |
| --- | --- |
| M2 | Ranked independent candidates; search/category/sort; source-backed matching factors; content-authorized previews; versioned, durable supervisor handoff without a relationship or changes to originals |
| M3 | Assigned supervisor queue; both original complaints and timelines; protected evidence; evidence request notifications to owning leads; resume and accept; review audit and concurrency checks |
| M4 | Accepted-M3 gate; assigned supervisor and both-case permissions; Same/Related/Separate; required reason and current confirmation versions; versioned draft; confirmation; reversal/revision; append-only audit |
| Cross-module state | Actual UI handoff → pending review → evidence request/resume → acceptance → draft → Related confirmation → reversal; reload and two backend restarts preserve state, sessions, evidence metadata, audit, and independent histories |

Same creates a reversible `Duplicate report` relationship; Related creates `Related issue`; Separate records a durable negative decision without an active relationship. Drafts create no approved relationship. Reversal preserves earlier decisions and original complaint ownership, summaries, statuses, evidence, and histories.

The matching engine is deterministic. The frozen evaluation measured 40/40 duplicate, 39/40 related, and 40/40 unrelated classifications on 120 synthetic pairs. One related pair was missed. These figures do not establish accuracy on real complaints or production readiness.

## 6. Confirmed defects and changes

1. **Same-module navigation retained stale selected reviews.** Reproduced in Chromium: opening M3 detail and clicking the Supervisor Review sidebar link changed the hash but retained the old detail. Route components now have keys based on the selected record. The continuous regression checks the sidebar action and browser Back. M2 and M4 record transitions use the same identity rule to prevent retained form/selection state crossing records.
2. **Windows verification paths were invalid.** Matching evaluation and migration verification resolved URL pathnames containing `/C:/` and `%20`. They now resolve the module directory using Node 22's `import.meta.dirname`.
3. **Matching evaluation left SQLite open during cleanup.** Its actual assertions succeeded but Windows returned EBUSY while removing the temporary DB. The connection now closes before deletion; labels, thresholds and assertions were preserved.
4. **Development server listened on every network interface.** It now binds to `127.0.0.1` by default. `CASELINK_HOST` is available for explicitly configured private container routing. The reliability suite asserts loopback startup.
5. **M2 retained the handoff label after M4 confirmation.** Reproduced in the Previously decided queue: the backend suggestion was accepted but the UI still said Sent for review. The decision/outdated states now take precedence over the earlier handoff label. The continuous regression verifies the M2 row after M4 confirmation.
6. Added the continuous real-backend browser/restart regression, v8 → v11 migration regression, and `npm run test:integration`. Added `--prepare-only` to the existing demo fixture so manual testing can start in M2 with private synthetic evidence and no pre-created handoff.

No relationship policy, audit guard, security assertion, or matching threshold was weakened.

## 7. Automated execution evidence

Final full-run result: **PASS — 49/49 commands, zero failures, zero required checks skipped**, executed on Windows with Node 22.23.4. Full local logs: `.runtime/verification-ikby5z`. Machine-readable results: [final-results.json](integration-evidence/final-results.json).

Independent GitHub/Linux verification of implementation commit `9fdccadfe147ccb2a92ca093204faf7e3d2c018e` also passed **49/49**: [successful run 41106066318](https://github.com/kandukurinomusubramanyachary-ai/CASELINK/actions/runs/41106066318), [full logs and screenshots artifact](https://github.com/kandukurinomusubramanyachary-ai/CASELINK/actions/runs/41106066318/artifacts/13000799585). The completed job log was inspected, not inferred from the PR description.

The applicable gate is `npm run verify` under Node 22. It runs TypeScript, production build, reliability, access/search, frozen matching evaluation, continuous M2→M3→M4 journey, isolated M1/M2/M3/M4 API/security suites, lifecycle/concurrency/import/audit regressions, acceptance, sign-in, UI, refresh, demo and direct-entry checks. Each API suite gets its own explicitly seeded synthetic database. Existing filenames containing later milestone numbers are inherited regression checks, not new M5 implementation.

Additional commands actually executed:

| Command | Result |
| --- | --- |
| `npm ci --no-audit --no-fund --cache .npm-cache` | PASS, locked dependencies installed under Node 22.23.4 |
| `npx playwright install chromium` | PASS, lockfile-compatible Chromium 130 / Playwright build 1140 installed |
| `node test/m2-m3-m4-integration.mjs` | PASS after navigation fix; desktop, tablet 820×1180, mobile 390×844; two backend restarts |
| `node --import tsx test/matching-eval.ts` | PASS after path/cleanup fixes; frozen labels unchanged |
| `npm audit --omit=dev --audit-level=high --json` | PASS, zero production vulnerabilities returned by the advisory service |
| Private local preview browser check | PASS: real login, exact candidate URL, both original complaints |
| `node scripts/prepare-m3-m4-demo.mjs --prepare-only` | PASS on the private manual environment; no handoff or decision created |
| `node scripts/prepare-m3-m4-demo.mjs` | PASS on a separate disposable loopback server; handoff created, no review/relationship decision; server then stopped |

Dedicated API/security results on the final implementation:

| Suite | Executed / passed |
| --- | --- |
| M1 security | 65 / 65 |
| Regional authorization | 59 / 59 |
| Relationship authorization/privacy | 40 / 40 |
| M2 API/integration | 11 / 11 |
| M3 supervisor review | 13 / 13 |
| M4 relationship decisions | 18 / 18 |
| Legacy migration/preservation | 17 / 17 |
| Reliability, including actual v8 → v11 creation | 13 / 13 |

Earlier failures are not counted as passes: sandbox execution initially denied child-process creation (0/1 runner command); the original full local baseline finished **46/48**, failing the Windows fixture path and the M2 browser prerequisite. The new continuous test initially failed on M3 navigation and, when extended, on the incorrect M2 confirmed-state label. Matching evaluation also exposed the SQLite cleanup error. These failures were reproduced and corrected before the final gate. The initial baseline command results are retained in `integration-evidence/baseline-results.json`.

## 8. Security and database verification

The API suites test authentication, roles, assigned supervisor, regional restrictions, both-case grants, evidence bytes, revoked access, notification redaction, direct routes, idempotent replay authorization, malformed/missing payload fields, stale versions, canonical pair ordering, conflicting concurrent confirmations, injected transaction failure and rollback, and SQLite audit UPDATE/DELETE rejection.

The new continuous test independently verifies unauthorized officer and West-supervisor browser routes, private evidence access, case-scoped notifications, preserved originals, real loading and network-error recovery, foreign-key integrity, and SQLite integrity after decisions and reversal.

Migrations reviewed:

- **9:** unique suggestion/supervisor handoff and supervisor queue index.
- **10:** review ledger, valid review-state constraint and review event index.
- **11:** versioned drafts, canonical decisions and unique active-pair index, append-only events with mutation-blocking triggers, request-hash-bound idempotency records.

Fresh isolated seeds apply migrations 1–11. The added upgrade regression removes only empty module tables from its disposable seeded fixture to reproduce v8, applies migrations 9–11, checks all tables/indexes/triggers, preserves original case rows and versions, verifies foreign keys, and proves a second migration applies nothing. The existing pre-M3 migration regression also runs in the full gate.

## 9. Screenshots and logs

See [the screenshot index](screenshots/integration/README.md). Screenshots were captured by Playwright against Express/SQLite, including handoff, evidence request, acceptance, persisted draft, confirmed decision, reversal/audit, desktop/tablet/mobile and recoverable error state.

Machine-readable final command results and the production audit are stored in `integration-evidence/`. Full local stdout/stderr, per-suite server logs and isolated test databases remain under `.runtime/verification-*`; databases are excluded from Git delivery.

## 10. Interactive environment and hosted preview

A real loopback-only local environment was created and browser-verified:

**http://127.0.0.1:8186/#/overlaps/ec1dfa78-cff4-4243-abaa-0312132ae6d2**

It uses an isolated persistent SQLite directory, `CASELINK_DEMO=false`, and `CASELINK_TEST_HOOKS=false`. The two prepared complaints are **PGRC-2026-00040** and **PGRC-2026-00041**. Both have synthetic PNG evidence and explicit supervisor content grants. The environment starts before any handoff or review/relationship decision.

This URL is accessible only on the computer running the local server, not a hosted Internet preview. No hosted Codespace was provisioned: the connected GitHub tools do not offer Codespaces creation, and no authenticated Codespaces CLI is available. No deployment URL is claimed. Sites was not used because no supported persistent private Express/SQLite runtime was established there.

Local process and data metadata: `.runtime/private-review.json`. Stop this specific preview with PowerShell:

```powershell
$review = Get-Content .runtime/private-review.json -Raw | ConvertFrom-Json
Stop-Process -Id $review.pid
```

Do not reseed a populated review database. Use a new isolated directory for another run so immutable decision history remains preserved.

To restart the same persistent local environment after stopping it, from the repository in PowerShell:

```powershell
$review = Get-Content .runtime/private-review.json -Raw | ConvertFrom-Json
$env:CASELINK_DATA_DIR = Join-Path $review.root 'data'
$env:CASELINK_HOST = '127.0.0.1'
$env:CASELINK_DEMO = 'false'
$env:CASELINK_TEST_HOOKS = 'false'
$env:PORT = '8186'
& .runtime/node-v22.23.4-win-x64/node.exe --import tsx server/src/index.ts
```

### Exact private Codespaces setup

In GitHub, open the repository, select `integration/m2-m3-m4-final-qa`, then **Code → Codespaces → Create codespace on this branch**. Keep the forwarded port private. In its terminal:

```bash
nvm install 22
nvm use 22
npm ci --no-audit --no-fund
npm run typecheck
npm run build
export CASELINK_DATA_DIR="$PWD/.runtime/manual-review-$(date +%s)"
export CASELINK_HOST=127.0.0.1
export CASELINK_DEMO=false
export CASELINK_TEST_HOOKS=false
export PORT=8080
npm run seed
npm run serve
```

In a second terminal:

```bash
BASE=http://127.0.0.1:8080 npm run demo:m3-m4 -- --prepare-only
```

In **Ports**, forward **8080** with **Private** visibility and open the authenticated forwarded URL. Append the `/#/overlaps/<suggestion-id>` fragment printed by the fixture command. Do not make the port public. The Codespace filesystem stores the isolated DB between server restarts; do not use `/tmp` for this preview or delete the Codespace before retaining any desired synthetic evidence.

## 11. GitHub review and merge sequence

Existing PRs: [M2 #5](https://github.com/kandukurinomusubramanyachary-ai/CASELINK/pull/5), [M3 #6](https://github.com/kandukurinomusubramanyachary-ai/CASELINK/pull/6), [M4 #7](https://github.com/kandukurinomusubramanyachary-ai/CASELINK/pull/7).

At audit time, all three were open, unmerged, mergeable, with successful CodeRabbit status and no inline review threads. Their exact-head Submission verification runs were successful:

- [M2 run 40959708534](https://github.com/kandukurinomusubramanyachary-ai/CASELINK/actions/runs/40959708534)
- [M3 run 40963255320](https://github.com/kandukurinomusubramanyachary-ai/CASELINK/actions/runs/40963255320)
- [M4 run 40963956528](https://github.com/kandukurinomusubramanyachary-ai/CASELINK/actions/runs/40963956528)

Integration PR: [#8](https://github.com/kandukurinomusubramanyachary-ai/CASELINK/pull/8), draft, based on M4 so only integration fixes and QA evidence appear in its diff.

After approval, preserve ancestry with merge commits: M2 → main; retarget M3 to main and merge; retarget M4 to main and merge; then retarget the integration PR to main and merge after its checks. Alternatively approve the integration fixes into M4 before that sequence. No rebase is required for the currently inspected heads. Squash/rebase merges change ancestry and require rebasing or retargeting/rechecking descendants; never blindly merge the full stack again.

## 12. Remaining limits and acceptance

- Human manual acceptance is **pending**; automated browser actions are not user sign-off.
- The hosted Codespace and its private forwarded URL have not been created or verified; exact setup is above. The local environment is verified.
- The matcher misses one labelled related pair and has no semantic embedding model. Synthetic data cannot prove production behavior, real-world matching quality, operations, retention or recovery at scale.
- M3/M4 PRs remain drafts until the owner completes review. No production deployment was performed.

## 13. Manual walkthrough

All credentials below belong to disposable synthetic accounts; password for each is **`caselink-demo`**.

| Username | Role/scope | Use |
| --- | --- | --- |
| `m.nair` | South PGRC bureau lead | Prepare and hand off complaints; view evidence-request notices |
| `a.desai` | South supervisor | Assigned M3 review and M4 decisions; explicit grants already issued for both prepared cases |
| `p.rao` | South PGRC officer | Negative supervisor-only route test |
| `v.kumar` | West supervisor | Negative regional/assignment route test |

1. Open the local candidate URL above and sign in as `m.nair`. Expect complaint details for cases 00040 and 00041. To start in the dashboard, open `#/overlaps`, search for `PGRC-2026-00040`, set category Infrastructure, and inspect the row containing both prepared cases.
2. Click **Explain this match**. Expect stored rule signals and wording overlap; inspect the read-only complaint previews.
3. Click **Send for supervisor review**, select **Ananya Desai**, enter at least ten characters explaining the request, and submit. Expect the recorded handoff confirmation. Both cases and relationship state must be unchanged.
4. Sign out. Sign in as `a.desai`, open `#/supervisor-review`, and select the pair. Expect Pending state, both original summaries, separate timelines and private synthetic evidence buttons.
5. Open each evidence file and inspect both timelines. Select **Request More Evidence**, enter a reason, and click **Record Supervisor Action**. Expect Awaiting Evidence and a delivery count. In a separate session as `m.nair`, the Notifications inbox must contain case-scoped evidence requests.
6. As the supervisor, select **Resume Review**, give a reason and record it. Then select **Accept for Decision**, give a reason and record it. Expect Accepted state and **Proceed to Relationship Decision**.
7. Click **Proceed to Relationship Decision**. This opens `#/relationship-decision/<handoff-id>`. Choose **Related**, select an appropriate reason category, enter an explanation, and click **Save Draft**.
8. Reload. Expect the same draft/reason and **No active confirmed relationship for this pair**.
9. Click **Confirm Decision**. Expect **Confirmed: Related**, the reason and a new persisted audit entry. Reload again; the confirmed decision must remain.
10. Enter a reversal reason and click **Undo / Reverse Decision**. Expect no active confirmed relationship, the earlier Related decision marked Reversed, and both confirmation/reversal audit events.
11. Reload. Inspect both original complaint histories, evidence, owners and statuses. They must remain separate. A later Same or Separate classification creates another preserved decision rather than rewriting the old one.
12. Copy the M3/M4 detail URL. Sign out and try it as `p.rao` and `v.kumar`: no complaint summaries or evidence should be exposed. An unauthenticated user should be asked to sign in.

## 14. Recommendation

**NOT READY TO MERGE until manual acceptance and owner approval are complete.** Automated integration, security, browser, migration, build and regression gates passed on Windows and GitHub/Linux; no known critical integration defect remains from this synthetic run. PR #8 remains a draft alongside the stacked M3/M4 drafts. Complete the walkthrough, review the stack, approve the changes, and then follow the merge sequence above. No merge has been performed, and production readiness is not established by these synthetic tests.
