#!/usr/bin/env python3
"""Validate reviewed browser captures and export the seven store upload images.

Requires Pillow. Uses only local files. Does not resize screenshots or alter UI.
Run from any directory: python3 scripts/finalize-store-artwork.py [CAPTURE_DIR]
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import subprocess
import sys
from zipfile import ZipFile, ZIP_DEFLATED

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
STORE = ROOT / "store"
CAPTURES = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else STORE / "review/captures"
copy = json.loads((STORE / "gallery.en.json").read_text())
specs = [
    (slide["id"], STORE / "screenshots/en" / f'{slide["id"]}.png', (1280, 800))
    for slide in copy["slides"]
] + [
    ("small", STORE / "promo/small-440x280.png", (440, 280)),
    ("marquee", STORE / "promo/marquee-1400x560.png", (1400, 560)),
]


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


# Validate every input before replacing any final file. A browser screenshot
# adapter may return JPEG or PNG; decode the content, never infer it from a suffix.
images = []
for name, destination, size in specs:
    source = next((p for p in [CAPTURES / f"{name}.png", CAPTURES / f"{name}.jpg"] if p.exists()), None)
    if source is None:
        raise SystemExit(f"Missing reviewed capture: {name}")
    with Image.open(source) as image:
        image.load()
        if image.size != size:
            raise SystemExit(f"{source.name}: {image.size}, expected {size}; recapture at the right size")
        images.append((source, destination, image.convert("RGB")))

manifest = {
    "extensionVersion": json.loads((ROOT / "manifest.json").read_text())["version"],
    "uiCommit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
    "locale": copy["locale"],
    "captureMethod": "Browser capture of shipping HTML/CSS/JS with a local Chrome transport fixture",
    "content": "Illustrative local workflows; no personal accounts, real model run or customer data",
    "framing": "Marketing copy and decorative browser frames surround the unchanged side-panel UI",
    "sources": {},
    "assets": [],
}

source_paths = [
    "manifest.json", "sidepanel.html", "styles/sidepanel.css", "src/sidepanel.js",
    "src/content-scripts/visual-indicator.js", "icons/icon.svg",
    "store/gallery.en.json", "store/fixtures.json", "scripts/store-preview.mjs",
    "store/source/runtime-fixture.js", "store/source/demo-page.html",
    "store/source/artwork.html", "store/source/artwork.css",
]
source_paths += [str(p.relative_to(ROOT)) for p in sorted((STORE / "brand").iterdir()) if p.is_file()]
for relative in source_paths:
    manifest["sources"][relative] = digest(ROOT / relative)

for source, destination, image in images:
    destination.parent.mkdir(parents=True, exist_ok=True)
    image.save(destination, format="PNG", optimize=True)
    with Image.open(destination) as verified:
        verified.load()
        if verified.mode != "RGB" or verified.size != image.size:
            raise SystemExit(f"Export validation failed: {destination.name}")
    manifest["assets"].append({
        "file": str(destination.relative_to(ROOT)),
        "width": image.width,
        "height": image.height,
        "format": "PNG",
        "mode": "RGB",
        "bytes": destination.stat().st_size,
        "sha256": digest(destination),
        "captureSha256": digest(source),
    })

review = STORE / "review"
review.mkdir(exist_ok=True)
(review / "render-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")

# Six cells: five gallery images at the store's 640 × 400 presentation size,
# followed by the promotional tile and marquee. Full-resolution exports remain
# untouched. The review sheet is never uploaded as a gallery screenshot.
sheet = Image.new("RGB", (1320, 1350), "#e9eaed")
draw = ImageDraw.Draw(sheet)
font = ImageFont.load_default(size=14)
for index, (_, _, image) in enumerate(images[:5]):
    x, y = 10 + index % 2 * 660, 36 + index // 2 * 450
    draw.text((x + 2, y - 25), f'{index + 1:02d} / {copy["slides"][index]["id"].split("-", 1)[1]}', font=font, fill="#646974")
    sheet.paste(image.resize((640, 400), Image.Resampling.LANCZOS), (x, y))
x, y = 670, 936
draw.text((x + 2, y - 25), "Promotional images", font=font, fill="#646974")
small = images[5][2]
sheet.paste(small.resize((220, 140), Image.Resampling.LANCZOS), (x + 210, y + 4))
marquee = images[6][2]
sheet.paste(marquee.resize((640, 256), Image.Resampling.LANCZOS), (x, y + 149))
sheet.save(review / "contact-sheet.png", optimize=True)

upload_note = """Foxl Chrome Web Store artwork

Screenshots: upload screenshots/en/01 through 05 in numerical order.
Small promotional tile: promo/small-440x280.png
Marquee promotional image: promo/marquee-1400x560.png

Keep the existing extension icon. The imagery requires no package or version change.
The UI is the shipping 0.9.0 side panel; the workflows use illustrative local data.
Review the listing changes and submit them through the store's normal review flow.
"""
with ZipFile(review / "foxl-chrome-store-artwork.zip", "w", ZIP_DEFLATED) as archive:
    for _, destination, _ in images:
        archive.write(destination, destination.relative_to(STORE))
    archive.writestr("UPLOAD.txt", upload_note)
    archive.write(review / "render-manifest.json", "render-manifest.json")

print(json.dumps({"validated": len(images), "contactSheet": str(review / "contact-sheet.png"),
                  "uploadBundle": str(review / "foxl-chrome-store-artwork.zip")}, indent=2))
