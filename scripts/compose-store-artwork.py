#!/usr/bin/env python3
"""Compose reviewed native captures. Never draw UI or substitute response data.

Run: python3 scripts/compose-store-artwork.py [--preview SLIDE_ID]
Requires Pillow and fontTools. Uses local files only.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile
from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[1]
STORE = ROOT / "store"
CAPTURES = STORE / "source/captures"
REVIEW = STORE / "review"
SCALE = 2
INK, MUTED, BLUE = "#23262b", "#666b73", "#274f98"
PAPER, MIST = "#ffffff", "#f4f6f9"
SPEC = json.loads((STORE / "gallery.en.json").read_text())
PROVENANCE = json.loads((CAPTURES / "provenance.json").read_text())
PANEL_RECT = (2258, 254, 3008, 1648)
SETTINGS_RECT = (842, 342, 2142, 1450)
FONT_PATH = ROOT / ".store-research/Geist-artwork.ttf"
FONT_PATH.parent.mkdir(exist_ok=True)
if not FONT_PATH.exists():
    face = TTFont(STORE / "brand/Geist-Variable-latin.woff2")
    face.flavor = None
    face.save(FONT_PATH)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def font(size, weight=400):
    face = ImageFont.truetype(str(FONT_PATH), round(size * SCALE))
    face.set_variation_by_axes([weight])
    return face


def text(image, xy, value, size=22, weight=400, fill=INK):
    ImageDraw.Draw(image).text(tuple(round(p * SCALE) for p in xy), value,
                              font=font(size, weight), fill=fill, anchor="lt")


def lines(image, xy, values, size, step, weight=400, fill=INK):
    for i, value in enumerate(values):
        text(image, (xy[0], xy[1] + i * step), value, size, weight, fill)


def wordmark(image, xy, size=25, icon=False):
    x, y = xy
    if icon:
        mark = Image.open(ROOT / "icons/icon-128.png").convert("RGBA")
        mark = mark.resize((round(size * SCALE), round(size * SCALE)), Image.Resampling.LANCZOS)
        image.paste(mark, (round(x * SCALE), round(y * SCALE)), mark)
        x += size + 10
    text(image, (x, y), "Foxl", size, 600)


def capture(name):
    path = CAPTURES / name
    record = PROVENANCE["captures"].get(name)
    if not record or not path.exists():
        raise ValueError(f"Missing reviewed native capture: {name}")
    if sha(path) != record["sha256"]:
        raise ValueError(f"Capture changed after review: {name}")
    image = Image.open(path).convert("RGB")
    if list(image.size) != record["size"]:
        raise ValueError(f"Unexpected capture size: {name}")
    return image


def card(image, pixels, box, radius=20, shadow=True):
    """Frame a real rectangular capture without drawing inside its interface."""
    x, y, width, height = box
    dest = tuple(round(n * SCALE) for n in (x, y, x + width, y + height))
    if shadow:
        shade = Image.new("RGBA", image.size)
        ImageDraw.Draw(shade).rounded_rectangle(
            (dest[0], dest[1] + 8 * SCALE, dest[2], dest[3] + 8 * SCALE),
            radius=radius * SCALE, fill=(26, 36, 58, 24))
        image.alpha_composite(shade.filter(ImageFilter.GaussianBlur(16 * SCALE)))
    resized = pixels.resize((round(width * SCALE), round(height * SCALE)), Image.Resampling.LANCZOS)
    mask = Image.new("L", resized.size)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, resized.width - 1, resized.height - 1), radius=radius * SCALE, fill=255)
    image.paste(resized, (dest[0], dest[1]), mask)
    ImageDraw.Draw(image).rounded_rectangle(dest, radius=radius * SCALE, outline="#e0e4ea", width=SCALE)


def page_crop(name):
    return capture(name).crop(PROVENANCE["captures"][name]["pageCrop"])


def gallery(slide):
    image = Image.new("RGBA", (1280 * SCALE, 800 * SCALE), PAPER)
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((818 * SCALE, 24 * SCALE, 1256 * SCALE, 760 * SCALE),
                           radius=32 * SCALE, fill=MIST)
    wordmark(image, (48, 47))
    text(image, (48, 120), slide["eyebrow"], 13, 550, BLUE)
    lines(image, (48, 164), slide["headline"], 60 if slide["layout"] == "settings" else 56, 65, 550)
    lines(image, (50, 315), slide["description"], 23, 34, 400, MUTED)
    if slide["layout"] == "settings":
        draw.rectangle((560 * SCALE, 0, 1280 * SCALE, 800 * SCALE), fill=PAPER)
        pixels = capture(slide["capture"]).crop(SETTINGS_RECT)
        card(image, pixels, (580, 144, 650, 650 * pixels.height / pixels.width), radius=24)
    else:
        pixels = capture(slide["capture"]).crop(PANEL_RECT)
        # Native capture is 2x. 375 CSS pixels remain 375px in the upload:
        # 16px conversation text is not shrunk with a whole desktop.
        card(image, pixels, (850, 44, 375, 697), radius=22)
        if slide["layout"] == "page-and-panel":
            source = slide.get("pageCapture", slide["capture"])
            page = page_crop(source)
            card(image, page, (48, 418, 720, 720 * page.height / page.width), radius=18)
            credit = "NASA / ESA / CSA / STScI" if source == "welcome.jpg" else "NASA Science"
            text(image, (49, 711), f"{credit} · Actual Foxl session", 13, 400, MUTED)
        else:
            lines(image, (50, 455), ["Understand the page.", "Find the useful details.", "Take the next step."],
                  26, 49, 450)
            draw.line((50 * SCALE, 624 * SCALE, 736 * SCALE, 624 * SCALE), fill="#e1e5ec", width=SCALE)
            text(image, (50, 651), "Your current page. One clear message.", 19, 400, MUTED)
    text(image, (48, 749), SPEC["requirement"], 15, 500, MUTED)
    text(image, (1194, 769), slide["id"][:2], 12, 450, MUTED)
    return image


def small_tile():
    image = Image.new("RGBA", (440 * SCALE, 280 * SCALE), PAPER)
    wordmark(image, (27, 24), 30, icon=True)
    lines(image, (26, 82), ["Less busywork.", "More doing."], 34, 41, 550)
    crop = capture("welcome.jpg").crop((2280, 1490, 2994, 1630))
    image.paste(crop, (42 * SCALE, 196 * SCALE))
    return image


def marquee():
    image = Image.new("RGBA", (1400 * SCALE, 560 * SCALE), PAPER)
    wordmark(image, (64, 48), 32, icon=True)
    text(image, (66, 130), "YOUR BROWSER, WITH FOXL", 14, 550, BLUE)
    lines(image, (61, 177), ["A little less", "busywork."], 72, 79, 550)
    lines(image, (66, 373), ["Your desktop agent,", "right beside the page."], 27, 38, 400, MUTED)
    text(image, (66, 502), SPEC["requirement"], 16, 500, MUTED)
    crop = capture("welcome.jpg").crop((2258, 536, 3008, 1648))
    card(image, crop, (960, 2, 375, 556), radius=24)
    return image


def export(image, path, size):
    path.parent.mkdir(parents=True, exist_ok=True)
    image.convert("RGB").resize(size, Image.Resampling.LANCZOS).save(path, optimize=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--preview")
    opts = parser.parse_args()
    if opts.preview:
        slide = next(s for s in SPEC["slides"] if s["id"] == opts.preview)
        output = ROOT / ".store-research" / f'{slide["id"]}-draft.png'
        export(gallery(slide), output, (1280, 800))
        print(output)
        return
    for slide in SPEC["slides"]:
        capture(slide["capture"])
    assets = [(STORE / f'screenshots/en/{s["id"]}.png', gallery(s), (1280, 800)) for s in SPEC["slides"]]
    assets += [(STORE / "promo/small-440x280.png", small_tile(), (440, 280)),
               (STORE / "promo/marquee-1400x560.png", marquee(), (1400, 560))]
    for path, pixels, size in assets:
        export(pixels, path, size)
    manifest = {
        "extensionVersion": SPEC["version"], "theme": "light",
        "captureMethod": "Native macOS Chrome window screenshots of the loaded extension connected to Foxl Desktop",
        "interface": "Real pixels: crop and uniform scale only; no response fixtures or UI reconstruction",
        "composition": "Marketing headlines, backgrounds, borders and shadows outside the captures",
        "panelScale": "375 CSS-pixel panel at 375 pixels in the 1280x800 gallery",
        "captureProvenance": PROVENANCE, "sources": {}, "assets": [],
    }
    for folder in ("src", "styles"):
        for path in sorted((ROOT / folder).rglob("*")):
            if path.is_file():
                manifest["sources"][str(path.relative_to(ROOT))] = sha(path)
    for name in ("manifest.json", "sidepanel.html", "options.html", "store/gallery.en.json", "scripts/compose-store-artwork.py"):
        manifest["sources"][name] = sha(ROOT / name)
    for path, _, size in assets:
        manifest["assets"].append({"file": str(path.relative_to(ROOT)), "size": size, "mode": "RGB", "sha256": sha(path)})
    REVIEW.mkdir(exist_ok=True)
    (REVIEW / "render-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    sheet = Image.new("RGB", (1320, 1320), "#e9edf3")
    for i, (_, pixels, _) in enumerate(assets[:5]):
        sheet.paste(pixels.convert("RGB").resize((640, 400), Image.Resampling.LANCZOS),
                    (10 + i % 2 * 660, 10 + i // 2 * 440))
    sheet.paste(assets[5][1].convert("RGB").resize((220, 140), Image.Resampling.LANCZOS), (880, 894))
    sheet.paste(assets[6][1].convert("RGB").resize((640, 256), Image.Resampling.LANCZOS), (670, 1048))
    sheet.save(REVIEW / "contact-sheet.png", optimize=True)
    with ZipFile(REVIEW / "foxl-chrome-store-artwork.zip", "w", ZIP_DEFLATED) as bundle:
        for path, _, _ in assets:
            bundle.write(path, path.relative_to(STORE))
        bundle.write(REVIEW / "render-manifest.json", "render-manifest.json")
        bundle.writestr("UPLOAD.txt", "Upload the five numbered screenshots in order, then the two promotional images.\n"
                        "Use extension package 0.10.0. All images use real native captures in light appearance.\n")
    print(json.dumps({"images": len(assets), "review": str(REVIEW / "contact-sheet.png")}, indent=2))


if __name__ == "__main__":
    main()
