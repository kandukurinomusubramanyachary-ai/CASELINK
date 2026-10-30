# M2 → M3 → M4 browser evidence

Captured by `test/m2-m3-m4-integration.mjs` against real Express/SQLite and disposable synthetic complaints. These are automated browser results, not human acceptance.

| Screenshot | Verified step |
| --- | --- |
| [01 — M2 ranked candidate](01-m2-ranked-candidate.png) | Search/category filtering and independent candidate |
| [02 — Match explanation](02-m2-explanation.png) | Stored matching factors |
| [03 — Durable handoff](03-m2-durable-handoff.png) | Actual submission, no relationship or original-case mutation |
| [04 — M3 comparison](04-m3-originals-and-evidence.png) | Both original complaints and protected evidence |
| [05 — Evidence request](05-m3-evidence-request.png) | Awaiting evidence and owning-lead delivery |
| [06 — Accepted review](06-m3-accepted.png) | Accepted M3 review before M4 |
| [07 — Persisted draft](07-m4-persisted-draft.png) | Draft survives refresh with no relationship |
| [08 — Confirmed decision](08-m4-confirmed.png) | Persisted Related decision and audit |
| [08b — M2 authoritative state](08b-m2-confirmed-backend-state.png) | M2 reflects the confirmed M4 backend state |
| [09 — Reversal and audit](09-m4-reversed-audit.png) | Earlier decision/audit and original histories preserved |
| [Tablet M2](10-tablet-m2.png), [M3](10-tablet-m3.png), [M4](10-tablet-m4.png) | 820×1180 real routes; no horizontal overflow |
| [Mobile M2](10-mobile-m2.png), [M3](10-mobile-m3.png), [M4](10-mobile-m4.png) | 390×844 real routes; no horizontal overflow |
| [11 — Network failure](11-network-error.png) | Explicit error followed by recovery against the actual backend |

The journey also verifies loading state, authorized evidence opening, unauthorized direct routes, two process restarts, database integrity, and original complaint preservation. Screenshots contain fictional people and institutions only.
