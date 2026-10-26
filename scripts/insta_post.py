#!/usr/bin/env python3
"""
Build an Instagram carousel from phone photos of toploadered cards on stands.

    python scripts/insta_post.py ~/Downloads/IMG_98{17..22}.HEIC --cover ~/Downloads/IMG_9816.HEIC

Each card photo is cropped to 1080x1350 (4:5) so the toploader is the same size
and in the same spot on every slide, so the card never moves as the viewer
swipes. The toploader is the anchor because it is a fixed 3"x4" object; its
sides and top edge give scale and position even though the stand hides the
bottom. The optional --cover (boxes or packs) is cropped around the product
instead, since it is not card-shaped. A card used as the cover is just passed
first among the photos.

Raw cards in 3x4 toploaders only for now. Slabs will need their own aspect ratio.

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
from PIL import Image, ImageOps

try:
    from pillow_heif import register_heif_opener

    register_heif_opener()
except ImportError:  # HEIC unsupported, JPEG/PNG still fine
    pass

CANVAS_W, CANVAS_H = 1080, 1350
TOPLOADER_RATIO = 4 / 3  # height / width of a 3"x4" toploader
WORK = 1000  # detection runs on a copy this many px on the long side
PHOTO_EXTS = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp"}


def load(path):
    """Open a photo upright (EXIF rotation applied) as RGB, keeping its ICC profile."""
    img = Image.open(path)
    icc = img.info.get("icc_profile")
    return np.asarray(ImageOps.exif_transpose(img).convert("RGB")), icc


def subject(rgb):
    """
    Bounding box (x, y, w, h) of the busiest region, at working resolution.

    The backdrop is a smooth gradient and the subject (printed card, product
    box) is dense with edges, so blurred gradient magnitude separates them
    regardless of backdrop colour or lighting. Returns the box, the gray image
    and the scale back to full resolution.
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
    if not contours:
        return None, gray, scale
    return cv2.boundingRect(max(contours, key=cv2.contourArea)), gray, scale


def peaks(profile, frac):
    """Local maxima of a 1-D profile that reach `frac` of its maximum."""
    p = np.convolve(profile, np.ones(3) / 3, "same")
    thr = frac * p.max()
    return [i for i in range(1, len(p) - 1) if p[i] >= thr and p[i] >= p[i - 1] and p[i] >= p[i + 1]]


def find_toploader(rgb):
    """
    Toploader (left, top, width) in full-resolution pixels, or None.

    Sides are the outermost strong vertical edges across the middle of the
    subject. The toploader's clear plastic edge is often fainter than the
    card's printed border just inside it, so a second, weaker pass looks a
    little further out for it. The top is the first strong horizontal edge
    between the sides.
    """
    box, gray, scale = subject(rgb)
    if box is None:
        return None
    x, y, w, h = box
    gx = np.abs(cv2.Sobel(gray, cv2.CV_32F, 1, 0))
    gy = np.abs(cv2.Sobel(gray, cv2.CV_32F, 0, 1))

    x0, x1 = max(0, x - int(0.15 * w)), min(gray.shape[1], x + w + int(0.15 * w))
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
    return left / scale, (y0 + top_peaks[0]) / scale, width / scale


def crop(rgb, cx, cy, crop_w):
    """
    4:5 window of width crop_w centred on (cx, cy), resized to the canvas.

    When the window runs past the photo (subject shot close or near an edge)
    the border pixels are repeated outward. The backdrop is a smooth gradient,
    so this reads as more backdrop rather than a visible band.
    """
    crop_h = crop_w * CANVAS_H / CANVAS_W
    left, top = int(round(cx - crop_w / 2)), int(round(cy - crop_h / 2))
    right, bottom = left + int(round(crop_w)), top + int(round(crop_h))
    H, W = rgb.shape[:2]
    pad = max(0, -left, -top, right - W, bottom - H)
    if pad:
        rgb = np.pad(rgb, ((pad, pad), (pad, pad), (0, 0)), mode="edge")
    window = rgb[top + pad:bottom + pad, left + pad:right + pad]
    return Image.fromarray(window).resize((CANVAS_W, CANVAS_H), Image.LANCZOS), pad > 0


def card_slide(rgb, toploader_width):
    """Slide with the toploader `toploader_width` px wide, centred on the canvas."""
    found = find_toploader(rgb)
    if found is None:
        return None, "no toploader found"
    left, top, width = found
    cx, cy = left + width / 2, top + width * TOPLOADER_RATIO / 2
    slide, padded = crop(rgb, cx, cy, width * CANVAS_W / toploader_width)
    return slide, "extended the backdrop past the photo edge" if padded else None


def cover_slide(rgb, fill=0.85):
    """Slide centred on the product, which fills `fill` of the frame."""
    box, _, scale = subject(rgb)
    if box is None:
        H, W = rgb.shape[:2]
        return crop(rgb, W / 2, H / 2, min(W, H * CANVAS_W / CANVAS_H))[0], "no product found"
    x, y, w, h = (np.array(box) / scale)
    crop_w = max(w, h * CANVAS_W / CANVAS_H) / fill
    H, W = rgb.shape[:2]
    crop_w = min(crop_w, W, H * CANVAS_W / CANVAS_H)  # cover never needs padding
    cx = np.clip(x + w / 2, crop_w / 2, W - crop_w / 2)
    cy = np.clip(y + h / 2, crop_w * CANVAS_H / CANVAS_W / 2, H - crop_w * CANVAS_H / CANVAS_W / 2)
    return crop(rgb, cx, cy, crop_w)[0], None


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
