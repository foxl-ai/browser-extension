# Chrome Web Store artwork

All product imagery is captured from the loaded Foxl 0.10.0 development extension,
connected to the real Foxl Desktop 0.9.3 app. Requests were actually submitted and
answered on public NASA pages. No Chrome API substitute, invented conversation,
simulated website, or redrawn product interface is used.

## Capture and compose

1. Load the repository through Chrome’s **Load unpacked** flow and open Foxl Desktop.
2. Use a separate Chrome window containing public pages only. Set the extension to
   **Light** appearance. Keep the actual text and controls at their normal size.
3. Run the task. Verify its real result, current-page context, and connection state.
4. Capture the native Chrome window at 2x display scale. Retain the original bytes.
5. Inspect every capture for personal tabs, clipped text, hover obstructions, and
   stale UI. Store the reviewed originals in `source/captures/` and record their
   hashes, dimensions, source URLs, and rectangular crops in `provenance.json`.
6. Compose the gallery and promotional images:

```sh
python3 scripts/compose-store-artwork.py
```

A single image can be previewed without replacing the final assets:

```sh
python3 scripts/compose-store-artwork.py --preview 01-browser
```

The compositor crops and uniformly scales native pixels. It adds marketing text,
backgrounds, borders, and shadows around those pixels. It does not draw buttons,
replace message text, or reconstruct browser chrome. Page and side-panel regions
can be framed separately so that the interface remains readable. Each source is
identified in the capture manifest. The nebula image on slide 1 comes from the
same public page in the native welcome capture; its panel comes from the actual
completed summary capture. The navigation image pairs its completed response with
the same NASA mission page from the later follow-up capture.

The conversation panels preserve 16px body text at the 1280px upload size. Settings
uses a larger crop of the actual connection and appearance cards. The palette,
Geist font, neutral surfaces, and restrained blue accents follow Foxl. Product
logos are not repeated as decoration. All final images use Light appearance.

## Files

- `gallery.en.json`: order, marketing copy, captions, and capture names.
- `source/captures/`: reviewed native JPEG originals and provenance.
- `screenshots/en/`: five 1280 × 800 RGB PNG upload images.
- `promo/`: 440 × 280 small tile and 1400 × 560 marquee.
- `review/contact-sheet.png`: overview for visual review, never uploaded as a screenshot.
- `review/render-manifest.json`: source and output hashes.
- `review/foxl-chrome-store-artwork.zip`: local convenience bundle for upload.
- `QUALITY.md`: the release’s functional and visual checks.

The native screenshot tool returns JPEG. PNG export does not claim to recover
compression detail; the original resolution is retained for traceability. The
font is bundled locally under its SIL Open Font License in `brand/OFL.txt`.

## Review and submission

The previous fixture-based artwork and capture server have been retired. Never
reuse an older extracted upload folder. Generate and inspect the current seven
files, then upload screenshots in numerical order and promotional images into
their separate slots. The extension package for this redesign is **0.10.0**.

Check that all visible behavior matches the package, save the listing, submit it
for Chrome Web Store review, and verify the dashboard’s resulting review status.
Do not call a submission published before the dashboard confirms publication.
The artwork sources are excluded from the extension ZIP by the build allowlist.

Google’s current image requirements are documented at
https://developer.chrome.com/docs/webstore/images.
