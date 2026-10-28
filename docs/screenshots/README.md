# Screenshots

Captured by `npm run test:ui` (Playwright, Chromium, 1440×950 unless noted) against the seeded demo
database. All content is synthetic.

| File | Screen |
| --- | --- |
| `00-direct-entry.png` | Demo mode only (`CASELINK_DEMO=true`): My work opens directly, with the demo account switcher in the header. The default configuration shows the sign-in screen instead |
| `18-login-page.png` | Demo-mode sign-in page (captured earlier): password form, synthetic account list and the direct-entry shortcut. In the default configuration the page shows the form only — no accounts, no password hint, no shortcut |
| `01-my-work.png` | My work as a PGRC bureau lead: queues, priority reasons, overdue list |
| `02-institutions.png` | Institution directory with visible case counts and coordination signal |
| `03-institution-profile.png` | Canonical ID, reviewed aliases, cross-bureau case history |
| `04-coordination.png` | Coordination review: one alert per institution, permitted case metadata, candidate evidence |
| `05-relationship-review.png` | Side-by-side candidate comparison, rule evidence, reviewer decision form |
| `06-cases.png` | Filtered case list (filters persisted in the URL) |
| `07-case-workspace.png` | Case workspace: owner/status/next action above the timeline |
| `07b-action-saved.png` | After saving an action: toast, server-stamped event, version 1 → 2 |
| `08-reports.png` | Reports: consistent definitions, totals, ageing |
| `09-alerts.png` | Persisted notifications with acknowledge |
| `10-import.png` | CSV import preview with accepted / rejected / skipped rows |
| `11-settings.png` | Runtime, scheduler, matching mode, DEMO deadline policies, accounts |
| `12-coordination-supervisor.png` | Supervisor view across bureaus |
| `12b-supervisor-review.png` | Supervisor relationship review |
| `13-mobile-my-work.png` | 430 px wide: My work |
| `13b-mobile-cases.png` | 430 px wide: Cases and filters |
| `14-narrow-desktop.png` | 900 px wide layout |
| `15-restricted-case.png` | PGRC officer opening an RB case: coordination metadata only |
| `16-reviewer-scope.png` | Read-only reviewer with no grants: empty, explained state |
