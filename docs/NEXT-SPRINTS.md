# CaseLink — prioritized post-baseline sprints

Milestone 0 does not implement these enhancements. Each sprint should branch only from the approved,
CI-green baseline, change one feature area, include regression evidence and preserve the existing security
and data-correctness gate. Any newly confirmed critical security or integrity defect preempts this order.

## Release gate before feature work (required, not a feature sprint)

1. Publish local branch `milestone0/stable-baseline` without force-pushing.
2. Open a **stacked PR targeting `fix/sih-submission-reliability`** so PR #1's history is preserved.
3. Require GitHub Actions success and human review for both PRs.
4. Merge PR #1 only with owner approval, then retarget/merge the Milestone 0 PR with owner approval.
5. Rerun `npm ci`, typecheck, build, `npm run verify` and runtime audit on the resulting `main` commit.
   Record that exact SHA as the stable baseline. If the merge result differs, repeat migration and browser
   evidence rather than inheriting the candidate's verdict.

Until then the status remains **Baseline Candidate — Awaiting Merge**; publication and CI are also
pending for the local branch.

## Sprint 1 — Related-case matching accuracy and evidence quality (highest priority)

**Why first:** security and data-correctness regressions pass on the candidate, while the frozen synthetic
set has a measured related-case false negative. Matching affects officer review quality but must never
become automatic adjudication.

**One feature area:** deterministic related/duplicate candidate generation and its evidence presentation.

- Add adversarial synthetic families for paraphrase, synonyms, dates, reference formats and institution
  aliases; retain tune/held-out separation and fixture fingerprints.
- Improve related-case recall while preserving duplicate precision, exact-ID overlap behavior and the
  cross-institution identical-wording negative control.
- Keep every score/reason explainable and every relationship decision human-confirmed; do not merge cases.
- Evaluate privacy masking and versioned decision/revocation behavior with every rule change.
- Publish per-class precision/recall, confusion counts and regressions separately for tune and held-out sets.

**Exit evidence:** no loss of held-out precision or negative controls, improved related recall, full
`npm run verify`, and no real-world accuracy claim from synthetic metrics. Semantic ranking is a separate
approved decision, not a hidden part of this sprint.

## Sprint 2 — Complaint intake and lifecycle reliability

**One feature area:** manual case intake and ownership/state transitions.

- Review validation/error recovery, assignment queues, triage resolution and transfer edge cases.
- Make reviewed-alias insertion plus its audit record atomic.
- Add any missing browser coverage for alias creation and print output; preserve the existing state machine.
- Load-test concentrated queues only after correctness regressions are in place.

**Exit evidence:** reproducible API + Playwright coverage for every changed path, stale/unauthorized/failure
cases, unchanged report reconciliation and zero required skips.

## Sprint 3 — Evidence handling and recovery

**One feature area:** private attachment lifecycle.

- Add process-kill/restart fixtures around staging, rename, ready marking and deletion.
- Define and test retention/deletion behavior and filesystem permission requirements.
- Integrate an approved malware-scanning boundary with fail-closed/quarantine behavior before real evidence.
- Document and rehearse matched database + upload-directory restoration on the target platform.

**Exit evidence:** no phantom or missing ready evidence after interruption, access-control regression suite,
hash/restore evidence and an approved real-data scanning/retention design.

## Sprint 4 — Dashboard and reporting quality

**One feature area:** My Work and report definitions/performance.

- Reconcile every count with its drill-down after the preceding workflow changes.
- Rerun isolated 10,000-case synthetic benchmarks, including concentrated histories and mixed traffic.
- Improve queue/report clarity and error/empty states without introducing official SLA claims.
- Consider additional export formats only through a separate approved requirement.

**Exit evidence:** definitions remain consistent, scope/export privacy holds, measured targets and hardware
are recorded, and no benchmark overwrites committed evidence.

## Sprint 5 — UX simplification and accessibility

**One feature area:** officer task flow across desktop and mobile.

- Simplify high-frequency intake, review and coordination tasks based on observed synthetic-user flows.
- Conduct keyboard, focus, screen-reader, contrast, zoom, mobile and print checks.
- Preserve permission states, restricted-content presentation and stale-edit recovery.

**Exit evidence:** Playwright runtime checks plus an explicit accessibility review; no visual redesign is
used as a reason to weaken error or security states.

## Sprint 6 — Deployment and operability

**One feature area:** approved deployment topology and operations.

- Integrate sponsor SSO/OIDC and account/region provisioning.
- Choose persistence/worker topology deliberately; implement shared login limiting and job claiming if
  multiple instances are required. Do not simply activate replicas against the current SQLite design.
- Add TLS/proxy validation, persistent evidence storage, secrets management, monitoring and incident ownership.
- Complete data residency, retention, malware scanning and populated backup/migration/rollback drills.

**Exit evidence:** deployment-specific security and recovery approval. Only after these gates should the
owner consider real complaint data; a green synthetic prototype alone is not approval.

## Standing release requirements for every sprint

- Use Node 22 and `npm ci`; never rewrite the lockfile through an unreviewed forced audit fix.
- Use new synthetic databases and preserve operational data.
- Add a regression for every confirmed defect and make the smallest safe change.
- Run typecheck, production build, the complete verification gate and runtime audit.
- Treat failed, blocked or unexpectedly skipped required checks as release failures.
- Record branch, exact SHA, environment, logs, limitations and rollback steps.
- Do not merge, tag or release without explicit owner approval.
