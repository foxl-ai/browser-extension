# Foxl Browser Extension

The browser half of [Foxl](https://foxl.ai), a personal AI agent. This extension
lets the agent act in the Chrome tabs you already have open, signed in as you:
it reads the page, clicks, types, scrolls, and navigates on your behalf.

The source is public so you can read it before you install it. An extension that
asks for access to every site you visit should not be a black box, and this one
is about 2,400 lines of plain JavaScript with no build step and no bundled
dependencies.

- **Manual install and verification:** [Install](#install)
- **Every permission, and the code that needs it:** [Permissions](#permissions)
- **What leaves your machine:** [Where your data goes](#where-your-data-goes)

## Requirements

- Chrome 116 or newer (the side panel API landed in 116). Edge and other
  Chromium browsers work; Firefox is not supported yet.
- The Foxl desktop app running on the same machine. The extension is useless on
  its own: it has no AI in it and no server to talk to. Get the app at
  [foxl.ai](https://foxl.ai).

## Install

Foxl is not on the Chrome Web Store yet, so installation is manual. This is the
"Load unpacked" path Chrome provides for exactly this case.

1. Download `foxl-browser-extension-latest.zip` from the
   [latest release](https://github.com/foxl-ai/browser-extension/releases/latest).
2. Unzip it. Both macOS Archive Utility and Windows Explorer extract it into a
   folder of the same name; that folder is what you select in step 5.
3. Open `chrome://extensions` in Chrome.
4. Turn on **Developer mode** (top-right toggle).
5. Click **Load unpacked** and select the unzipped folder.

The Foxl icon appears in your toolbar. Start the desktop app and the extension
connects on its own; the side panel shows the connection state.

Chrome will show a "Disable developer mode extensions" warning on startup while
the extension is loaded this way. That is Chrome's blanket notice for every
unpacked extension, not a verdict on this one, and it goes away once the Web
Store listing is live.

### Verify the download

Every release publishes `SHA256SUMS.txt` alongside the zip. Check it before you
unzip:

```sh
shasum -a 256 -c SHA256SUMS.txt
```

The zip is built deterministically: fixed entry order, fixed timestamps, no
build step. So you can also rebuild it from this repository at the release tag
and compare digests, which is a stronger check than trusting the published file:

```sh
git checkout v0.7.0
node scripts/build.mjs
shasum -a 256 dist/foxl-browser-extension-0.7.0.zip
```

The digest must match the one in the release's `SHA256SUMS.txt`. If it does not,
the published zip is not this source, and you should open an issue rather than
install it.

### Install from source instead

If you would rather skip the zip entirely, clone the repository and load the
checkout directly. There is no build step, so the working tree is the extension:

```sh
git clone https://github.com/foxl-ai/browser-extension.git
```

Then **Load unpacked** and select the clone. This is what the desktop app's
Settings -> Web access panel links to.

## Where your data goes

Nowhere except your own machine. Every network call in this extension targets
the local Foxl server; there is no analytics endpoint, no telemetry, no remote
config, and no third-party script.

You do not have to take that on faith. There are exactly six network call sites
in the source, and this is all of them:

| Call site | Target |
|---|---|
| `src/service-worker.js` `getServerUrl()` | `GET {serverUrl}/api/health` (port probe) |
| `src/service-worker.js` `connectToServer()` | `WebSocket {serverUrl}/extension` |
| `src/service-worker.js` chat send | `POST {serverUrl}/api/chat` |
| `src/service-worker.js` health check | `GET {serverUrl}/api/health` |
| `src/options.js` port probe | `GET {url}/api/health` |
| `src/options.js` connection test | `GET {serverUrl}/api/health` |

`serverUrl` defaults to `http://localhost:13847`, falling back to
`http://localhost:3847` (the desktop app's production and dev ports). It is
resolved by `getServerUrl()` and can be overridden on the options page, so the
one way this extension talks to a non-local host is if you type one in
yourself.

Confirm the list is complete with a grep, which is cheaper than reading 2,400
lines:

```sh
grep -rnE "fetch\(|XMLHttpRequest|new WebSocket|navigator.sendBeacon" src/
```

Page content read by the extension (the accessibility tree, screenshots) is sent
to that local server, which is the desktop app on your own machine. What the
desktop app does with it afterwards, including which model provider it calls, is
that app's business and is documented at [foxl.ai](https://foxl.ai). This
repository covers only the browser side.

There is no remotely hosted code. Chrome forbids it in Manifest V3, and this
extension has nothing that would want it: no `eval`, no injected `<script src>`,
no WebAssembly.

## Permissions

Chrome shows a permission list at install time, and "Read and change all your
data on all websites" is the alarming one. It is also unavoidable for what this
extension does: an agent that can only act on a hardcoded allowlist of sites
cannot do your errands. Here is every permission, what it is for, and the API
calls that need it, so you can check the claim instead of believing it.

| Permission | Why it is here | Code that uses it |
|---|---|---|
| `<all_urls>` (host) | Read and act on whatever page you point the agent at. Also required by `captureVisibleTab`. | Both content scripts, and `chrome.tabs.captureVisibleTab` |
| `tabs` | Open, close, switch, and read the URL/title of tabs so a task can span several sites. | `chrome.tabs.create` / `get` / `query` / `update` / `remove` / `sendMessage` / `onUpdated` / `onRemoved` |
| `scripting` | Inject the accessibility-tree reader into a frame that loaded before the extension did. | `chrome.scripting.executeScript` |
| `tabGroups` | Keep the tabs the agent opened in their own labelled group, so its tabs stay separable from yours. | `chrome.tabGroups.get` / `query` / `update`, `chrome.tabs.group` |
| `sidePanel` | The chat UI lives in Chrome's side panel. | `chrome.sidePanel.open` / `setOptions` / `setPanelBehavior` |
| `storage` | Remember your server URL and settings. Local only; nothing is synced. | `chrome.storage.local` |
| `alarms` | Wake the service worker on a timer. Chrome kills idle MV3 workers after 30s, which would drop the connection mid-task. | `chrome.alarms.create`, `chrome.alarms.onAlarm` |

`notifications`, `webNavigation` and `activeTab` used to be declared and are gone.
Nothing in the source ever called any of them, and `notifications` contributed an
install-time warning for a capability the extension did not have. Every permission
that remains maps to a call site above, and `scripts/audit.mjs` fails the build if
that stops being true in either direction. If you see a build asking for one of the
three removed permissions, it is not this one.

Three things this extension deliberately does not request: `<all_urls>` in
`optional_host_permissions` (so there is no silent escalation path), `cookies` /
`webRequest` / `debugger` (it reads pages the way a screen reader does, not by
intercepting traffic), and `notifications` (it surfaces state in its own side panel).

## How it works

```
manifest.json               Extension configuration
sidepanel.html              Side panel chat UI
options.html                Settings (server URL, connection test)
icons/                      Toolbar and store icons
src/
  service-worker.js         Background: WebSocket, tab management, command dispatch
  sidepanel.js              Side panel logic
  options.js                Settings page logic
  content-scripts/
    accessibility-tree.js   Turns the DOM into a labelled element tree
    visual-indicator.js     Shows when the agent is acting on a page
styles/                     Side panel and options CSS
scripts/
  build.mjs                 Deterministic release zip, zero dependencies
  generate-icons.mjs        Re-render PNG icons from icons/icon.svg
```

### The accessibility tree

The agent does not read pixels or raw HTML. A content script walks the DOM and
emits a compact tree of the interactive elements, each with a `ref` the agent can
address:

```
link "Home" [ref_1] href="/"
navigation [ref_2]
  link "Products" [ref_3] href="/products"
  link "About" [ref_4] href="/about"
button "Sign In" [ref_5]
textbox "Search" [ref_6] placeholder="Search..."
```

### Message flow

1. You type in the side panel.
2. Side panel -> service worker -> local Foxl server over WebSocket.
3. The desktop agent decides on an action.
4. Server -> service worker -> content script, which performs it.
5. The result travels back the same way.

Messages the server sends: `read_page`, `click`, `type`, `navigate`,
`screenshot`, `show_indicators`, `hide_indicators`.
Messages the extension sends: `extension_connected`, `chat`, `stop_agent`,
`response`.

### Visual indicators

While the agent is acting on a page you get a teal border around the viewport, a
highlight on the element being touched, and a "Stop Foxl" button. The agent
cannot act invisibly.

## Development

No build step, no `npm install` required to run it. Load the checkout unpacked
and reload from `chrome://extensions` after an edit.

```sh
node scripts/build.mjs      # build dist/*.zip + SHA256SUMS.txt (no dependencies)
npm install                 # only needed for the icon generator
npm run icons               # re-render PNGs from icons/icon.svg
```

Debugging surfaces:

- Service worker: `chrome://extensions` -> Foxl -> "Inspect views: service worker"
- Side panel: right-click the panel -> Inspect
- Content scripts: the page's own DevTools console

## Releasing

`.github/workflows/release.yml` builds the reproducible zip, publishes it as a
GitHub Release with `SHA256SUMS.txt`, and - when the Chrome Web Store secrets are
configured - uploads the same zip to the store as a draft. Bump `manifest.json`'s
`version`, add a dated `## vX.Y.Z` section to `CHANGELOG.md`, land that, then
dispatch:

```sh
gh workflow run release.yml -f version=X.Y.Z
```

The version input is a guard rather than the source of truth: the workflow re-checks
it against `manifest.json` and `CHANGELOG.md` and refuses a tag that already exists,
so a mistyped dispatch fails instead of shipping the wrong number.

The Chrome Web Store listing copy, the per-permission justifications a review asks
for, and the data-use disclosure live in [STORE-LISTING.md](STORE-LISTING.md), kept
in the repo so the listing and the code cannot drift.

## Reporting a problem

Security issues: see [SECURITY.md](SECURITY.md). Please do not open a public
issue for those.

Everything else: [open an issue](https://github.com/foxl-ai/browser-extension/issues).

## License

[Apache-2.0](LICENSE). Copyright 2026 Foxl AI.
