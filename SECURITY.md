# Security Policy

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately through
[GitHub's private vulnerability reporting](https://github.com/foxl-ai/browser-extension/security/advisories/new),
or email **security@foxl.ai**.

Include what you need to make the problem reproducible: the extension version
(`chrome://extensions` shows it), your Chrome version and OS, and the steps or a
page that triggers it.

We will acknowledge within 3 business days and keep you updated as we work on a
fix. If you would like credit in the release notes, say so and tell us how you
want to be named.

## Scope

This repository is the browser extension only. It is worth reporting here if you
find:

- A way for a visited web page to reach the extension's privileged APIs, for
  example by forging a message the service worker or a content script trusts.
- A way for anything other than the local Foxl desktop app to drive the
  extension over its WebSocket connection.
- Page content, credentials, or browsing data leaving the machine to any host
  other than the configured local server.
- A privilege the extension holds beyond what the README documents.

Out of scope here, though still worth reporting to security@foxl.ai:

- Issues in the Foxl desktop app, relay, or web app. Those live in a different
  codebase; this extension only talks to the desktop app over localhost.
- "The extension can read and change data on all websites." That is its stated
  purpose and it is documented in the README's permission table. A way to get
  that access *without* the user granting it is very much in scope.
- Chrome's own "disable developer mode extensions" warning on an unpacked
  install.

## Supported versions

The latest release is the supported one. There are no long-term support
branches; fixes ship as a new version.

## What this extension does not do

Stated here so a deviation is reportable as a bug rather than a design question:

- It makes no network request to any host other than the Foxl server URL, which
  defaults to `http://localhost:13847`.
- It executes no remotely hosted code. No `eval`, no injected script tags, no
  WebAssembly.
- It stores nothing outside `chrome.storage.local`, and syncs nothing.
- It reads no cookies and intercepts no network traffic. It has neither the
  `cookies` nor the `webRequest` permission.
