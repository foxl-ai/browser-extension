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
