# Chrome Web Store listing (Foxl)

The text and the answers a submission needs, kept in the repo so the listing and the
code cannot drift. `scripts/audit.mjs` (CI) asserts the parts of this that are
checkable from the tree - every declared permission is used, and the removed ones
stay removed.

Not a runtime asset: `scripts/build.mjs` builds the zip from an allowlist that does
not include this file.

## Single Purpose (one sentence, and it must match the description)

> Foxl performs browser tasks a user has asked for - reading the current page,
> clicking, typing and navigating - by connecting to the Foxl Desktop app running on
> the same computer.

That sentence is the whole justification for `<all_urls>`, so do not soften it into
"AI assistant". A reviewer matches the permissions against the stated purpose.

## Short description (132 char max)

> Browser automation for Foxl. Reads the page, clicks, types and navigates on your
> behalf. Requires the Foxl Desktop app.

## Detailed description

Lead with the prerequisite. Most people who install a browser extension do not have
a desktop app, and this one talks ONLY to a local websocket on 127.0.0.1 (port 13847,
then 3847) - so somebody without Foxl Desktop has nothing to connect to. The
extension says this in its side panel now, and the listing must say it too.

```
Foxl is a 24/7 personal AI agent that runs on your own computer. This extension is
its browser half: it lets Foxl read the page you are on and act on it - click, type,
scroll, open and close tabs - when you ask it to.

REQUIRES THE FOXL DESKTOP APP (foxl.ai). The extension connects to Foxl Desktop over
a local connection on your own machine. Without the app installed and running, the
extension has nothing to talk to and will tell you so.

What it does
- Side panel chat, next to the page you are working on
- Reads the page's accessibility tree so the agent understands structure, not pixels
- Clicks, types, scrolls and navigates on your instruction
- Groups the tabs it opens so its work stays separate from yours

Where your data goes
- The page content the agent reads goes to the Foxl Desktop app on your computer.
- Foxl Desktop decides what to send to a model, and that is configured in the app
  (your own API key, your own AWS account, or Foxl's relay if you signed in to it).
- This extension has no analytics, no advertising SDK and no third-party identifier,
  and it sends nothing anywhere except to Foxl Desktop on your own machine.

Source code: https://github.com/foxl-ai/browser-extension
Privacy: https://github.com/foxl-ai/browser-extension/blob/main/PRIVACY.md
```

The "no analytics" sentence must stay consistent with foxl.ai's privacy page, which
states that the Foxl APPS carry no analytics SDK (foxl.ai and docs.foxl.ai use GA4
behind consent - that is the website, not an app). Do not write a stronger claim here
than that page makes.

### The privacy policy URL is PRIVACY.md, not foxl.ai/privacy

This used to say `https://foxl.ai/privacy`, and submitting that URL was a live
rejection risk. That page covers Foxl Agent, Foxl Code and Foxl Notes across desktop,
web and mobile, and as of 2026-08-18 it does not mention a browser extension, page
content or website content anywhere. The form immediately below discloses that this
item collects **website content**, so the listing would have asserted a collection
that its own linked policy did not cover. A reviewer compares those two, and
`<all_urls>` already puts this item in the slow, closely-read lane.

`PRIVACY.md` is the right link instead, and not merely as a stopgap: it names the
extension in its first line, states the website-content collection outright in a
per-item table, and carries a "Chrome Web Store disclosure" section that answers the
dashboard's nine data categories and its three certifications in the store's own
words, so the form and the policy can be diffed line by line.

The better end state is still an extension section on foxl.ai/privacy, and
`PRIVACY.md` is close to the text it needs. That is a website deploy, so it must not
block a submission; switch this URL back once that section exists.

## Permission justifications (one per permission, with its call site)

Review asks for these individually. Each answer below names the code, so it can be
re-verified rather than remembered. Every unused permission has been REMOVED -
`notifications`, `webNavigation` and `activeTab` had zero call sites, and
`scripts/audit.mjs` fails if any comes back without a caller.

| Permission | Justification |
|---|---|
| `sidePanel` | The extension's entire UI is a side panel. `chrome.sidePanel.setPanelBehavior` / `.open` in `src/service-worker.js`. |
| `storage` | Stores the user's optional custom server URL and whether a desktop has ever been reachable (which is what lets the panel say "Foxl Desktop is required" instead of "disconnected"). `src/options.js`, `src/service-worker.js`. |
| `scripting` | Injects the accessibility-tree reader and the visual activity indicator into the page the user asked Foxl to act on. `chrome.scripting.executeScript` in `src/service-worker.js`. |
| `tabs` | Core of the product: create, query, update, activate and close tabs on the user's instruction. Many call sites in `src/service-worker.js`. |
| `tabGroups` | Keeps the tabs Foxl opens in one dedicated group, so its work is visually separate from the user's own tabs. `chrome.tabGroups.get/query/update`. |
| `alarms` | An MV3 service worker is evicted, and a `setTimeout` dies with it. Alarms carry the reconnect backoff and the health re-check so a dropped connection recovers without the user reopening the panel. |
| `host_permissions: <all_urls>` | The product is performing a task on whatever page the user directs it at; the set of pages cannot be known in advance. Reading the accessibility tree of that page is the mechanism. |

## Data use disclosure (the dashboard's checkboxes)

- Personally identifiable information: **no**
- Health information: **no**
- Financial and payment information: **no**
- Authentication information: **no**
- Personal communications: **no**
- Location: **no**
- Web history: **no**
- User activity: **no** (the extension records nothing; it forwards the user's own
  instruction and the page it acts on to the local desktop app)
- Website content: **YES** - page content is read and sent to the Foxl Desktop app on
  the user's own machine, in order to perform the task the user asked for.

Certifications, all three of which are true of this code:
- data is not sold to third parties;
- data is used only for the single purpose stated above;
- data is not used to determine creditworthiness or for lending.

## Assets

- Icon 128x128: `icons/icon-128.png` (in the repo)
- Screenshots: 1280x800 (or 640x400), at least one. Show the side panel next to a
  real page, and show the "Foxl Desktop is required" state - a reviewer will hit it.
- Small promo tile 440x280 (optional but it is what the store shows in lists)
- Privacy policy URL: https://github.com/foxl-ai/browser-extension/blob/main/PRIVACY.md
  (see the section above for why this is not `foxl.ai/privacy`)

## Firefox / Edge are OUT OF SCOPE

Stated here so "ship the browser extension" cannot quietly grow into three stores.
MV3 `side_panel` does not exist in Firefox (it uses `sidebar_action`), so the UI
entry point would have to be re-implemented, and each store has its own review queue
and its own listing. Chrome only, until there is a reason with a number attached.

## Process notes

- Developer account registration is a one-time 5 USD fee.
- `<all_urls>` puts a submission in the slow review lane (days). **Do not put the
  extension on a release's critical path** - `release.yml` uploads a DRAFT by default
  (`publish=false`) for exactly this reason.
- The store accepts a version number ONCE, and only if it increases. A re-upload
  needs a new patch version. Chrome's version grammar is 1-4 dot-separated integers,
  each 0-65535 - no prerelease suffix.
