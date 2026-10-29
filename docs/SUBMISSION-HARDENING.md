# CaseLink SIH26264 submission hardening — 29 October 2026

Scope: reliability fixes to the existing prototype, based on `2dca0383964d5f52ec63f224e0e35e193becb83a`,
on branch `fix/sih-submission-reliability`. All development and verification ran remotely. No live
complaint data, deployment database, secret provider or local laptop was used. The React interface
and existing product flows are preserved.

## Findings and changes

| Priority | Confirmed problem | Change and evidence |
| --- | --- | --- |
| Critical | An empty normal boot created 13 accounts using the published demo password. | Startup seeds only with explicit `CASELINK_DEMO=true`. Normal boot creates zero users/cases. `bootstrap:admin` requires unique operator-supplied credentials and an empty directory. Existing accounts are preserved. |
| High | Migration 6/7 warning inserts had five SQL parameters but four supplied values, preventing populated upgrades. | Both inserts now include timestamps. Populated relationship-history and interrupted-evidence fixtures migrate without losing case IDs or versions; a second migration is a no-op. |
| High | Import preview included source system in identity; the unique database index omitted it. | Migration 8 replaces the old index with uniqueness on `source_identity`. Two systems can import the same reference. Case/whitespace-normalized repeats remain duplicates. Legacy collisions preserve every record, reserve one canonical identity and flag ambiguous extras in `migration_notes`. |
| High | Matching jobs were marked done during an outage without running. | Paused matching jobs stay pending without consuming attempts. Queue selection excludes them while paused, so a backlog cannot starve overlap processing. Recovery processes the saved work. |
| Medium | Successful worker scans hid unresolved job failures. | Queue effects/completion are transactional; invalid jobs retry and eventually fail. Authenticated status reports pending/retrying/failed counts and oldest pending time. Errors remain observable after later scans and restarts, with raw error details withheld from API responses. |
| High | Unresolved legacy relationship history exposed private remarks in detail and search. | Unknown relationship pairs fail closed in both paths. Normal unpaired case events remain readable according to the existing content policy. |
| High | Cross-site browser writes, unbounded credentials and repeated password guessing lacked controls; malformed cookies could throw. | Same-host Origin/Fetch Metadata checks, `HttpOnly; Secure; SameSite=Lax` cookies, credential bounds and failed-login limits are enforced. Invalid cookie encodings are ignored. Bearer fallback remains supported. |
| High | JSON-parser error objects can include submitted complaint bodies in logs. | Malformed/oversized JSON gets safe 400/413 responses. Request bodies and arbitrary error objects are not logged. A sentinel test checks response and server output. |
| High | The runtime dependency audit reported a Zod memory-exhaustion advisory. | Zod upgraded from 3.25.76 to 4.6.7, with typechecking and workflow regressions. Runtime audit reports zero advisories. [Advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5). |
| Medium | Relationship projections omitted versions required by the interface's revoke request, causing 422 responses. | Visible relationship cases include their current versions. The browser revoke flow works; a stale decision still gets 409. A targeted regression failed before the fix and passed after it. |
| Medium | `setup` ignored its argument, started a service, seeded fixtures and hid failures. | Setup now builds and exits without seeding or serving; failures propagate. Startup scripts use Node's `--import tsx` loader. Node 22 is recorded in `.nvmrc` and package engines. |

## Remote capabilities

| Capability | Observed availability |
| --- | --- |
| Repository access | Connected GitHub read/write; branch creation confirmed. No open GitHub issues at inspection. |
| Coding and terminal | Remote Git 2.51.1, Node 22.23.4, npm 11.9.0, Python 3.12.14 and file editing. |
| Runtime dependencies | `npm ci` succeeds with Node 22; native SQLite loads and reports SQLite 3.49.2. |
| Static checks | TypeScript checking and Vite production build execute remotely. |
| API/database tests | Isolated synthetic databases, HTTP clients, migration fixtures, fault injection and process-restart checks. |
| Browser tests | Playwright 1.48 with installed headless Chromium; normal sign-in, Bearer fallback, reload, mutation, mobile and demo flows. |

The preinstalled Node 24 runtime could not install the pinned native SQLite dependency. Node 22
resolved that blocker. The standalone `tsx` CLI attempted a Unix IPC socket forbidden by this
workspace; the supported Node loader avoids that unnecessary IPC dependency. Neither required the
user's laptop or weaker sandbox permissions.

## Reproduction and verification

The original snapshot passed typechecking/build, but all seven initial regression groups failed.
They exposed the startup, populated migration, import identity, outage, privacy and session defects.
Additional regression groups cover setup, legacy identity collisions, paused-backlog starvation and
relationship revocation. Earlier test harness assumptions about transfer labels, legal lifecycle
progression, header keyboard controls and native dialog semantics were corrected without changing
the interface or weakening assertions.

Run under Node 22:

```bash
npm ci
npx playwright install --with-deps chromium
npm run verify
npm audit --omit=dev --audit-level=high
```

`verify` creates a fresh synthetic instance for each API suite. Required skipped checks fail the gate.
Logs, test databases and browser screenshots go under ignored `.runtime/verification-*`, rather than
overwriting checked-in acceptance results or screenshots. The workflow in
`.github/workflows/verify.yml` runs the same gate on pull requests with read-only repository permissions.

Final release gate: **36/36 commands passed, zero failed or skipped required checks**. This includes
21 verification steps and 15 isolated fixture setups. Test output is from the final working tree on
this branch; GitHub Actions provides an independent rerun after the pull request opens.

| Check | Result |
| --- | --- |
| TypeScript / production frontend build | PASS / PASS |
| New submission regressions | 11/11 groups |
| Search authorization | 13/13 |
| M1 access control / M1.1 regional access / M2 relationship privacy | 65/65 · 59/59 · 40/40 |
| M3 lifecycle / M4 concurrency / M5 import | 79/79 · 38/38 · 41/41 |
| Migration integrity and preservation | 17/17 |
| M7 audit counterexamples | 34/34 |
| API acceptance | 21/21 |
| Browser sign-in / interface acceptance | 14/14 · 13/13 |
| Browser smoke | PASS; zero console errors, desktop and mobile screens captured |
| Shared refresh / keyboard and mobile UX | 19/19 · 15/15 |
| Explicit demo mode / browser direct entry | 8/8 · 13/13 |
| Frozen synthetic matching evaluation | PASS: 60 complaints, 120 labelled pairs; integrity, exact-ID overlap and cross-institution negative control hold. One related pair is missed. |
| Runtime dependency audit | 0 advisories (`npm audit --omit=dev`) |
| Patch whitespace validation | PASS (`git diff --check`) |

No required test remains blocked by the remote environment. Deployment/integration checks not
executed are listed below. The benchmark harness now takes a consistent SQLite backup, including WAL
pages, and supports isolated source/data/report paths instead of overwriting repository evidence.

### Synthetic load benchmark

Executed after the release gate on this remote host: 10,000 cases, 100 institutions, 20 authenticated
sessions and 12 concurrent rounds. Ten sessions performed action writes; fixture permission refusals
in warm-up are excluded from measured samples. Every measured probe reports zero errors.

| Probe | Mixed-traffic p95 | Target |
| --- | ---: | ---: |
| Filtered case list | 385 ms | 1,500 ms |
| Case detail | 348 ms | 1,500 ms |
| Record an action | 19 ms | 2,000 ms |
| Report summary | 487 ms | 10,000 ms |
| Coordination list | 447 ms | Reference only |
| New overlap visible after intake | 365 ms total | 5,000 ms |

The benchmark exits successfully; single-session and read-only concurrency targets also pass. This
single-host synthetic result does not cover concentrated matching histories or deployed network
latency. It is not a measured before/after comparison with a benchmark run on another machine.

The exact run used a disposable seed source and isolated outputs:

```bash
CASELINK_DATA_DIR=.runtime/submission-benchmark-source npm run seed
CASELINK_SOURCE_DB=.runtime/submission-benchmark-source/caselink.db \
CASELINK_BENCH_DIR=.runtime/submission-benchmark \
CASELINK_BENCH_REPORT=.runtime/submission-benchmark/report.json \
BENCH_PORT=18129 npm run bench -- --reseed
```

## Upgrade and operational limits

- Back up a populated deployment before applying schema migration 8. No case, source reference or
  history row is deleted by that migration. Resolve any reported ambiguous legacy identities manually.
- Existing fixture accounts/passwords are intentionally preserved. Disabling demo mode on an already
  seeded database does not rotate those credentials. Use a separate data directory before any real-data
  onboarding; do not run the destructive `seed` command against an existing operational database.
- Matching still drains in the API process. Independent workers, queue coalescing and a new deployment
  performance target remain separate work. Jobs already incorrectly completed by an older build are
  not automatically inferred to be failures or rewritten by this patch.
- The limiter is per process and per connection address; multiple instances need shared limiting, and
  a reverse proxy must preserve the public Host. This prototype has no sponsor SSO integration.
- Evidence malware scanning/retention, consistent backup restoration, persistent deployment storage
  and multi-instance job claiming have not been completed by this PR. Production serving still needs
  the TypeScript loader dependency; an install with development dependencies omitted is insufficient.
- Hosted deployment, real AICTE integration, sponsor authentication and live complaint testing were not
  executed: no deployment target or integration credentials were supplied. Optional visual-polish,
  contrast and matching-tuning sweeps are outside this unchanged-interface reliability pass. Core
  browser smoke, keyboard/mobile UX and shared-refresh tests are part of `verify`.

This is a hardened synthetic submission prototype, not approval to onboard real complaint data.
