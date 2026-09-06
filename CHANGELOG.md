# Changelog

Notable changes to the Foxl browser extension.

This extension has its own version line, independent of the Foxl Desktop release
number. It used to ship inside the Foxl monorepo, where a script kept its manifest
version pinned to the app's unified line; the split makes the two independent.

## v0.7.2 (unreleased)

### Changed

- **The connection to Foxl Desktop is now Chrome native messaging, and the pairing
  code is gone.** The extension used to reach the desktop over a WebSocket on
  `127.0.0.1`, where the desktop's only way to identify the caller was the `Origin:`
  header - which a browser cannot forge and any local *program* can. The desktop's
  stopgap was a 64-character pairing code the user copied into the browser; this
  removes the secret rather than moving it. Chrome now starts the bridge process
  itself and only lets the extension ids in the host manifest's `allowed_origins`
  reach it (no wildcards permitted), and the bridge - being an ordinary process
  rather than a sandboxed page - reads the desktop's own credential off a file only
  your user account can read. Nothing is stored in the browser, and there is no
  longer a local port for another program to knock on. Same approach as Anthropic's
  Claude extension. Full reasoning, including what it does *not* fix, is in the
  README under "How the local connection is secured".
- **Requires accepting one new permission**, `nativeMessaging` ("Communicate with
  cooperating native applications"). Chrome disables an extension after an update
  that adds a warning until the user accepts, so this update needs one click at
  `chrome://extensions` before browser control returns.
- **The extension id is pinned** by putting the Chrome Web Store item's public key in
  `manifest.json`, so a hand-loaded copy resolves to the same id
  (`ijlihobebaeangjiacfomjdkhlpbmlhi`) as the store build. The desktop authorises one
  id, so an unpinned unpacked copy would be refused.
- **An older desktop still works.** A desktop that predates the bridge has no host
  manifest for `connectNative` to find, which is a normal answer rather than an
  error: the extension falls back to the WebSocket. The options page names the live
  channel, so "verified bridge" and "local socket" are distinguishable rather than
  both reading as "Connected".
- **Close code 4004 now explains itself.** A desktop that requires the bridge closes
  an unpaired socket with `4004 extension_pairing_required`, which this extension
  previously rendered as the ordinary "Reconnecting" dot and retried forever.

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
