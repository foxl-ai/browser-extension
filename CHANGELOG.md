# Changelog

Notable changes to the Foxl browser extension.

This extension has its own version line, independent of the Foxl Desktop release
number. It used to ship inside the Foxl monorepo, where a script kept its manifest
version pinned to the app's unified line; the split makes the two independent.

## v0.9.1 - October 27, 2026

### Fixed

- A screenshot of a tab in a minimized window fails at once with "The tab's window is minimized", instead of waiting up to 20 seconds (0.8.1 did not answer at all). Chrome draws nothing in a minimized window, so there is nothing to capture until it is restored.
- When Chrome reports a tab with no size, a plain screenshot selects the tab for a moment and switches back, as 0.8.1 did, instead of failing with "clip must be a positive rectangle". Seen after a discarded tab reloaded in the background in an automated Chrome without a window size. A clip or full-page screenshot of such a tab says to take a plain screenshot first.

## v0.9.0 - October 26, 2026

### When this update arrives

- This version adds Chrome's `debugger` permission, which Chrome does not allow to be optional. Its new warning, "Access the page debugger backend", makes **Chrome turn Foxl off when it updates until you accept it**. Open Chrome's menu, choose "Foxl is disabled", and accept the new permissions, or switch Foxl back on in `chrome://extensions`. Until then Foxl Desktop reports the extension as not connected.
- To capture a tab in the background without selecting it, Foxl attaches Chrome's debugger to that tab for about half a second. While it does, Chrome shows a bar at the top of every tab in every window, "Foxl" started debugging this browser, with a Cancel button. The bar makes the page you are viewing shorter (57 CSS pixels on macOS) and closes 5 seconds after the last capture. Scrolling a background tab also draws it once this way.
- The tab you are looking at is captured the way 0.8.1 did, without the debugger and without the bar.
- Where Chrome refuses the debugger (DevTools turned off by an administrator, a page that contains another extension's frame, such as a password manager's) or does not draw a background tab (a PDF), a screenshot selects the tab for a moment and switches back, as in 0.8.1.
- Clicks, typing, keys, and hover still use page events. The `debugger` permission does not make them trusted input.

### Added

- Screenshots of a tab in the background, without selecting it. With a desktop that asks for them, a rectangle within the viewport or the full document. Results report the CSS rectangle and the PNG's pixel size.
- With a compatible desktop, page snapshots can return only changes since an explicitly supplied snapshot ID. Limits on text and lines report truncation; a different tab, document, filter, expired baseline, or missing baseline returns a full snapshot.
- Snapshots include the current value of text fields and the checked, disabled, expanded, and selected states. Password and hidden field values are never included, as a value or as a name.

### Fixed

- Scrolling no longer selects the tab and scrolls the full amount. 0.8.1's smooth scroll stopped when it switched back (834 of 1,200 pixels in a test page).
- An unlabelled password field is no longer named by its value in snapshots.
- Back-to-back screenshots of background tabs no longer fail with Chrome's limit of two captures per second.
- Screenshot requests on one tab run in order and detach the debugger when finished. Invalid crops and a page that navigates during capture are refused.
- Snapshot and page-access failures reach the desktop as failures.

## v0.8.1 - October 5, 2026

### Fixed

- **Clicking at a point no longer presses Foxl's own Stop button.** While the agent works,
  the page shows a "Stop Foxl" button at the bottom centre. A click at a point under it
  pressed that button and ended the run. Now the click goes to the page element under the
  button, and the answer says that Foxl's button was drawn there. A point where there is
  nothing but Foxl's own controls is refused.
- Hovering at a point skips Foxl's overlay the same way. A key press never goes to the Stop
  button, even when the button has focus.
- Screenshots no longer show Foxl's border and Stop button. They are hidden while the tab is
  captured and come back right after, so the agent is not shown a button to aim at. If the
  page is too busy to hide them in time, the screenshot is taken with them showing, and they
  are never left hidden: a hide that arrives late is refused, and a hide undoes itself after
  1.5 seconds.
- **A page cannot pass its own elements off as Foxl's.** Foxl tells its own border and Stop
  button apart from the page by remembering the elements it created, where the page cannot
  reach. An id or attribute a page copies from Foxl's overlay does not count. In 0.8.0 a page
  could give its own elements an id like Foxl's to keep them out of the page outline.

## v0.8.0 - October 5, 2026

### Added

- New actions for the agent: click at a point of the page, press a key (Enter, Escape,
  Tab, arrows, or a combination like Control+a), and hover over an element or a point.
  Pressing a key on an element focuses it first; it does not click it.

### Fixed

- **Typing is checked, and a failure is reported.** After typing, the extension reads the
  field back and says so when the text is not there. It used to answer "done" for every
  type, including into fields that ignored it. A field that formats what you type (a phone
  number shown as "(555) 123-4567") counts as holding it.
- **Typing into rich-text editors works.** Text goes in through the browser's own editing
  (`insertText`), which contenteditable editors accept. The old path set `.value`, which
  an editor does not have, so nothing was typed. Plain and React-controlled inputs already
  took the old path's text and still do.
- **Enter submits through the page's own submit handling.** It calls `requestSubmit()`,
  so the page's submit handler and the form's validation run. The old `form.submit()`
  skipped both and reloaded the page, so a React form's `onSubmit` never ran. The result
  now says whether a submit actually happened, or that the form is invalid, or that the
  page handled Enter itself.
- **Clicks, typing, key presses and hovers on a tab run one at a time**, the way one
  keyboard and mouse would. Foxl Desktop can send several at once, and they shared the
  page's focus, so a click could land between typing and its Enter and the Enter went to
  the wrong element. Enter after typing, and a key pressed on an element, now go to that
  element. A tab whose page stops answering (a button that opens a confirm dialog, a hung
  script) holds only its own actions, and for at most 25 seconds: an action that could not
  start in time, or that reaches the page after that, is refused with "nothing was done"
  instead of running later. Stop Foxl cancels the actions still waiting.
- **Clicks send the whole mouse sequence** (pointer and mouse over, down and up, then
  click), for sites that act on mousedown. An element with no box on the page (a hidden
  checkbox behind a styled label) is still clicked the way it was before.
- **Elements inside web components (open shadow roots) appear in the page outline** and
  can be clicked and typed into. Editors (contenteditable) are listed as text boxes.
- **Opening a page no longer waits 30 seconds** when the page finished loading before the
  extension started watching for it, which made fast pages time out in Foxl Desktop.
- Foxl's own "Stop Foxl" button no longer appears in the page outline.
- **The full page outline of a very large page is fast.** Each element's ref was found by
  scanning every ref so far, so a page with 18,000 controls took 21 seconds (37 seconds the
  second time, past Foxl Desktop's 30-second limit). It takes under 50 ms now.
- PRIVACY.md says when the activity border and the Stop Foxl button appear (only when
  Foxl Desktop signals a run), and the store listing and README say what `scripting` is
  used for (scrolling).

### Known limits

- Clicks, key presses and hovers are still page events, not your real mouse and
  keyboard. A key the browser itself acts on (Tab moving focus) does not happen, and a
  site that checks whether input came from a person ignores them.

## v0.7.1 - August 18, 2026

### Fixed

- **The "Get Foxl Desktop" button was invisible.** On the setup screen - the one
  every person who installs this from a store without the desktop app reaches - the
  primary call to action rendered white on white, a 130x33 button occupying space
  with nothing to see. `.setup-cta` set `background: currentColor` and then
  `color: canvas` on the same element, and `currentColor` in `background` resolves
  to that element's own `color`, so both computed to `rgb(255,255,255)`. It now uses
  `var(--primary)` / `var(--primary-fg)`, the pair the send button already used.
  The screen existed specifically to keep a missing desktop app from reading as a
  broken install; with its only download link unclickable it did the opposite.

## v0.7.0 - August 18, 2026

First release from its own public repository, with the source public and Apache-2.0.

The extension's behaviour is unchanged from the last monorepo build. The move is
about distribution and trust, not features:

### Added

- **A real manual install path.** The old instructions told people to load a folder
  from a monorepo checkout, or to find the extension "bundled with the desktop app" -
  which it never was. Releases now publish a downloadable zip with a stable URL, and
  the desktop app's Settings -> Web access panel links to it.
- **Reproducible release zip.** `scripts/build.mjs` writes the archive with a fixed
  entry order, fixed timestamps and no compression, so anyone can rebuild it at a tag
  and get a byte-identical file. Each release publishes `SHA256SUMS.txt` so the
  published zip can be checked against a local build rather than trusted.
- **An audit gate.** `scripts/audit.mjs` (run in CI) asserts every declared
  permission is used, every used `chrome.*` API is declared, no source file names a
  non-local URL, and there is no remotely hosted code or dynamic `innerHTML`.
- **Chrome Web Store listing kept in the repo.** `STORE-LISTING.md` holds the listing
  copy, the per-permission justifications a review asks for, and the data-use
  disclosure, so the listing and the code cannot drift.

### Note on permissions

The manifest requests six permissions (`sidePanel`, `storage`, `scripting`, `tabs`,
`tabGroups`, `alarms`) plus `<all_urls>`. The previously-declared `notifications`,
`webNavigation` and `activeTab` were already removed in the final monorepo builds
because nothing in the source called them; this release inherits that clean set and
the audit gate keeps it that way.

### Versioning

Starts at 0.7.0 rather than 1.0.0: the monorepo manifest had reached 0.6.5, and the
Chrome Web Store only ever accepts an increasing version, so the independent line
picks up just above where the shared one left off.
