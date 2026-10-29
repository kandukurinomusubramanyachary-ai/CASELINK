# CaseLink — Milestone 0 stable baseline

**Status: Baseline Candidate — Awaiting Merge.**

**Additional release gates:** publication and GitHub Actions are also pending for the local Milestone 0 branch.

**Verification date:** 30 October 2026 (Asia/Kolkata).

**Baseline candidate code/test commit:** `56113283e66fb656635adb34b2eed32e7e7369b6`.

This is not a declaration that `main` is stable or production-ready. PR #1 is still open, the Milestone 0
branch is local to this workspace, and GitHub credentials were unavailable for publishing it. The exact
final documentation-commit SHA and its rerun are recorded in the Milestone 0 final report and external
verification manifest.

## 1. Repository and release state

| Item | Inspected state |
| --- | --- |
| Default branch | `main` at `2dca0383964d5f52ec63f224e0e35e193becb83a` |
| PR #1 | **Open**, non-draft, mergeable/clean at inspection; `fix/sih-submission-reliability` → `main`; one commit, 25 changed files |
| PR #1 head | `1348aead3fd19ff1d93077ea99fe7506d190ef69` |
| Existing PR #1 Actions | `Submission verification / verify`: completed **success**, run `40828507244`, job `123297013757` |
| Privacy follow-up | `fix/privacy-consistency-followup` points to the same `1348aea…` commit; `main..that-branch` has no unique work |
| Milestone 0 work | Local branch `milestone0/stable-baseline`, based on `1348aea…`; no shared branch was force-pushed or rewritten |
| Milestone 0 code/test change | `56113283e66fb656635adb34b2eed32e7e7369b6` — release-gate and migration-test repairs only |
| Reviews | No human PR reviews and no inline review comments. One CodeRabbit bot comment contains unchecked trigger/autofix items, not a completed code review |
| Publication | `git push -u origin milestone0/stable-baseline` was refused because no GitHub username/credential is available |
| Merge state | Nothing was merged. `main`, PR #1 and both existing hardening branches were not modified |

PR #1 contains the submission hardening described in `docs/SUBMISSION-HARDENING.md`; those changes are
**implemented but unmerged**. A01–A07/A12 implementations already exist in the inspected `main` ancestry,
while PR #1 adds the later startup, migration, import identity, worker recovery, legacy-privacy,
relationship-version projection and request-security fixes. Verification in this document applies to the
Milestone 0 candidate, not automatically to `main`.

## 2. Architecture summary

- **Frontend:** React 18 + TypeScript, Vite production build, hash-routed screens, no runtime CDN assets.
- **Backend:** Express 4 + TypeScript executed with Node's `--import tsx` loader. Server-side sessions use
  hashed random tokens, scrypt password hashes, an HttpOnly Secure SameSite=Lax cookie and a Bearer fallback.
- **Authorisation:** role + bureau + region + explicit case grants, re-evaluated on each request and applied
  to metadata, contents, writes, search, exports, notifications and evidence.
- **Database:** SQLite through `better-sqlite3`, WAL mode and `PRAGMA foreign_keys=ON`. Numbered additive
  migrations run before serving. The current schema version is **8**.
- **Consistency:** synchronous SQL transactions couple case mutations, action events and queued work;
  optimistic case versions and scoped idempotency records protect retries and stale writes.
- **Background work:** an in-process worker drains overlap/suggestion jobs and scans deadline/escalation
  notifications. Failed work has durable retry/failure state.
- **Evidence:** PDF/PNG/JPEG bytes are staged outside the web root, identified by SHA-256 and published with
  a `publishing` → `ready` protocol plus startup reconciliation.
- **External systems:** none. Institutions, people and complaints are synthetic. There is no live AICTE
  connector, sponsor SSO/OIDC, email delivery or automatic adjudication.

## 3. Verified runtime and dependencies

| Component | Version / environment |
| --- | --- |
| Node | `v22.23.4` (`.nvmrc` requires 22; `package.json` requires `22.x`) |
| npm | `10.9.9` |
| OS used for this run | Debian GNU/Linux 13, x86_64 |
| Git | `2.47.3` |
| TypeScript | `5.9.3` |
| React | `18.3.1` |
| Vite | `5.4.21` |
| Express | `4.22.3` |
| better-sqlite3 / SQLite | `11.10.0` / `3.49.2` |
| Zod | `4.6.7` |
| Playwright / Chromium | `1.48.0` / build `1140` (`130.0.6723.31`) |

Dependencies were installed from `package-lock.json` with `npm ci`. Runtime-only audit: **0 vulnerabilities**.
The full development audit reports **2 high and 1 moderate** advisories in the Vite/esbuild/Playwright
development toolchain. These are not concealed and are not part of the runtime-only result; upgrade the
development toolchain as a separately tested maintenance task rather than an unreviewed `npm audit fix --force`.

## 4. Configuration and safe initialization

### Runtime configuration

| Variable | Requirement |
| --- | --- |
| `CASELINK_DATA_DIR` | Strongly recommended. Contains `caselink.db`, SQLite sidecars and private `uploads/`. Defaults to repository `data/`. Use a dedicated persistent directory outside the web root. |
| `PORT` | HTTP port; defaults to `8080`. Server binds `0.0.0.0`. |
| `CASELINK_DEMO` | Defaults to `false`. `true` enables fixture entry and permits fixture seeding. Never enable for real data. |
| `CASELINK_TEST_HOOKS` | Defaults to `false`. Enables administrator-only fault injection for synthetic tests; never enable in deployment. |
| `CASELINK_ADMIN_USERNAME` | Bootstrap only: 3–60 letters/digits/`._-`; required for first administrator. |
| `CASELINK_ADMIN_PASSWORD` | Bootstrap only: unique operator-supplied 16–256 character secret. Do not reuse the published fixture password. |
| `CASELINK_ADMIN_NAME` | Optional bootstrap display name, maximum 120 characters. |

`CASELINK_DB`, `BASE`, `CASELINK_SCREENSHOT_DIR` and `CASELINK_ACCEPTANCE_RESULTS` are test-reader/output
settings, not alternative production database configuration. Environment variables must be supplied by the
process supervisor; secrets are not committed. Secure cookies require HTTPS in a real deployment. A reverse
proxy must preserve the public `Host`; the current same-origin and login-limit controls are single-instance.

### Empty, non-demo initialization

1. Use Node 22 and run `npm ci` and `npm run setup`. Setup builds and exits without seeding or serving.
2. Point `CASELINK_DATA_DIR` at a new, access-controlled directory.
3. Set the three bootstrap variables and run `npm run bootstrap:admin`.
4. Start with `CASELINK_DEMO=false npm run serve` (or `bash start.sh`).

Verified result: normal empty startup creates **zero users and zero cases**. Bootstrap refuses the published
fixture password, creates one unique administrator when given a valid test-only secret, and refuses a second
bootstrap when any account exists. It creates no demo institutions, complaints or deadline policies.

### Synthetic demo initialization

Use a disposable directory only. `npm run seed` invokes `seed.ts --force` and **resets its target data**.

```bash
export CASELINK_DATA_DIR=/tmp/caselink-synthetic
npm run seed
CASELINK_DEMO=false npm run serve   # sign-in-only synthetic instance
# Or, for automatic fixture entry:
CASELINK_DEMO=true npm run serve
```

Never run the seed command against an operational directory. Turning demo mode off later does not rotate
passwords already created in a seeded database; use a fresh directory before real-data onboarding.

## 5. Database migration, backup and recovery

### Initialization and ordering

On process or migration-CLI startup, `server/src/db.ts` opens the configured SQLite database, enables WAL and
foreign keys, executes idempotent fresh-schema statements, then applies unapplied migrations in numeric
order. Each migration and its `schema_migrations` row commit in one transaction. The CLI is repeatable:

```bash
CASELINK_DATA_DIR=/path/to/data node --import tsx server/src/migrate.ts
```

The operator output lists the prior version, applied versions and unresolved legacy records. Migration 8
normalizes import identity to `source system | bureau | source reference`; legacy collisions preserve every
case, reserve one canonical identity and flag ambiguous extras in `migration_notes` for manual reconciliation.

### Required populated-database procedure

1. **Obtain owner approval and stop all application/worker processes.** Do not migrate live data from Milestone 0 tests.
2. Verify free space and filesystem permissions. Record the application SHA and schema version.
3. Create a new consistent SQLite backup using the `better-sqlite3` backup API; this includes WAL content.
   The destination must be a new file. Also copy `uploads/` and record checksums.

```bash
export CASELINK_SOURCE_DB=/path/to/data/caselink.db
export CASELINK_BACKUP=/path/to/new-backup/caselink-backup.db
node --input-type=module -e "import Database from 'better-sqlite3'; const db=new Database(process.env.CASELINK_SOURCE_DB,{readonly:true}); await db.backup(process.env.CASELINK_BACKUP); db.close();"
```

4. Restore into a separate directory and verify row counts, `PRAGMA integrity_check`,
   `PRAGMA foreign_key_check`, and evidence hashes before touching the original. A synthetic restore test
   preserved 74 cases, 173 events, two attachment rows/files and all job/migration rows, with integrity `ok`
   and zero foreign-key violations.
5. Only after the restore verifies, run the migration CLI against the approved data directory. Review every
   `migration_notes` entry. Do not invent unresolved provenance or disposition outcomes.
6. Start the application, run smoke checks, and retain the backup until the release is accepted.

### Rollback

There is no automatic down-migration. To roll back, stop the application, deploy the previous approved
application commit, restore the matching verified database backup **and its matching `uploads/` directory**
into a separate recovery location, repeat integrity/hash checks, then switch the service to that restored
set. Never overwrite the only copy of a database, and never use `npm run seed` as a recovery operation.

## 6. Exact verification commands

Run from a clean checkout of the candidate under Node 22:

```bash
npm ci
npx playwright install --with-deps chromium
npm run typecheck
npm run build
npm run verify
npm audit --omit=dev --audit-level=high
```

`npm run verify` repeats typecheck/build and then runs all required API and browser suites. Each API suite
gets a new explicitly seeded synthetic directory under ignored `.runtime/verification-*`; test databases,
logs and screenshots do not overwrite checked-in evidence. Nonzero exits and explicit, TAP, summary-only or
disguised required-check skips fail the gate. Skipped CSV **rows** are business outcomes and are not confused
with skipped tests.

On this Debian 13 host, Playwright 1.48's automatic `--with-deps` path requested obsolete font packages.
The browser was installed separately and the listed Chromium libraries were installed with apt; a real
headless Chromium launch then passed. This was an environment correction, not a test bypass.

Supplementary checks executed against additional disposable synthetic instances:

- Reviewed-alias create/read/resolve, invalid input, officer denial and cross-region denial.
- A pre-M3 copy upgraded through migrations 1–8 with the source SHA-256 unchanged.
- SQLite backup/restore with database integrity and evidence-file hash verification.

## 7. Independent results for commit `56113283…`

| Check | Result |
| --- | --- |
| TypeScript / production build | PASS / PASS |
| Release commands | **36/36 passed; 0 failed; 0 required skipped** |
| Counted assertions across suites with explicit counters | **501 passed; 0 failed; 0 skipped** |
| Reliability/security startup and worker groups | 12/12 |
| Search access / M1 / regional M1.1 / relationship privacy M2 | 13/13 · 65/65 · 59/59 · 40/40 |
| Lifecycle / concurrency / import | 79/79 · 38/38 · 41/41 |
| Full pre-M3 → v8 migration | 17/17; migrations 1–8 applied; 80 cases and 170 events preserved; second run a no-op |
| A01–A13 audit counterexamples | 34/34 |
| API acceptance | 21/21 |
| Browser sign-in / UI acceptance | 14/14 · 13/13 |
| Browser smoke | 19 desktop, mobile and narrow-layout captures; 0 console errors; action save succeeded |
| Refresh / keyboard-mobile UX | 19/19 · 15/15 |
| Demo mode / direct entry | 8/8 · 13/13 |
| Matching evaluation | PASS on fixture integrity and controls; 60 complaints, 120 labelled pairs; one related pair missed |
| Runtime dependency audit | **0 vulnerabilities** |
| Backup/restore | PASS; counts, integrity, foreign keys and evidence hashes preserved |

Primary evidence for this commit is held outside committed project files at
`/home/user/caselink-verification/artifacts/code-commit-verification/` and
`/home/user/caselink-verification/logs/`. The runner's native output was
`.runtime/verification-YARfwn`. GitHub Actions independently passed on the parent `1348aea…`; no Actions
result is claimed for `56113283…` because publication credentials are unavailable.

## 8. A01–A07 and A12 classification

All classifications below mean **Fixed and verified on the synthetic Milestone 0 candidate**. They are not
claims about a live deployment or an unverified `main` build.

| Finding | Status | Code and reproducible evidence |
| --- | --- | --- |
| A01 — transfer reasons exposed | **Fixed and verified** | `privacy.ts#projectTransfer` / `pendingTransfersFor`; `audit-m7` A01a–d: detail, My Work and notification projections deny out-of-scope/restricted reasons. |
| A02/A12 — relationship history and notification disclosure | **Fixed and verified** | `index.ts#historyFor` and paired search fail closed for unresolved legacy pairs; `privacy.ts#projectNotification` re-evaluates current access and uses safe structured facts. `audit-m7` A02a–c and A12a–b; reliability unpaired-history test. |
| A03 — completed case reactivated by unassignment | **Fixed and verified** | `service.ts#assignCase` returns 409 for disposed/closed unassignment and otherwise preserves lifecycle. `audit-m7` A03a–c includes protected reopening. |
| A04 — cross-region officer assignment | **Fixed and verified** | `validateCaseWorker` is called for intake and reassignment. `audit-m7` A04a–d verifies 422, no record change and a permitted owner picker. |
| A05 — inconsistent evidence publication | **Fixed and verified** | staged bytes, `publishing`/`ready` rows, compensation and startup reconciliation in `index.ts`; `audit-m7` A05a–c and `concurrency-m4` upload checks verify no phantom row/event/version/file and healthy download behavior. |
| A06 — idempotent replay disclosure | **Fixed and verified** | case-create replay re-authorizes current metadata and content access before returning stored content. `audit-m7` A06a–c verifies 403 and no private marker after scope loss. |
| A07 — missing evidence/relationship versions | **Fixed and verified** | upload requires the shown version; relationship decision/revoke call `requireBothVersions` and check both cases. `audit-m7` A07a–d, `security-m2`, concurrency stale-write checks and reliability relationship-revocation test. |

No A01–A07/A12 item remains classified as broken or incomplete in the tested candidate. Actual malicious
traffic, sponsor identity integration and production infrastructure were not available for testing.

## 9. Known limitations and accepted risks

- **Release gate:** the new local commits still require publication, a stacked PR, GitHub Actions, human
  review and approved merges. `main` must not yet be labelled stable.
- **Single-host design:** the worker lacks multi-instance claiming; login limiting is in-process; SQLite and
  local evidence storage require a single-writer deployment model. Do not run multiple active replicas.
- **Deployment not verified:** no hosted target, TLS proxy, sponsor SSO, live AICTE connector or real data was
  supplied. No production readiness claim is made.
- **Real-data gates remain:** approved hosting/data residency, retention/deletion, malware scanning,
  encryption/filesystem permissions, secrets management, monitoring/incident ownership and an operational
  backup/restore drill are required before onboarding real complaints.
- **Matching:** results are synthetic. One related pair is missed; lexical paraphrase limits remain. Semantic
  ranking and relationship graphs are out of current scope.
- **Notifications/reports:** delivery is in-app only; exports are CSV, not PDF/XLSX. Email and additional
  formats are future scope, not verified features.
- **Performance:** the earlier PR benchmark was inspected but not rerun in Milestone 0. No new deployed
  performance or concentrated-history claim is made.
- **Fault model:** tests use deterministic failure injection, reconciliation and process restart. They do not
  prove every power-loss, filesystem-failure or multi-writer scenario.
- **Development advisories:** the full audit's 2 high/1 moderate development-only advisories need a controlled
  toolchain upgrade. Runtime audit is separately clean.

## 10. Conditions before real-data deployment

Do not onboard real complaint data until all of the following are evidenced and approved:

1. The exact baseline is published, CI-green, reviewed and merged; the resulting `main` SHA passes the same gate.
2. Sponsor authentication, hosting/data residency, TLS/proxy behavior and role/region provisioning are approved.
3. Persistent single-writer storage, encrypted/access-controlled evidence, malware scanning and retention/deletion are implemented and tested.
4. A populated backup → migration → application rollback/restore drill passes on the deployment platform.
5. Operational monitoring, queue failure handling, incident ownership and shared login/session protections are ready for the intended topology.
6. Privacy, security and owner acceptance tests pass with approved synthetic fixtures in the target environment. Real data is not used for these tests.
