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

Foxl is on the Chrome Web Store:
**[Foxl](https://chromewebstore.google.com/detail/foxl/ijlihobebaeangjiacfomjdkhlpbmlhi)**.
That is the install to prefer - it updates itself, and Chrome verifies the package.

> **Updating to 0.7.2 asks you to accept one new permission, and until you do,
> Chrome keeps the extension switched off.** 0.7.2 adds `nativeMessaging`, whose
> warning reads *"Communicate with cooperating native applications"*, and Chrome's
> rule for any update that adds a warning is that "the extension will be disabled
> until the user accepts the new permission". So after the update lands, open
> `chrome://extensions`, accept, and the extension comes back. The permission is
> what replaces the old pairing secret; see
> [How the local connection is secured](#how-the-local-connection-is-secured).

### Install unpacked instead

The manual "Load unpacked" path still works, and it is the one to use if you want to
read the source you are running:

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
unpacked extension, not a verdict on this one; the store install above does not
get it.

An unpacked install resolves to the **same extension id as the store build**
(`ijlihobebaeangjiacfomjdkhlpbmlhi`), because `manifest.json` pins the store's own
public key in its `key` field. That is not cosmetic: the desktop app authorises
exactly one id, so without the pin a hand-loaded copy would get a
path-derived id and the desktop would refuse it. See below.

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

## How the local connection is secured

The extension has no AI in it. Everything it does is a conversation with the Foxl
Desktop app on the same machine, so the question "who is the desktop actually
talking to?" is the whole security story of this extension.

**Until 0.7.2 the honest answer was "it cannot tell."** The extension opened a
WebSocket to `127.0.0.1`, and the desktop decided whether to trust it by reading the
`Origin:` header. A browser sets that header and a web page cannot forge it, so the
check does stop a hostile web page - and it stops nothing else, because any program
running on your computer can open the same socket and write whatever `Origin` it
likes. Measured against the real desktop with a plain `ws` client and no credential:
`Origin: chrome-extension://aaaa...` was accepted, and the connection reached the
agent with shell, terminal and file-write tools enabled.

The stopgap was a **pairing code**: the desktop printed a 64-character secret and you
copied it into the extension. It closes the hole, and it has three costs - you have
to perform a ceremony, the secret then lives in browser storage where any page-level
mistake could reach it, and until you have done it the hole is still open.

**0.7.2 replaces the secret with Chrome itself.** The extension now speaks to the
desktop over Chrome's native messaging channel:

```
extension  ──stdio, spawned and vouched for by Chrome──▶  foxl browser bridge
                                                            (a Foxl Desktop process)
```

Why that is stronger than anything achievable over a local port:

- **Chrome decides who may connect, and it is not a header we could forge.** The
  desktop installs a small manifest naming the extension ids allowed to reach it, and
  Chrome refuses everyone else. Its own documentation is explicit that these values
  "can't contain wildcards", and a caller that is not on the list is told "Access to
  the specified native messaging host is forbidden."
- **There is no listening port to find.** Chrome starts the bridge process itself and
  connects it by pipe, so there is nothing for another local program to knock on.
- **No secret is stored in the browser.** The bridge is an ordinary process, so it
  reads the desktop's own credential off disk - a file only your user account can
  read. That is the thing a sandboxed extension can never do, and the entire reason
  the pairing code had to travel through a human.
- **The extension id is pinned**, so this holds for a hand-loaded copy too (see
  Install above).

**What it does not fix, stated plainly:** a program already running as *you* can read
your files and install its own manifests, so it could still impersonate a browser to
the desktop. Nothing on a single machine can prevent that, and no local-connection
scheme should claim to. What changed is that this no longer requires *nothing at all* -
it requires code running as you, rather than any process that can open a TCP socket.

This is also the approach Anthropic's own Claude extension takes, which is worth
knowing if you would rather trust a pattern than a paragraph: it declares the same
permission, connects to a native host, and keeps no pairing code either.

If your desktop app is older than the release that installs the bridge, the extension
falls back to the old WebSocket so browser control keeps working. The options page
tells you which channel is live.

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
| `nativeMessaging` | Talk to the Foxl Desktop app through Chrome instead of through a local network port. This is the change that let the extension stop storing a pairing secret - see [How the local connection is secured](#how-the-local-connection-is-secured). | `chrome.runtime.connectNative('ai.foxl.browser_bridge')` |

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
