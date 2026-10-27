#!/usr/bin/env python3
"""Export unaltered Light-mode product crops for the README.

Run: python3 scripts/export-readme-images.py
Requires Pillow. Uses only the reviewed native captures already in this repo.
"""
import hashlib
import json
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
CAPTURES = ROOT / "store/source/captures"
OUTPUT = ROOT / "assets/readme"
PROVENANCE = json.loads((CAPTURES / "provenance.json").read_text())
EXPORTS = [
    ("conversation-light.png", "follow-up.jpg", (2258, 254, 3008, 1648), 375),
    ("settings-light.png", "settings.jpg", (842, 342, 2142, 1450), 650),
]

if PROVENANCE["appearance"] != "Light":
    raise ValueError("README images must use the approved Light captures")

OUTPUT.mkdir(parents=True, exist_ok=True)
records = []
for filename, source, rectangle, display_width in EXPORTS:
    source_path = CAPTURES / source
    expected = PROVENANCE["captures"][source]
    source_hash = hashlib.sha256(source_path.read_bytes()).hexdigest()
    if source_hash != expected["sha256"]:
        raise ValueError(f"Reviewed capture changed: {source}")
    with Image.open(source_path) as image:
        if list(image.size) != expected["size"]:
            raise ValueError(f"Unexpected dimensions: {source}")
        pixels = image.convert("RGB").crop(rectangle)
        output = OUTPUT / filename
        pixels.save(output, optimize=True)
        records.append({
            "file": str(output.relative_to(ROOT)),
            "source": str(source_path.relative_to(ROOT)),
            "sourceSha256": source_hash,
            "crop": rectangle,
            "size": pixels.size,
            "displayWidth": display_width,
            "sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
        })

(OUTPUT / "captures.json").write_text(json.dumps({
    "extensionVersion": PROVENANCE["extensionVersion"],
    "appearance": "Light",
    "method": "Rectangular crop of the original native capture; no resizing or UI edits.",
    "images": records,
}, indent=2) + "\n")
print(json.dumps(records, indent=2))
