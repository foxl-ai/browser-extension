<p align="center">
  <a href="https://foxl.ai"><img src="assets/readme/foxl.svg" width="44" height="44" alt="Foxl" /></a>
</p>

<h1 align="center">Foxl Browser Extension</h1>

<p align="center">
  <strong>A little less busywork.</strong><br />
  Read, ask, and get things done in the Chrome tabs you already use.<br />
  Your Foxl Desktop agent, right beside the page.
</p>

<p align="center">
  <a href="https://chromewebstore.google.com/detail/foxl/ijlihobebaeangjiacfomjdkhlpbmlhi"><strong>Add to Chrome</strong></a> &nbsp;·&nbsp;
  <a href="#get-started">Get started</a> &nbsp;·&nbsp;
  <a href="#permissions">Permissions</a> &nbsp;·&nbsp;
  <a href="docs/DEVELOPMENT.md">Developer guide</a> &nbsp;·&nbsp;
  <a href="LICENSE">License</a>
</p>

<p align="center">
  <a href="store/screenshots/en/01-browser.png"><img src="store/screenshots/en/01-browser.png" width="960" alt="Foxl's Light side panel summarizing NASA's Cosmic Cliffs page in a real conversation" /></a>
</p>

**Requires Foxl Desktop.** The desktop app runs the agent and connects to the model
you choose. This extension lets it read pages, follow links, fill forms, and move
between tabs in your existing browser session. Keep both running on the same
computer for the default setup.

The 0.10.0 redesign brings readable 16px conversation text, a rounded message bar,
editable starting prompts, and a simpler settings page. Follow-up questions keep
the recent conversation in context.

This release also includes the screenshot fixes from 0.9.1. Minimized windows
return a clear error immediately, and a plain screenshot can recover when a
background tab has not been drawn yet.

## Keep the conversation beside the page

Ask for the useful details, then ask the next question. The **Current page**
control shows which page's title and URL will accompany your message; click it
to exclude them. **New chat** clears the visible conversation.

<p align="center">
  <a href="assets/readme/conversation-light.png"><img src="assets/readme/conversation-light.png" width="375" alt="A real Foxl conversation about Europa Clipper, followed by a request to put the facts in one sentence" /></a>
</p>

These images come from the loaded extension connected to Foxl Desktop. The
messages and results are real. See the [five-image gallery](store/screenshots/en/)
and [capture provenance](store/source/captures/provenance.json).

## Get started

You need **Chrome 116 or newer** and [Foxl Desktop](https://github.com/foxl-ai/foxl#get-started).

1. **Install the extension** from the [Chrome Web Store][chrome-store].
2. **Open Foxl Desktop.** The extension discovers the local app automatically.
3. **Open the Foxl side panel** from Chrome's toolbar and check the connection status.
4. **Start with a small task.** Open a page and ask Foxl to help with it.

> “Summarize this page and list the questions I should ask next.”

Press **Enter** to send and **Shift+Enter** for a new line. Starting prompts fill
the message bar so you can edit the request before sending.

The store installation updates through Chrome. The extension ID is `ijlihobebaeangjiacfomjdkhlpbmlhi`.

### Make yourself at home

Open **Settings** from the panel to check the Desktop connection, choose Light,
Dark, or System appearance, and see the keyboard shortcut Chrome assigned.
Automatic connection is the default; a custom server URL is optional.

<p align="center">
  <a href="assets/readme/settings-light.png"><img src="assets/readme/settings-light.png" width="650" alt="Foxl settings showing the actual Desktop connection and Light appearance selection" /></a>
</p>

### Install from source instead

The checkout can be loaded directly; no build or dependency installation is needed.

```sh
git clone https://github.com/foxl-ai/browser-extension.git
```

Open `chrome://extensions`, turn on **Developer mode**, select **Load unpacked**, and choose the cloned `browser-extension` directory. Reload the extension from that page after changing its source.

The extension targets Chrome. Other Chromium browsers may work, but these instructions and the store link are for Chrome.

## The ideas behind the extension

**Work where you already are.** Your open tabs, familiar websites, and existing sessions stay part of the task. The side panel keeps the conversation beside the page.

**Make access understandable.** Every requested permission is documented below and tied to its use in the source. A small codebase and a dependency-free runtime make inspection practical.

**Keep the connection visible.** Connection status and page indicators help you
follow the work. Chrome's site-access settings let you choose which sites the
extension can use.

**Make the package reproducible.** The build script uses an explicit file list, stable ordering, and fixed timestamps. You can rebuild the archive and compare it with another build.

## How it works

```mermaid
flowchart TD
    tabs["Your Chrome tabs and Foxl side panel"]
    extension["Foxl browser extension"]
    desktop["Foxl Desktop · localhost by default"]
    model["Your configured model or connected service"]
    tabs <-->|Page reads, actions, and results| extension
    extension <-->|WebSocket and HTTP| desktop
    desktop <-->|As needed for the task| model
```

The content script turns a page into a compact tree of labelled elements. The agent can refer to those elements when it clicks or types:

```text
navigation [ref_1]
  link "Products" [ref_2] href="/products"
  link "About" [ref_3] href="/about"
textbox "Search" [ref_4] placeholder="Search..."
button "Sign in" [ref_5]
```

A line shows at most 100 characters of an element's text (200 of a field's value). A longer one ends on `…` and says how much it shows, `clipped=100/5000`, and the agent can read that element's whole text by its ref, a slice at a time. Read with the `all` filter, which also lists what the page is not showing, an element that is not drawn carries `hidden` and one hidden from assistive technology `aria-hidden`, so a hidden error message is never taken for the page's state. A pop-up Chrome blocked is reported with the page, every tab names the tab that opened it, and, once you allow download receipts on the options page, a download that a Foxl task tab starts is reported with its file name, size and state, so a page's "your file is ready" is never the only receipt. `switch_tab` changes which tab the agent's commands go to; it never brings that tab to the front of your window.

A click, a key press, or typing that presses Enter waits for what it sent before it answers: a form's answer (the page it loads, or the requests the page sends for it) or the page a followed link loads, for at most about 12 seconds. The answer then says what the page shows, and which form was sent. A click that sends nothing, such as a single-page app's view change, answers at once. When Foxl Desktop says a chat already sent a form with the same choices (the boxes ticked, the options chosen, the amounts and dates typed), a submit of that form during Foxl's own step is stopped and reported, so the same dispute or order is not sent twice by mistake. A sign-in step (a username, a password or a one-time code) is never described. Only a submit made while Foxl's own step waits for its answer is looked at: a form you send yourself at any other time is never described or stopped.

Screenshots capture a background tab without selecting it, including a chosen rectangle or the full document. On a compatible desktop, snapshots can return just the changes since a previously read snapshot. A service worker handles the desktop connection, tab management, and command dispatch; content scripts carry out page actions and display activity indicators.

## Where your data goes

**By default, extension traffic goes to Foxl on your computer.** It discovers `http://localhost:13847`, with `http://localhost:3847` as the fallback. The options page can override that server URL; a custom endpoint changes where extension data is sent.

Page text, screenshots, tab URLs and titles, the file names, sizes and states of downloads a Foxl task tab started (once you allow download receipts), and chat requests can pass to that configured server. Foxl Desktop may then send task context to your chosen model provider or connected service. Local transport between Chrome and Desktop does not mean every part of the task stays on your computer.

The extension has no analytics endpoint, remote configuration, or remotely hosted
executable code. Connection and appearance settings are stored in
`chrome.storage.local`. The visible conversation stays in the panel's memory;
New chat or closing the panel clears it. Follow-up requests include recent
messages, including information already shared before you excluded the current page.

The network entry points are small enough to inspect directly:

| Source | Requests |
| :--- | :--- |
| [Service worker](src/service-worker.js) | Health probes at `/api/health`, a WebSocket at `/extension`, and chat requests at `/api/chat` |
| [Request watch](src/content-scripts/request-watch.js) | None. It wraps the page's own `fetch` and `XMLHttpRequest` to count the requests still running, and passes every call through unchanged |

The settings page asks the service worker for its actual connection status.

```sh
rg -n 'fetch\(|XMLHttpRequest|new WebSocket|navigator.sendBeacon' src/
node scripts/audit.mjs
```

[Extension privacy details](PRIVACY.md) · [Foxl privacy policy](https://foxl.ai/privacy) · [Report a security issue](SECURITY.md)

## Permissions

The manifest requests access to all sites so the agent can work on the pages you choose. You can restrict **Site access** in the extension's Chrome settings.

| Permission | What it enables |
| :--- | :--- |
| `<all_urls>` | Read and interact with the pages you allow. |
| `tabs` | Read tab titles and URLs, navigate, and open, switch, or close tabs. |
| `scripting` | Read snapshots, scroll, and check the target page's current site access before and after a screenshot. |
| `debugger` | Briefly attach to a background tab to read its viewport and capture its pixels without selecting it. |
| `tabGroups` | Organize tabs opened for agent tasks. |
| `sidePanel` | Show the conversation beside the current page. |
| `storage` | Save connection and appearance settings locally. |
| `alarms` | Maintain the service worker's connection lifecycle. |
| `downloads` (optional) | Only after you choose **Allow** under **Download receipts** on the options page: see the downloads a Foxl task tab starts (file name, size, state) so Foxl can confirm a file was really saved. Your other downloads are never read. |

Versions 0.11.0 and 0.12.0 request the same permissions as 0.9.0, and the update installs
without a prompt. The one permission 0.11.0 added, `downloads`, is optional: Chrome asks for it ("Manage your
downloads") only when you choose **Allow** under **Download receipts** on the options page,
and **Turn off** there takes it back. If you are upgrading from 0.8.x or earlier, Chrome
asks you to accept the `debugger` permission introduced in 0.9 ("Access the page debugger
backend"). If Foxl is disabled after updating, open Chrome's menu and choose "Foxl is
disabled", or re-enable it in `chrome://extensions` and review the permission prompt.

While Foxl captures a background tab, or draws one after scrolling it, Chrome shows a bar at the top of every tab in every window: "Foxl" started debugging this browser, with a Cancel button. The bar shortens the page you are viewing and closes 5 seconds after the last capture. The tab you are looking at is captured without the debugger. The API has broad capabilities; this extension uses only `Page.getLayoutMetrics` and `Page.captureScreenshot`, checks site access with `scripting` before attaching and before returning pixels, and detaches after each capture. It exposes no arbitrary CDP command, cookie reader, or network recorder. Where Chrome refuses the debugger (an administrator's DevTools policy, a page containing another extension's frame) or cannot draw a background tab (a PDF), a screenshot selects the tab for a moment and switches back, as 0.8 did. Without site access, a screenshot fails.

[manifest.json](manifest.json) declares the permissions. [scripts/audit.mjs](scripts/audit.mjs) checks permission usage and the network and executable-code surface in CI.

## Find your way around

| Path | Purpose |
| :--- | :--- |
| [src/service-worker.js](src/service-worker.js) | Connection, tabs, and command routing |
| [src/input-queue.js](src/input-queue.js) | One click / type / key at a time per tab, each with a deadline |
| [src/page-capture.js](src/page-capture.js) | Background screenshots, page-access checks, and CSS geometry |
| [src/page-snapshot.js](src/page-snapshot.js) | Bounded snapshots and explicit baselines for changes |
| [src/content-scripts/](src/content-scripts/) | Page accessibility tree and visual indicators |
| [src/sidepanel.js](src/sidepanel.js) · [sidepanel.html](sidepanel.html) | Side panel conversation |
| [src/panel-context.js](src/panel-context.js) | Current-window page selection and bounded conversation context |
| [src/message-text.js](src/message-text.js) | Safe rendering of message paragraphs, lists, code, and links |
| [src/theme.js](src/theme.js) · [styles/foxl.css](styles/foxl.css) | Shared Foxl typography, colors, and appearance |
| [src/options.js](src/options.js) · [options.html](options.html) | Appearance, connection checks, and shortcuts |
| [scripts/](scripts/) | Source audit, unit tests, reproducible packaging, and icon generation |
| [store/](store/) | Real store captures, artwork, and review evidence |
| [CHANGELOG.md](CHANGELOG.md) | Version history |

## Develop and contribute

Use **Node.js 20 or newer** for the audit and package build:

```sh
node scripts/audit.mjs
node --test scripts/*.test.mjs
node scripts/build.mjs
```

The build writes versioned and `latest` ZIPs plus `SHA256SUMS.txt` to `dist/`. Dependencies are needed only if you want to regenerate the PNG icons.

The [developer guide](docs/DEVELOPMENT.md) covers debugging, package comparison,
and releases. For a change, open a pull request with the problem, the resulting
behavior, and how you verified it. CI checks the audit, unit tests, reproducible
build, and manifest/changelog agreement. The [0.10.0 review record](store/QUALITY.md)
also covers real Desktop tasks and visual checks.

## Help and license

[Report a bug or suggest an improvement](https://github.com/foxl-ai/browser-extension/issues). Include the extension version, Chrome version, operating system, and reproduction steps.

Report vulnerabilities privately to [security@foxl.ai](mailto:security@foxl.ai); see [SECURITY.md](SECURITY.md).

Licensed under [Apache-2.0](LICENSE). See [NOTICE](NOTICE) for attribution.

<p align="center"><sub>Part of <a href="https://foxl.ai">Foxl</a> · Your day. A little lighter.</sub></p>

[chrome-store]: https://chromewebstore.google.com/detail/foxl/ijlihobebaeangjiacfomjdkhlpbmlhi
