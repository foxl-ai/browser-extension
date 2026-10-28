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
a desktop app, and this one talks to a local websocket by default (port 13847,
then 3847). The options can override that server URL. Somebody without a Foxl
server has nothing to connect to. The
extension says this in its side panel now, and the listing must say it too.

```
Requires Foxl Desktop, installed and running on your computer. Get the app at foxl.ai.

A little less busywork.

Foxl works beside the page. Ask it to understand what you are reading, find useful
details, or take the next step for you. This extension connects your browser to
your Foxl Desktop agent.

Read, ask, and keep going
- Summarize a page and pull out the key facts.
- Ask follow-up questions in the same conversation.
- Keep your page in view while you chat in the side panel.
- Choose whether to include the current page's title and URL with your next message.

Ask for the task
- Find information, follow links, and navigate between pages.
- Click, type, select, and scroll on your instruction.
- Work across tabs and organize the tabs Foxl opens.
- Read page structure and capture the requested tab when the task needs it.

Make yourself at home
- A clear conversation layout with a roomy message bar.
- Editable starting prompts and a fresh chat when you need one.
- Appearance settings and a connection check in one simple settings page.

Where your data goes
- Your messages, recent replies, and the page content or screenshots needed for
  your task go to your configured Foxl server, on your computer by default.
  A custom server URL changes that destination.
- Foxl Desktop manages the model connection and decides what context to send.
  Model and service settings are managed in the Desktop app.
- This extension has no analytics, no advertising SDK and no third-party identifier.

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
| `storage` | Stores the user's optional custom server URL, appearance preference, and whether a desktop has ever been reachable (which is what lets the panel say "Foxl Desktop is required" instead of "disconnected"). `src/options.js`, `src/theme.js`, `src/service-worker.js`. |
| `scripting` | Scrolls the requested page (`scrollPage` in `src/service-worker.js`), reads bounded snapshots (`src/page-snapshot.js`), and checks the current per-site access grant before and after debugger capture (`src/page-capture.js`). The page reader and activity indicator remain declared content scripts. |
| `debugger` | Captures pixels from a tab in the background without selecting it: `chrome.tabs.captureVisibleTab` can capture only the selected tab, so without this a screenshot of the tab Foxl works in must switch the user away from the tab they are using. `src/page-capture.js` attaches temporarily, calls only `Page.getLayoutMetrics` and `Page.captureScreenshot`, and detaches on success or failure. Scripting checks prevent the capture path from bypassing withheld site access. Chrome does not permit `debugger` as an optional permission. No arbitrary CDP command or network recording is exposed. |
| `tabs` | Core of the product: create, query, update, activate and close tabs on the user's instruction. Many call sites in `src/service-worker.js`. |
| `tabGroups` | Keeps the tabs Foxl opens in one dedicated group, so its work is visually separate from the user's own tabs. `chrome.tabGroups.get/query/update`. |
| `alarms` | An MV3 service worker is evicted, and a `setTimeout` dies with it. Alarms carry the reconnect backoff and the health re-check so a dropped connection recovers without the user reopening the panel. |
| `host_permissions: <all_urls>` | The product is performing a task on whatever page the user directs it at; the set of pages cannot be known in advance. Reading the accessibility tree of that page is the mechanism. |

## Data use disclosure (the dashboard's checkboxes)

- Personally identifiable information: **no**
- Health information: **no**
- Financial and payment information: **no**
- Authentication information: no separate collection; password and hidden field
  values are omitted from snapshots. Sensitive content can still appear in website content
  or screenshots; see PRIVACY.md.
- Personal communications: **no**
- Location: **no**
- Web history: **no browsing-history collection**; snapshot baselines temporarily
  hold the target URL in memory, as documented in PRIVACY.md.
- User activity: **no** (the extension records nothing; it forwards the user's own
  instruction and the page it acts on to the local desktop app)
- Website content: **YES** - page text, field values, structure, and screenshots go
  to the configured Foxl server for the task. The default server is local.

Certifications, all three of which are true of this code:
- data is not sold to third parties;
- data is used only for the single purpose stated above;
- data is not used to determine creditworthiness or for lending.

## Assets

- Icon 128x128: `icons/icon-128.png` (in the repo)
- Screenshots: the five 1280x800 PNGs in `store/screenshots/en/`, in numbered order.
  They use native captures of the loaded extension, real Foxl Desktop responses
  on public pages, and the actual settings page. All gallery images use light
  appearance. Marketing text sits outside the captured interface.
- Small promo tile 440x280: `store/promo/small-440x280.png`.
- Marquee 1400x560: `store/promo/marquee-1400x560.png`.
- Editable copy, capture workflow and provenance: `store/README.md`.
- Review sheet: `store/review/contact-sheet.png`. This is not an upload image.
- Reviewer setup and task steps: `store/review/test-instructions.txt`, also saved
  in the dashboard's Test instructions field.
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
