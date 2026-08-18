# Changelog

Notable changes to the Foxl browser extension.

This extension has its own version line, independent of the Foxl Desktop release
number. It used to ship inside the Foxl monorepo, where a script kept its manifest
version pinned to the app's unified line; the split makes the two independent.

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
