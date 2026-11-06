# Developing the Foxl browser extension

[Back to the README](../README.md)

The working tree is a loadable Manifest V3 extension. There is no transpilation step and no runtime dependency installation.

## Run a checkout

1. Clone the repository.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Choose **Load unpacked** and select the repository root.
4. Run Foxl Desktop and open the extension's side panel.

After an edit, reload the extension from `chrome://extensions`. Reload a test page when you need its content scripts to be reinjected.

Use these debugging surfaces:

| Component | Where to inspect it |
| :--- | :--- |
| Service worker | Foxl's entry in `chrome://extensions` → **Inspect views: service worker** |
| Side panel | Right-click inside the panel → **Inspect** |
| Content scripts | The page's DevTools console |
| Connection | The extension's options page and its connection test |

The server URL defaults to the desktop app's local ports. A custom server URL is persisted in `chrome.storage.local`; clear it in the options page to return to discovery.

## Background capture and snapshot protocol (0.9)

The desktop still sends a `browser_command` with `requestId` and `data: { action, tabId, params }`.
The matching `browser_result` carries the same ID and a `data.success` result.

| Action | Parameters | Result |
| :--- | :--- | :--- |
| `screenshot` | No params for viewport; `clip: { x, y, width, height }` in viewport CSS pixels, or `fullPage: true` | PNG `dataUrl`, `captureMethod` (`"cdp"` for a background tab, `"visible-tab"` for the selected one, `"select-tab"` for the 0.8 fallback), CSS `viewport` and `captureRect`, actual pixel `image: { width, height }`, document ID |
| `get_accessibility_tree` | `snapshot: true`; optional `since`, `filter`, `depth`, `maxChars`, `maxLines` | `snapshotId`, `mode: "full" / "diff"`, text, URL/title/viewport, explicit truncation |
| `scroll` | Existing direction and amount (negative scrolls the other way) | Actual scroll position, without selecting the tab, and `rendered` once a background tab has been drawn |

## What a read cuts, downloads and pop-ups (0.11)

`extension_connected` carries `capabilities: ["read-marks", "read-text", "downloads", "tab-openers"]`
beside `version`; a desktop gates the new actions on these names. Every earlier build sends `{ version }` only.

| Action | Parameters | Result |
| :--- | :--- | :--- |
| `get_accessibility_tree` | As before | Each line shows at most 100 characters of an element's text and 200 of a field's value; a longer one ends on `…` and carries `clipped=100/<total>` or `clipped_value=200/<total>` (counted with whitespace collapsed). Under filter `all` a line not drawn carries `hidden`, one under `aria-hidden` carries `aria-hidden`. The answer adds `readMarks: 1`, `clippedElements: [{ ref, field: "name" / "value" / "option", chars, totalChars }]`, `hiddenElements`, `blockedPopups: [{ url, at }]` (window.open calls Chrome blocked, as the page reports them; the last 10) and, when the tab started any in the last ten minutes, `downloads`. A tab opened before the extension updated runs the old reader until it reloads, and its answer has no `readMarks`. |
| `read_text` | `refId`, optional `offset` (default 0), `maxChars` (default 4000, at most 20000) | `text` (the element's text content exactly, or an input's value; never a password or hidden field's), `offset`, `returnedChars`, `totalChars`, `nextOffset` (null at the end), `hidden` (`"hidden"`, `"aria-hidden"` or null) |
| `get_downloads` | Optional `tabId`, `since` (ms) | `granted: true` and `downloads: [{ id, tabId, file, source, mime, state, bytesReceived, totalBytes, error, danger, startedAt, endedAt }]` from Chrome's list of the last ten minutes, only those started within two minutes after Foxl acted in a tab on their site; the last 20. `downloads` is an optional permission, asked for on the options page: until the person allows it, `{ success: false, granted: false, error }` |
| `get_tabs` | As before | Each tab adds `openerTabId` (the tab that opened it, or null) |
| `switch_tab` | As before | Unchanged: it moves where commands without a `tabId` go (`focusedTabId`) and never selects the tab in Chrome's window |

## What a click or a key press did (0.12)

`capabilities` adds `"step-watch"`. A desktop sends `hold` and `chat` and reads `step` only when it is announced; an older build ignores them and never sends `step`. The design is the desktop's own browser's (foxl-ai/pilot `server/tools/browser-step-watch.ts`, after the train AL review and re-review of #6426).

| Action | Parameters | Result |
| :--- | :--- | :--- |
| `click`, `click_at`, `press_key`, and `type` with `submit: true` | As before, plus optional `hold: ["<digest>", ...]` (the forms the desktop's chat already sent; at most 50 are read) and `chat` (that chat's key) | As before. When the step sent a form or started a page load, the answer waits for it and adds `step: { settled, navigated, submitted, blocked, waitedMs, page }`, and `leftover` when there is one (below). When it did neither there is no wait and no `step`. |

**Only a form being sent, or a page load the step started, is waited for**, and only until its answer comes:
- **A page load.** A read sent here while a page load is under way reaches the old page, so the load is waited out: the tab stops loading, then the page it led to is read (`STEP_PAGE`). That page is a new one, or the same one for a download or a 204. Never more than 8 s.
- **A form the page sends itself with `fetch` / XHR.** Its requests' answers are waited for, then the page's first change after them, then 300 ms of quiet (at most 1.5 s more).
- **Never waited for:** a view a single-page app draws (`history.pushState`, or a link it intercepts with the Navigation API), a request, or a page that keeps changing.

**What counts as sent**: a submit the page let go, a page load that started, or a request with a body to the page's or the form's own origin, whenever in the step it starts. So a payment sent by `fetch` after an `await` counts, and an analytics hit to another host does not. A submit the page took over with nothing seen after it reads `unconfirmed`, never "not sent": its own check may have stopped it, or a payment provider's own frame may have sent it.

- `settled`:
  - `"answered"`: the answer came: a new page, or the page drew it;
  - `"no_page"`: the form was sent and the answer is no page (a download, a 204);
  - `"unconfirmed"` (above);
  - `"still_loading"`: still going at 8 s; read the page again, do not repeat the step;
  - `"blocked"`: a held form, below.
- `navigated`: a page load happened.
- `page`: `{ title, heading, text }` of the page after the step: the title (120 characters), the first `h1` (160) and the start of the page's text (300).
- `submitted` and `blocked`: `{ digest, host, action, label, summary }` for a POST form with no password field that is not a sign-in step (a field whose `autocomplete` holds `username`, `current-password` or `one-time-code`, foxl-ai/pilot #6550). `submitted` is set only for a form that was sent (never an unconfirmed one).
  - `action` is the form's path and `label` the submit control's own words;
  - `summary` holds up to eight `name: value` lines of the form's identity, each value cut at 60 characters, with runs of 12 or more digits shown as `...`.

**A form's identity** is made of these parts:
- its action, and the page it is on (path and query, without a link's tracking parameters);
- the person's choices in it: boxes ticked, options chosen, and amounts, dates and counts typed, or every answer when it holds only words;
- its stable hidden fields: a product id is one on Shopify and Amazon. A per-load token or state, and any value over 64 characters, are left out;
- the submit button's own name and value;
- its place among the page's POST forms to the same action.

The digest is FNV-1a over that identity. It is computed by the same source as the desktop's own browser (`DESCRIBE_FORM_SOURCE`, copied verbatim into `step-watch.js`), so a chat that uses both browsers matches; change both together. Both repositories pin the SHA-256 of that text, each line's surrounding whitespace removed (`scripts/step-watch-describe.test.mjs` here, `tests/step-watch-saved-sign-in.regression.test.mjs` in foxl-ai/pilot).

**The hold** stops a submit whose digest is in `hold` before the page's own handlers run, and reports it as `blocked`. Only a submit during the step is looked at: within 10 s of its start, and before it is read. A step whose action failed is read at once too, which ends it. So a form the person sends outside a step is never described and never stopped.

The service worker waits for a form's answer (`STEP_SETTLE`) at most `STEP_SETTLE_ANSWER_MS` (10.5 s) by its own timer, then reports `still_loading`: the page's loop runs on the page's timers, which do not run while the page shows a dialog and are throttled in a background tab.

**A step whose answer was never read** (the desktop stopped waiting) leaves its form in the page's `sessionStorage` (this chat only, same origin, 30 minutes). The next arm on that site holds it and returns it as `leftover`, for the desktop to record. Every described submit writes that record, and the next arm in that tab removes it; what leaves it is cut to a real description's shape and sizes, since the page can write the same key.

The page's requests are counted by `request-watch.js`, in the page's own world (`"world": "MAIN"`), because the content scripts' isolated world cannot see the page's `fetch` or `XMLHttpRequest`:
- It wraps them **only from a step's own submit until the step is read** (`foxl-step-requests`: `watch <origin>` / `unwatch`), then puts the page's own back (only if they are still ours).
- It passes every call through unchanged.
- It tells `step-watch.js` when a request starts and ends with a `foxl-request` event (`+<id>`, `+<id>!` for one that sends, `-<id>`).
- Nothing is hidden from the page. A page that dispatches the same events can at worst make a step wait longer, up to the bound.

A tab whose page cannot be armed (one loaded before the extension updated, a page without content scripts) runs the step as 0.11 did, with no `step`.

Capture supports HTTP(S) pages, and file pages with "Allow access to file URLs" on. The selected
tab of a window is captured with `tabs.captureVisibleTab`; only a background tab is attached to.
It checks the site-access grant using `scripting.executeScript`, hides its own overlay, and
detaches even on failure. An inaccessible page, navigation during capture, or deadline produces
a failure. A discarded tab is reloaded in the background first. When Chrome refuses the attach
(DevTools policy, another extension's frame in the page, an existing session) or the page is a PDF,
a viewport capture selects the tab briefly, as 0.8 did; a clip or full-page capture fails.
Chrome shows its "started debugging this browser" bar in every tab while attached, and for 5 s after. Crops must fit the viewport; full-page captures are
limited to 16,384 CSS pixels per dimension and 32 million CSS pixels.

The capture's pixel size can differ from both CSS size and `devicePixelRatio`.
If the desktop resizes an image to `W x H`, map image coordinates to viewport CSS
as `x = captureRect.x + imageX * captureRect.width / W` (and likewise for y).
Full-page coordinates outside the viewport require a scroll and fresh observation.

Snapshot defaults are `filter: "visible"`, `depth: 15`, `maxChars: 12000`, and
`maxLines: 200`. Send `since` only for an ID whose text is still in the caller's
context. A diff names `baseSnapshotId` and uses one-based line replacements;
no changes returns `(no changes)`. Another tab or document, changed options,
missing/expired baselines, and an uneconomical diff return full text.
Legacy requests without `snapshot: true` retain their existing response shape.
Old extensions ignore the added snapshot parameters, so desktops must accept
legacy full responses. Region and full-page requests require a 0.9 extension.

Clicks, keys, typing, and hover still use the existing synthetic input queue.
The debugger capture path is not an arbitrary browser-debugging bridge.

For maintainers with a desktop source checkout, its
`foxl/scripts/probe-browser-extension-parity.mjs` loads this real extension in
a temporary Chrome for Testing profile and runs the real desktop tool callback
against a local fixture. It records protocol metadata, page input events, pixels,
tab activation, snapshot differences, and failures after Chrome withholds site
access. Run it with `--extension /absolute/path/to/this/checkout --headed`.
The fixture proxy rejects other destinations, including installed Foxl discovery
ports. The probe changes no installed extension or real desktop data.

## Audit and build

With Node.js 20 or newer:

```sh
node scripts/audit.mjs
node scripts/build.mjs
```

The [audit](../scripts/audit.mjs) checks declared permissions against API use, network call sites, and remotely hosted executable code. The [build](../scripts/build.mjs) packages an explicit allowlist of extension files, including `LICENSE` and `NOTICE`.

Output:

```text
dist/
  foxl-browser-extension-<version>.zip
  foxl-browser-extension-latest.zip
  SHA256SUMS.txt
```

Versioned and `latest` archives contain the same bytes. Entries have stable ordering and timestamps and use ZIP's stored mode, avoiding compression-version differences. CI builds twice and compares the hashes.

README files and documentation artwork are outside the release allowlist.

## Compare a Chrome Web Store installation

Compare the installed version with its corresponding source revision. A checkout of a newer `main` can legitimately differ from an older installed extension.

First build and unpack the source archive:

```sh
node scripts/build.mjs
source_build="$(mktemp -d)"
unzip -q dist/foxl-browser-extension-latest.zip -d "$source_build"
```

Locate Chrome's installed extension directory. Its name includes the extension ID, `ijlihobebaeangjiacfomjdkhlpbmlhi`, and the installed version:

| OS | Chrome profile root |
| :--- | :--- |
| macOS | `~/Library/Application Support/Google/Chrome/` |
| Linux | `~/.config/google-chrome/` |
| Windows | `%LOCALAPPDATA%\Google\Chrome\User Data\` |

Under the relevant profile, look in `Extensions/<extension-id>/<version>/`. Compare that directory with the unpacked source:

```sh
installed_extension="/absolute/path/to/Extensions/ijlihobebaeangjiacfomjdkhlpbmlhi/version"
diff -ru "$source_build" "$installed_extension"
```

Chrome adds `_metadata/`, and store packaging can add `key` and `update_url` to `manifest.json`. Compare executable files separately from packaging metadata. Investigate differences in `src/`, `styles/`, HTML, or the manifest's permissions against the matching source revision.

This comparison checks an installed package. A reproducible local build alone does not establish what the store distributed.

## Regenerate icons

The editable artwork is [icons/icon.svg](../icons/icon.svg). Icon generation is the only task that needs the development dependency:

```sh
npm install
npm run icons
```

Review the generated sizes and artwork before committing the PNGs.

## Releases

The [release workflow](../.github/workflows/release.yml) owns ZIP packaging and GitHub Release publication. It also contains the Chrome Web Store upload path.

Before dispatching a release:

1. Update `manifest.json` with the intended version.
2. Add a dated `## vX.Y.Z` entry to [CHANGELOG.md](../CHANGELOG.md).
3. Land the change after CI passes.
4. Review the workflow's store-credential requirements before using its upload step.

```sh
gh workflow run release.yml -f version=X.Y.Z
```

The version input is checked against the manifest and changelog. The workflow rejects an existing tag.

Store copy, permission justifications, and data-use disclosure are maintained in [STORE-LISTING.md](../STORE-LISTING.md). Keep them consistent with the source, [README](../README.md), and [privacy details](../PRIVACY.md).
