# Chrome Web Store artwork

The gallery uses the shipping extension's HTML, CSS and JavaScript. The capture
server supplies a deterministic Chrome API fixture and example page data; it does
not redraw the side panel, change its styles, or connect to a running Foxl Desktop.
The example pages are local, functional demo pages, not customer accounts.

## Files

- `gallery.en.json`: gallery order, marketing copy and captions.
- `fixtures.json`: example requests, responses and page content.
- `source/`: the presentation template and Chrome API fixture.
- `screenshots/en/`: the five 1280 × 800 upload images.
- `promo/`: the 440 × 280 small tile and 1400 × 560 marquee.
- `review/`: contact sheet and source/asset manifest.

Start the local capture server from the repository root:

```sh
node scripts/store-preview.mjs
```

It binds only to `127.0.0.1` on an available port and prints the review URL. Visit
the links in that review page to inspect each artwork at its upload dimensions.
The server reads the shipping files directly, so a future UI change appears in
the next capture without maintaining a second interface.

Capture each artwork at the indicated size after
`html[data-artwork-ready="true"]` appears. Save the unmodified captures as
`review/captures/01-browser.jpg` through `05-desktop.jpg`, plus `small.jpg` and
`marquee.jpg`. PNG inputs with the same stems are supported too. Then export:

```sh
python3 scripts/finalize-store-artwork.py
```

This uses Pillow to decode and validate all seven inputs, export opaque RGB PNGs
without rescaling, and produce a contact sheet, source hashes and an upload ZIP.
The raw JPEGs returned by browser capture are local intermediates; PNG export
does not claim to restore image detail lost by that transport.

The Chrome APIs are substituted only on the capture routes. No service worker
runs there, no installed extension settings are changed, and no desktop ports or
personal Foxl data are accessed.

The image files and this directory are outside the release ZIP's allowlist.
Updating store artwork does not require a new extension version.

## Design and truthfulness

The design uses Foxl's official outlined logo and Geist typeface, with Ink, Paper,
Mist and Slate surfaces. Blue remains a small brand accent. The source assets
come from `foxl-ai/pilot/site/landing/public/brand/` and the shipped fonts.

Each screenshot says that Foxl Desktop is required. Example conversations use
only existing features: plain-text chat, page reading, tab context, form input,
and the actual activity indicator with its Stop Foxl button. They are illustrative
workflows, not claims about a measured model run. There are no fabricated reviews,
ratings, customer counts, provider promises or speed claims.

The fifth image includes the exact first-run state a person sees without the
desktop app. The screenshot set does not imply the extension works on its own.

## Store specifications

Checked on 2026-10-27 against Google's Chrome Web Store image documentation:
https://developer.chrome.com/docs/webstore/images

- Five screenshots, 1280 × 800, opaque RGB PNG.
- Small promotional tile, 440 × 280, opaque RGB PNG.
- Marquee promotional image, 1400 × 560, opaque RGB PNG.
- The promotional tiles communicate the brand with minimal copy.

Upload the numbered gallery in order. The small promotional tile and marquee go
in their own slots, not in the screenshot gallery. Keep the extension icon as the
shipping icon. Review the rendered files before submitting the listing update.
