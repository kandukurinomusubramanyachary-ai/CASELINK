# CaseLink visual system

The user-supplied Wise design brief is the visual authority for this restyle. CaseLink remains an institution complaint coordination application; its workflows, account scopes, and synthetic-data notices remain product requirements.

The later UX request adds a Linear-inspired dark appearance and an accessible light theme. The existing lime action accent and component geometry are retained. Dark uses near-black neutral surfaces, subtle borders and separately tuned status colors. A system preference is honored until an explicit local choice is saved; dark is the fallback when system preference is unavailable. Theme initialization runs before the application styles paint, and theme changes do not reload the page. Both screen and print colors are tested independently.

## Palette

- Page canvas: sage `#e8ebe6`; cards and navigation: white `#ffffff`.
- Primary action and current navigation: lime `#9fe870`, hover `#cdffad`, pressed `#c5edab`, with deep ink `#163300` text.
- Main ink: `#0e0f0c`; body: `#454745`; accessible secondary copy: `#61665d`.
- Positive: deep green on pale green. Warning: dark brown on pale yellow. Negative: deep red on pale red. Labels communicate status alongside color.
- Existing blue, violet, and indigo component tone names map to neutral surfaces, introducing no additional brand accents.

## Typography

Inter is self-hosted from Google Fonts, with its OFL license in `web/public/fonts/`. It is the brief's permitted open-source substitute for proprietary Wise Sans. Display headings use weight 900; interface headings and controls use 600; body copy uses 400. The sign-in hero uses 64–96px on larger screens and 40–48px on mobile. Product page titles use a stable 36px desktop and 32px mobile scale. Tables retain a compact scale and tabular numerals. Inter is an intentional user-brief exception to generic font warnings.

## Geometry and layout

Cards and buttons use the specified 24px radius. Inputs use 12px. Primary buttons are at least 48px tall. Surfaces use contrast instead of shadows; shadows are reserved for overlays. A consistent authored line-icon set accompanies navigation and core actions.

The sign-in screen translates the split sage hero and white interactive card into CaseLink's sign-in flow. The authenticated application uses a white navigation rail and header against a sage workspace. Below 1024px, a compact header opens navigation in a modal drawer. Below 768px, forms and split panels stack; case tables become labeled records with every field retained. Other wide data tables scroll inside their cards. Dashboard work queues share a compact white surface with internal dividers. Case search is immediately available; additional filters expand on demand and retain their URL state.

## Interaction and accessibility

Native modal dialogs make the background inert, lock scrolling, preserve focus while typing, wrap Tab and Shift+Tab, close on Escape, and restore the trigger's focus. Notification panels close on Escape or an outside click. Pointer presses use subtle feedback; keyboard-triggered dialogs open immediately. Optional dialog entry motion lasts 180ms and respects reduced-motion preferences. A skip link reaches the main content. Controls retain visible focus rings.

Standard interface icons use Phosphor React with direct per-icon imports. The existing CaseLink logo remains unchanged. The implementation follows Impeccable's scoped polish workflow, Leon's preserve-and-audit guidance, and Emil Kowalski's interaction principles. Marketing-only layout directives do not override the requirements of an officer workspace.

## Implementation

`web/src/styles.css` owns tokens and shared components. `web/src/components/Icon.tsx` owns icon mappings and the CaseLink wordmark. `web/src/ui.tsx` owns native dialogs. `web/src/screens/Login.tsx` carries the split sign-in composition. Existing routes and service authorization remain intact. `test/design-polish.mjs` covers responsive layouts, filter persistence, and modal/drawer keyboard behavior.

`web/src/theme.tsx` owns appearance preferences. Search, help and back-to-top are shared components. `docs/UX-IMPROVEMENTS.md` records the 20 requested capabilities and applicability decisions; no optional analytics or fictitious cookie consent is introduced.
