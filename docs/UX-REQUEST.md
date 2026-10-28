Linear-inspired dark mode should be the default.
Add a functional theme control that supports an accessible light theme.
Requirements:
- Theme switch without page reload
- Persistent user preference where appropriate
- Respect system preference for users without an explicit choice
- No unreadable text or broken status colors
- No flash of incorrect theme where reasonably avoidable
Expected: both themes work across all three screens and all dialogs.
First inspect whether KAVACH uses optional cookies, analytics or browser tracking requiring consent.
If applicable:
- Show a concise cookie consent banner
- Explain optional storage and tracking
- Offer meaningful accept/reject controls
- Honor choices before optional tracking begins
- Allow preference changes
If no consent-requiring tracking exists, do not add a fake cookie banner.
Expected: lawful, truthful privacy UX rather than a decorative consent popup.
Provide useful search functionality across relevant in-app content.
Prioritize:
- Audit records
- Message IDs
- Sender identities
- Rejection reasons
- Scenario names
- Available help documentation
Do not build a nonfunctional search bar.
Expected: searches produce real, relevant results, handle empty matches and support keyboard interaction.
Add a discreet back-to-top control on long pages.
Requirements:
- Only appear when useful
- Keyboard accessible
- No obstruction of primary content
- Respect reduced-motion preferences
- Smooth scrolling where permitted
Expected: returns the user to the top of the active page.
Build proper responsive navigation.
Requirements:
- Desktop navigation remains efficient
- Collapsible mobile menu
- Keyboard and touch support
- Clearly visible active destination
- Accessible open/close behavior
- No horizontal overflow
Expected: Mission Console, Scenario Lab and Audit & Evidence remain usable on mobile.
Implement purposeful loading states for actual asynchronous operations.
Examples:
- Connecting to Python receiver
- Generating a signed fixture
- Submitting a message
- Running security scenarios
- Fetching audit records
- Export preparation
Use subtle progress indicators, skeletons or spinners according to the operation.
Never fabricate processing progress or stage timing.
Expected: users understand which action is pending and whether it succeeded or failed.
Create consistent interactive states for:
- Buttons
- Navigation
- Scenario cards
- Audit rows
- Dropdown items
- Expandable panels
- Copy controls
Include visible keyboard focus and disabled states.
Expected: all interactive elements provide clear feedback.
Add a minimal reading-progress indicator only on genuinely long, scroll-based informational content where it improves orientation.
Do not add meaningless progress bars to compact operational dashboards.
Expected: if used, the indicator accurately reflects the scroll position of the relevant container.
Provide functional copy controls for appropriate technical information:
- JSON messages
- Message IDs
- Session IDs
- Event IDs
- Input hashes
- Rejection codes
- Exportable evidence excerpts
Requirements:
- Clipboard action
- Brief success feedback
- Failure handling
- Accessible labels
- Never copy or expose signing secrets
Expected: copied values match the displayed or authorized source values exactly.
Create dedicated print styling for useful evidence views.
Support printing:
- Individual security decisions
- Validation traces
- Relevant audit evidence
- Protected-state comparisons
- Security test reports
Hide unnecessary navigation, floating controls and decorative UI.
Expected: readable print output without clipped technical data.
Implement useful sticky navigation or table headers.
Requirements:
- Maintain context while scrolling
- Avoid covering important content
- Respect small screens
- Prevent excessive stacking of sticky elements
Expected: users retain navigation and table-column context without losing workspace space.
Add a keyboard-accessible skip-navigation link.
Requirements:
- First relevant keyboard navigation action
- Visible when focused
- Correctly targets the main page content
- Works across all screens
Expected: keyboard users can bypass repeated navigation.
If KAVACH includes or later introduces a real password input, provide a proper show/hide control.
Requirements:
- Default hidden
- Accessible labeling
- No password logging
- No accidental exposure in screenshots or analytics
Do not add a password field merely to demonstrate this feature.
Expected: working password visibility control wherever password inputs actually exist.
Support safe handling of optional incoming campaign parameters where relevant to the project.
Requirements:
- Parse supported UTM parameters correctly
- Do not interfere with application routes
- Avoid exposing sensitive data in URLs
- Do not silently introduce external analytics
- Respect applicable privacy choices
If KAVACH has no marketing acquisition flow, keep this feature out of the operational interface and document it as deferred or not applicable.
Expected: no unnecessary tracking or privacy regression.
Implement explicit success feedback for relevant user actions.
Examples:
- Valid fixture created
- Evidence exported
- Settings saved
- Search/filter configuration applied when useful
Important: distinguish UI action success from cybersecurity command ACCEPTED.
Expected: clear, accurate feedback based on actual operation results.
Implement robust validation and error handling for:
- Invalid form entries
- Invalid JSON
- Network failures
- Backend unavailability
- Failed exports
- Unexpected responses
Requirements:
- Inline contextual errors
- Recoverable retry behavior
- Preserve unsaved user input
- No false success feedback
Expected: users understand the problem and can recover.
Use confirmation dialogs for meaningful destructive or irreversible actions, if such actions exist.
Examples:
- Discarding unsaved message edits
- Removing user-created drafts, if supported
- Resetting disposable local UI state
Do not block routine security message submissions with unnecessary confirmation dialogs.
Do not describe creating a new isolated session as deleting history.
Expected: confirmations prevent real accidental loss without disrupting normal workflows.
Display meaningful freshness information where appropriate.
Examples:
- Last audit refresh
- Last received message
- Latest scenario execution
- Last build/release update if known
Distinguish these different timestamps.
Never invent timestamps or use the current date as a fake build date.
Expected: accurate time labels with appropriate local-time formatting.
Provide a compact, accessible help section explaining KAVACH terminology.
Topics can include:
- What is HMAC?
- What is message tampering?
- What is a replay attack?
- Why do messages expire?
- Authentication versus authorization
- Why is protected state important?
- Is this connected to a real satellite?
- Are local audit records tamper-proof?
Use correct, concise explanations.
Expected: users and judges can understand the simulator without reading source code.
Only add a floating Help/Support control if it serves a genuine user need and has a real destination.
Prefer:
- Existing help modal
- Project documentation
- Verified issue-reporting link
Requirements:
- Nonintrusive placement
- Mobile safe-area support
- Accessible label
- No overlap with message submit buttons
- No invented email address or support service
Expected: useful access to assistance without dashboard clutter.