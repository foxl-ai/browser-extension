# Privacy

This page covers the Foxl browser extension. The Foxl desktop app and the Foxl
services have their own policy at <https://foxl.ai/privacy>; that distinction
matters here, because the extension's whole data story is "it hands things to the
app on your machine and stops there."

Last updated: August 18, 2026.

## The short version

The extension sends nothing to Foxl, and nothing to anyone else. It talks to one
host: the Foxl desktop app running on your own computer, at
`http://localhost:13847` by default. There is no analytics, no telemetry, no
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
| Page content: text, labels, and structure of the pages you point the agent at | So the agent can understand a page and find the element to act on | The local Foxl app |
| Screenshots of the visible tab | Visual confirmation of what the page looks like | The local Foxl app |
| Tab URLs and titles | So a task can move between sites and the agent knows where it is | The local Foxl app |
| Actions the agent performs: clicks, typed text, navigation | They are the work itself | Performed in your browser |
| Your settings: the server URL | So you do not re-enter it | `chrome.storage.local`, on your machine only |

Page content can include whatever is on the page, and that may be personal:
an email in a webmail tab, an order in a shop, a form you have partly filled in.
The extension does not single such things out and does not try to detect them. It
reads what is on screen in the tab the agent is working with, the way a screen
reader does.

Two limits worth stating because they are enforced by what the extension is not
allowed to do, not by good intentions: it holds neither the `cookies` permission
nor `webRequest`, so it cannot read your cookies or intercept your traffic. It
reads the rendered page, and nothing beneath it.

## What the extension does not do

- It does not send data to Foxl's servers or to any third party.
- It does not sell or transfer your data to anyone. There is nobody to transfer
  it to.
- It does not use your data for anything unrelated to performing the task you
  asked for.
- It does not use your data to determine creditworthiness or for lending.
- It does not track you across sites, build a profile, or serve advertising.
- It does not run any remotely hosted code.

## Retention

The extension keeps no history. Page content and screenshots pass through it and
are not stored; the only thing it persists is your settings, in
`chrome.storage.local`. Removing the extension from Chrome deletes that.

Anything the desktop app retains after receiving this data is covered by
<https://foxl.ai/privacy>.

## Control

- **Restrict where it works.** In `chrome://extensions`, open Foxl's details and
  set "Site access" to "On specific sites" or "On click". The extension asks for
  access to all sites because an agent limited to a fixed list cannot run your
  errands, but you are not obliged to grant it.
- **See when it acts.** While the agent is working on a page you get a border
  around the viewport, a highlight on the element being touched, and a stop
  button. It cannot act invisibly.
- **Cut the connection.** Quit the desktop app. With nothing listening on
  localhost the extension can do nothing at all.
- **Remove it.** Uninstalling from `chrome://extensions` takes its stored
  settings with it.

## Changes

Material changes to this page are noted in [CHANGELOG.md](CHANGELOG.md), which
means the git history of this file is the full record.

## Contact

privacy@foxl.ai, or [open an issue](https://github.com/foxl-ai/browser-extension/issues)
for anything that does not need to be private.
