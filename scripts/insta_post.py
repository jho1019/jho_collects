#!/usr/bin/env python3
"""
Build an Instagram carousel from phone photos of toploadered cards on stands.

    python scripts/insta_post.py ~/Downloads/IMG_98{17..22}.HEIC --cover ~/Downloads/IMG_9816.HEIC

Each card photo is cropped to 1080x1350 (4:5) so the toploader is the same size
and in the same spot on every slide, so the card never moves as the viewer
swipes. The toploader is the anchor because it is a fixed 3"x4" object; its
sides and top edge give scale and position even though the stand hides the
bottom. Two or more cards in one photo are centred as a group, shrunk evenly
only if they would not otherwise fit. The optional --cover (boxes or packs) is cropped around the product
instead, since it is not card-shaped. A card used as the cover is just passed
first among the photos.

Raw cards in 3x4 toploaders only for now. Slabs will need their own aspect ratio.

Every slide gets a small translucent "@shotime_cards" along the bottom
(--watermark "" to leave it off).

Writes NN.jpg slides plus preview.jpg (a contact sheet) into a new
instagram-<timestamp>/ folder next to the photos. Deps: opencv-python-headless,
pillow, pillow-heif, numpy.
"""

import argparse
import os
import sys
from datetime import datetime

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageOps

try:
    from pillow_heif import register_heif_opener

    register_heif_opener()
except ImportError:  # HEIC unsupported, JPEG/PNG still fine
    pass

CANVAS_W, CANVAS_H = 1080, 1350
TOPLOADER_RATIO = 4 / 3  # height / width of a 3"x4" toploader
GROUP_MARGIN = 70  # px each side when several cards are shrunk to fit
WORK = 1000  # detection runs on a copy this many px on the long side
PHOTO_EXTS = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp"}
WATERMARK = "@shotime_cards"
WATERMARK_SIZE, WATERMARK_BOTTOM = 34, 70  # font px; px from the text's top to the slide's bottom
FONTS = ["/System/Library/Fonts/Helvetica.ttc", "arial.ttf", "DejaVuSans.ttf"]


def load(path):
    """Open a photo upright (EXIF rotation applied) as RGB, keeping its ICC profile."""
    img = Image.open(path)
    icc = img.info.get("icc_profile")
    return np.asarray(ImageOps.exif_transpose(img).convert("RGB")), icc


def subjects(rgb):
    """
    Bounding boxes (x, y, w, h) of the busy regions, largest first, at working
    resolution. A card with big plain areas can break into overlapping pieces,
    so overlapping boxes are merged back into one. Boxes under a third the
    size of the largest (stray glare) are dropped.

    The backdrop is a smooth gradient and the subject (printed card, product
    box) is dense with edges, so blurred gradient magnitude separates them
    regardless of backdrop colour or lighting. Returns the boxes, the gray
    image and the scale back to full resolution.
    """
    scale = WORK / max(rgb.shape[:2])
    small = cv2.resize(rgb, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(small, cv2.COLOR_RGB2GRAY).astype(np.float32)
    mag = cv2.magnitude(cv2.Sobel(gray, cv2.CV_32F, 1, 0), cv2.Sobel(gray, cv2.CV_32F, 0, 1))
    busy = cv2.blur(mag, (25, 25))
    busy = np.clip(busy / np.percentile(busy, 99.5) * 255, 0, 255).astype(np.uint8)
    _, mask = cv2.threshold(busy, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((15, 15), np.uint8))
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    boxes = merge_overlapping([cv2.boundingRect(c) for c in contours])
    boxes.sort(key=lambda b: b[2] * b[3], reverse=True)
    return [b for b in boxes if b[2] * b[3] >= boxes[0][2] * boxes[0][3] / 3], gray, scale


def merge_overlapping(boxes):
    boxes = list(boxes)
    merged = True
    while merged:
        merged = False
        for i in range(len(boxes)):
            for j in range(i + 1, len(boxes)):
                (ax, ay, aw, ah), (bx, by, bw, bh) = boxes[i], boxes[j]
                if ax < bx + bw and bx < ax + aw and ay < by + bh and by < ay + ah:
                    x, y = min(ax, bx), min(ay, by)
                    boxes[i] = (x, y, max(ax + aw, bx + bw) - x, max(ay + ah, by + bh) - y)
                    del boxes[j]
                    merged = True
                    break
            if merged:
                break
    return boxes


def peaks(profile, frac):
    """Local maxima of a 1-D profile that reach `frac` of its maximum."""
    p = np.convolve(profile, np.ones(3) / 3, "same")
    thr = frac * p.max()
    return [i for i in range(1, len(p) - 1) if p[i] >= thr and p[i] >= p[i - 1] and p[i] >= p[i + 1]]


def find_toploaders(rgb):
    """
    Each toploader as (left, top, width) in full-resolution pixels, left to
    right. Empty when none is found.

    Toploaders standing nearly touching read as one subject, so a subject
    about n toploader-widths wide (a toploader is 3/4 as wide as tall) is
    split into n equal columns, each searched on its own. Within a column,
    sides are the outermost strong vertical edges across the middle of the
    subject. The toploader's clear plastic edge is often fainter than the
    card's printed border just inside it, so a second, weaker pass looks a
    little further out for it. The top is the first strong horizontal edge
    between the sides.
    """
    boxes, gray, scale = subjects(rgb)
    gx = np.abs(cv2.Sobel(gray, cv2.CV_32F, 1, 0))
    gy = np.abs(cv2.Sobel(gray, cv2.CV_32F, 0, 1))
    found = []
    for x, y, w, h in boxes:
        n = max(1, round(w / (h / TOPLOADER_RATIO)))
        step = w / n
        pad = int(0.15 * step)  # outer sides only: never reach into a neighbour
        for i in range(n):
            x0 = int(x + i * step) - (pad if i == 0 else 0)
            x1 = int(x + (i + 1) * step) + (pad if i == n - 1 else 0)
            found.append(toploader_in(max(0, x0), min(gx.shape[1], x1), y, h, gx, gy))
    return sorted(tuple(v / scale for v in f) for f in found if f is not None)


def toploader_in(x0, x1, y, h, gx, gy):
    """(left, top, width) of the toploader between columns x0 and x1, or None."""
    col = gx[y + h // 4:y + h // 2, x0:x1].sum(0)
    strong, weak = peaks(col, 0.35), peaks(col, 0.12)
    if len(strong) < 2:
        return None
    left, right = strong[0], strong[-1]
    reach = 0.12 * (right - left)
    left = min([q for q in weak if q >= left - reach] + [left]) + x0
    right = max([q for q in weak if q <= right + reach] + [right]) + x0
    width = right - left

    y0 = max(0, y - int(0.4 * width))
    row = gy[y0:y + h // 2, left + width // 5:right - width // 5].sum(1)
    top_peaks = peaks(row, 0.35)
    if not top_peaks:
        return None
    return left, y0 + top_peaks[0], width


def crop(rgb, cx, cy, crop_w):
    """
    4:5 window of width crop_w centred on (cx, cy), resized to the canvas.

    When the window runs past the photo (subject shot close or near an edge)
    the photo is mirrored outward at its edge. The backdrop is a smooth gradient,
    so this reads as more backdrop rather than a visible band.
    """
    crop_h = crop_w * CANVAS_H / CANVAS_W
    left, top = int(round(cx - crop_w / 2)), int(round(cy - crop_h / 2))
    right, bottom = left + int(round(crop_w)), top + int(round(crop_h))
    H, W = rgb.shape[:2]
    pad = max(0, -left, -top, right - W, bottom - H)
    if pad:
        rgb = np.pad(rgb, ((pad, pad), (pad, pad), (0, 0)), mode="reflect")
    window = rgb[top + pad:bottom + pad, left + pad:right + pad]
    return Image.fromarray(window).resize((CANVAS_W, CANVAS_H), Image.LANCZOS), pad > 0


def card_slide(rgb, toploader_width):
    """
    Slide with each toploader `toploader_width` px wide, the group centred.

    Several cards in one photo are framed as one group: centred together, at
    the single-card size when they fit, otherwise shrunk evenly until the
    group spans the canvas less GROUP_MARGIN a side. The vertical centre is
    the same as a single card's, so the eye line holds across slides.
    """
    found = find_toploaders(rgb)
    if not found:
        return None, "no toploader found"
    lefts, tops, widths = np.array(found).T
    group_w = (lefts + widths).max() - lefts.min()
    px = min(toploader_width / widths.mean(), (CANVAS_W - 2 * GROUP_MARGIN) / group_w)
    cx = (lefts.min() + (lefts + widths).max()) / 2
    cy = (tops + widths * TOPLOADER_RATIO / 2).mean()
    slide, padded = crop(rgb, cx, cy, CANVAS_W / px)
    return slide, "extended the backdrop past the photo edge" if padded else None


def cover_slide(rgb, fill=0.85):
    """Slide centred on the product, which fills `fill` of the frame."""
    boxes, _, scale = subjects(rgb)
    if not boxes:
        H, W = rgb.shape[:2]
        return crop(rgb, W / 2, H / 2, min(W, H * CANVAS_W / CANVAS_H))[0], "no product found"
    x, y, w, h = (np.array(boxes[0]) / scale)
    crop_w = max(w, h * CANVAS_W / CANVAS_H) / fill
    H, W = rgb.shape[:2]
    crop_w = min(crop_w, W, H * CANVAS_W / CANVAS_H)  # cover never needs padding
    cx = np.clip(x + w / 2, crop_w / 2, W - crop_w / 2)
    cy = np.clip(y + h / 2, crop_w * CANVAS_H / CANVAS_W / 2, H - crop_w * CANVAS_H / CANVAS_W / 2)
    return crop(rgb, cx, cy, crop_w)[0], None


def font():
    for path in FONTS:
        try:
            return ImageFont.truetype(path, WATERMARK_SIZE)
        except OSError:
            continue
    return ImageFont.load_default(WATERMARK_SIZE)


def watermark(slide, text):
    """`text` in translucent white, centred near the bottom of the slide."""
    f = font()
    layer = Image.new("RGBA", slide.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    x = (CANVAS_W - draw.textlength(text, font=f)) / 2
    draw.text((x, CANVAS_H - WATERMARK_BOTTOM), text, font=f, fill=(255, 255, 255, 180))
    return Image.alpha_composite(slide.convert("RGBA"), layer).convert("RGB")


def contact_sheet(slides):
    cols, tw, gap = min(5, len(slides)), 216, 8
    th = tw * CANVAS_H // CANVAS_W
    rows = -(-len(slides) // cols)
    sheet = Image.new("RGB", (cols * (tw + gap) + gap, rows * (th + gap) + gap), (128, 128, 128))
    for i, s in enumerate(slides):
        sheet.paste(s.resize((tw, th), Image.LANCZOS),
                    (gap + (i % cols) * (tw + gap), gap + (i // cols) * (th + gap)))
    return sheet


def expand(paths, exclude):
    out = []
    for p in paths:
        if os.path.isdir(p):
            out += sorted(os.path.join(p, f) for f in os.listdir(p)
                          if os.path.splitext(f)[1].lower() in PHOTO_EXTS)
        else:
            out.append(p)
    return [p for p in out if not exclude or not os.path.samefile(p, exclude)]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("photos", nargs="*", help="card photos or a folder, in slide order")
    ap.add_argument("--cover", help="box/pack photo for slide 1 (cropped around the product)")
    ap.add_argument("--toploader-width", type=int, default=680,
                    help="toploader width in px on the 1080px canvas (default 680)")
    ap.add_argument("--watermark", default=WATERMARK,
                    help=f'text along the bottom of every slide (default "{WATERMARK}"; "" for none)')
    ap.add_argument("--out", help="output folder (default: instagram-<timestamp> beside the photos)")
    args = ap.parse_args()

    photos = expand(args.photos, args.cover)
    if not photos and not args.cover:
        sys.exit("no photos found")
    first = args.cover or photos[0]
    out = args.out or os.path.join(os.path.dirname(os.path.abspath(first)),
                                   "instagram-" + datetime.now().strftime("%Y%m%d-%H%M%S"))
    os.makedirs(out, exist_ok=True)

    slides, problems = [], 0
    jobs = ([("cover", args.cover)] if args.cover else []) + [("card", p) for p in photos]
    for kind, path in jobs:
        rgb, icc = load(path)
        slide, warn = cover_slide(rgb) if kind == "cover" else card_slide(rgb, args.toploader_width)
        name = os.path.basename(path)
        if slide is None:
            problems += 1
            print(f"SKIP  {name}: {warn}")
            continue
        n = len(slides) + 1
        if args.watermark:
            slide = watermark(slide, args.watermark)
        slide.save(os.path.join(out, f"{n:02d}.jpg"), quality=95, icc_profile=icc)
        slides.append(slide)
        problems += bool(warn)
        print(f"{n:02d}    {name} ({kind})" + (f"  WARNING: {warn}" if warn else ""))

    if slides:
        contact_sheet(slides).save(os.path.join(out, "preview.jpg"), quality=90)
    print(f"\n{len(slides)} slides -> {out}" + (f"  ({problems} need a look)" if problems else ""))
    if len(slides) > 20:
        print("Instagram carousels hold at most 20 slides.")


if __name__ == "__main__":
    main()
