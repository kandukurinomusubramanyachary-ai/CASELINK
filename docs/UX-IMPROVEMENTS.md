# Requested UX improvements

The pasted request names KAVACH. The user clarified that the requested UX capabilities should be added to the existing CaseLink app; no KAVACH screens, receiver, signing workflow or satellite integration are introduced.

| Request | CaseLink implementation |
| --- | --- |
| Theme control | Dark/light/system choices without reload, locally remembered explicit choices, OS changes followed in System mode, pre-paint initialization. Dark is the fallback when a system preference cannot be read; respecting a readable OS light preference takes precedence over that fallback. |
| Privacy and cookies | Source audit found a sign-in cookie, essential sign-in/filter state, opt-in synthetic demo account state and a local theme preference. No optional analytics, advertising, external fonts or tracking scripts were found. Help explains the actual storage; there is no fictitious consent banner. |
| Useful search | Authenticated search covers case references, institution names, permitted complaint/source-reference text, authorized history/event IDs, actor names, action types, decision remarks and help topics. Paired history requires content access to both cases. Search has cancellation, loading, retry, empty results, keyboard selection and Ctrl/Command+K. |
| Back to top | Appears for long page or table scrolling, resets the active workspace, supports keyboard and reduced motion, and avoids toast overlap. |
| Responsive navigation | Existing efficient desktop rail and mobile modal drawer retained; theme and help are available inside the drawer. |
| Loading | Real export, download, refresh, search, save and upload operations display pending states. No artificial progress percentages or stage timers. |
| Interactive states | Theme-aware focus, hover, pressed, selected, disabled and pending states; form errors are associated with fields. |
| Reading progress | Not added: current screens are operational views and compact help disclosures, not long-form reading content. |
| Copy controls | Authorized case/event IDs, event JSON and full uploaded-file hashes. Clipboard success follows a completed write; denial/unavailability shows an error. Sign-in tokens and credentials have no copy controls. |
| Printing | Dedicated read-only case evidence with projected history and hashes; report printing with active filters and server snapshot context. Navigation, editable forms, floating controls and technical clipping are removed from print output. |
| Sticky context | A single compact application header plus table headers in bounded table scroll containers. Phone case rows retain field labels. |
| Skip navigation | First-focus skip link reaches main content; sign-in has its own skip-to-form link. |
| Password visibility | Existing sign-in password is hidden initially, explicitly toggled with accessible labeling, and hidden again on submission. No additional password fields or logging. |
| Campaign parameters | Not applicable to this operational prototype. No UTM collection or analytics is introduced; existing application routing is preserved. |
| Success feedback | Saved actions, prepared exports/downloads and completed clipboard operations report their actual UI result. No cybersecurity ACCEPTED claims are invented. |
| Validation and errors | Existing server validation is retained. Requests handle connection failure, timeout and unexpected non-JSON responses; exports and clipboard failures remain recoverable. Form state and search queries are preserved. |
| Confirmations | A dirty registration form asks before discarding. Keeping edits preserves the form. Discarding an unsaved form is explicitly distinguished from deleting case history. Ordinary saves are not blocked. |
| Freshness | Server snapshots, actual case fetch time, saved action times and receipt/update timestamps remain separately labeled in IST. No fake build date. |
| Help | Compact disclosures explain actual CaseLink roles, authorization, overlaps, triage, transfers, DEMO deadlines, audit limitations, evidence hashes, privacy, shortcuts and theme choices. |
| Support access | Real help dialogs are reachable from the header, navigation drawer, settings and sign-in footer. No fake support address or unnecessary floating support widget. |

## Verification

`test/search-access.mjs` uses a newly seeded isolated database and explicitly tests private and paired-case search boundaries. `test/design-polish.mjs` covers responsive layout and draft confirmation. Theme, search, clipboard, network-error and print checks are exercised against the running local app. Neither the tests nor the feature work reseed the user's working database.
