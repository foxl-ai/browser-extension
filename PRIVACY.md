# Privacy

This page covers the Foxl browser extension. The Foxl desktop app and the Foxl
services have their own policy at <https://foxl.ai/privacy>; that distinction
matters here: the extension hands page data to its configured Foxl server, and the
desktop app decides what context to send to the model or connected service.

Last updated: October 26, 2026.

## The short version

By default, the extension talks to the Foxl desktop app on your own computer, at
`http://localhost:13847`, with port `3847` as a fallback. A custom server URL in
the options changes that destination. There is no analytics, no telemetry, no
crash reporting, no remote configuration, and no third-party code in this
extension.

You can confirm that rather than believe it. Every network call site in the
source is listed in the [README](README.md#where-your-data-goes), together with
the one-line grep that proves the list is complete.

## What the extension handles

To do its job the extension necessarily touches sensitive things. Being specific
about them is more useful than a reassuring summary:

| Data | Why | Where it goes |
|---|---|---|
| Page content: text, labels, field values, and structure of the pages you point the agent at | So the agent can understand a page and find the element to act on | The configured Foxl server |
| Screenshots of the requested tab, including a rectangle or the full document | Visual confirmation of what the page looks like | The configured Foxl server |
| Tab URLs and titles | So a task can move between sites and the agent knows where it is | The configured Foxl server |
| Actions the agent performs: clicks, typed text, navigation | They are the work itself | Performed in your browser |
| Your settings: the server URL | So you do not re-enter it | `chrome.storage.local`, on your machine only |

Page content can include whatever is on the page, and that may be personal:
an email in a webmail tab, an order in a shop, a form you have partly filled in.
The extension does not single such things out and does not try to detect them. It
reads the tab the agent is working with. A full tree or a full-page screenshot
can include content outside the current viewport. Password input values are
omitted from text snapshots, but this does not redact sensitive text or pixels
elsewhere on a page.

The `debugger` permission added in 0.9 has broad browser capabilities. This code
uses it only for `Page.getLayoutMetrics` and `Page.captureScreenshot`; it does
not request arbitrary CDP commands from the desktop, read cookies, or record
network traffic. A real scripting call checks Chrome's current site access
before attachment and before returning the image. The debugger is detached
after capture, including on failure.

## What the extension does not do

- It has no analytics or advertising destination. Page data goes to the
  configured server for the task; the default destination is local.
- It does not sell your data.
- It does not use your data for anything unrelated to performing the task you
  asked for.
- It does not use your data to determine creditworthiness or for lending.
- It does not track you across sites, build a profile, or serve advertising.
- It does not run any remotely hosted code.

## Chrome Web Store disclosure

This page is the privacy policy URL for the Chrome Web Store listing, so the answers
that listing gives are restated below in the store's own vocabulary. They are here so
a reviewer can check the form against a document rather than take the form's word for
it, and so the two cannot drift apart quietly.

| Store data category | Collected | Detail |
|---|---|---|
| Website content | **Yes** | Page text, labels, field values, structure, and screenshots are read and handed to the configured Foxl server so it can decide what to read, click or type next. |
| Personally identifiable information | No | Nothing of the kind is extracted, singled out or detected. Page content is passed through as page content; if a name or an address happens to be on the page, it is on the page. |
| Health information | No | Not collected. |
| Financial and payment information | No | Not collected. |
| Authentication information | No separate collection | Password input values are omitted from text snapshots. The code calls no cookie or token API. Sensitive information can still be present in website content or screenshots. |
| Personal communications | No | Not extracted or singled out, for the same reason as personally identifiable information above. |
| Location | No | Not collected. No geolocation API is used. |
| Web history | No browsing-history collection | The extension reads the target tab's URL and title. Snapshot baselines temporarily hold the URL in memory; they are not a history database. |
| User activity | No | Your clicks, keystrokes and mouse movement are not recorded. The clicks and typing that do happen are the agent carrying out the instruction you gave it. |

The three certifications the store requires, each true of this code:

- Data is **not sold** to third parties, and is not transferred to any third party for
  a purpose unrelated to the item's single purpose. Page data goes to the
  configured Foxl server for the requested task.
- Data is used **only** for the single purpose stated in the listing, which is
  performing the browser task you asked for.
- Data is **not used** to determine creditworthiness or for lending purposes.

## Retention

The extension keeps up to 32 text snapshot baselines in service-worker memory,
including the corresponding tab and document identity and URL. Baselines expire
for reuse after five minutes and are removed during the next snapshot cleanup.
Closing the tab, disconnecting the desktop, or restarting the service worker also
clears the relevant baselines. They are never written to extension storage.

Screenshots pass through the extension without being written to disk by it.
Settings persist in `chrome.storage.local`; removing the extension deletes those.

Anything the desktop app retains after receiving this data is covered by
<https://foxl.ai/privacy>.

## Control

- **Restrict where it works.** In `chrome://extensions`, open Foxl's details and
  set "Site access" to "On specific sites" or "On click". The extension asks for
  access to all sites because an agent limited to a fixed list cannot run your
  errands, but you are not obliged to grant it.
- **See when it acts.** The tabs the agent opens sit in their own tab group
  named "Foxl", and an element it clicks is briefly outlined. A border around
  the page and a **Stop Foxl** button appear while it works only when the Foxl
  Desktop app tells the extension that a run is under way. Desktop versions
  that do not send that signal leave them off, so with those versions the agent
  can type and click on a page without the border showing.
- **Cut the connection.** Quit the desktop app. With nothing listening on
  its configured server, the extension receives no new task commands.
- **Remove it.** Uninstalling from `chrome://extensions` takes its stored
  settings with it.

## Changes

Material changes to this page are noted in [CHANGELOG.md](CHANGELOG.md), which
means the git history of this file is the full record.

## Contact

privacy@foxl.ai, or [open an issue](https://github.com/foxl-ai/browser-extension/issues)
for anything that does not need to be private.
