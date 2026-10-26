---
name: insta-post
description: Turn phone photos of cards (toploader on a stand, dark backdrop) into an Instagram carousel where every card sits at the exact same size and spot, so the card doesn't move as the viewer swipes. Use when the user says "make an insta post", "make my IG carousel", "crop these for Instagram", or drops/attaches card photos (often .HEIC) and asks for a post. Not for listing photos on eBay, and not for recording a rip in the ledger (that's card-entry).
---

# Instagram carousel

`scripts/insta_post.py` does all the image work. This skill gathers the
inputs, runs it, and checks the result before handing it over.

## How the photos are shot

Raw cards in 3"x4" toploaders on clear stands, in front of a dark gradient
backdrop, from an iPhone (HEIC). The script anchors on the **toploader**,
not the card: the toploader is a fixed 3x4 size, and its sides and top edge
give scale and position even though the stand hides its bottom. Each slide is
a crop of the original photo, so the backdrop, stand and reflections stay real.

**Two (or more) cards in one photo** are handled automatically. The
toploaders are found individually, then framed as a group centred on the
slide, with the same vertical centre as single-card slides. They keep the
single-card size if they fit; otherwise they shrink evenly until the group
spans the slide with a small margin on each side. A pair therefore looks
smaller than a single card. That's expected, so don't "fix" it.

Slabs are not supported yet. They have a different shape (taller, with a label)
and will need their own ratio in the script. If the user sends slab photos, say
so instead of running the script.

## Step 1: Gather the photos and the order

- Photos usually arrive as `@/Users/.../IMG_1234.HEIC` mentions, or as a
  folder path. Use the paths as given. **Do not Read HEIC files.** They're
  too big and Read can't display them anyway. The script reads them.
- If images were pasted with no file path, ask for the folder. The script
  needs files on disk.
- **Cover:** a rip post starts with the box/pack photo. The user usually
  says which one ("the first picture is the cover"). Pass it as `--cover`.
  If the post is cards only, the cover is just a card: pass it first
  among the photos, with no `--cover`.
- **Order:** slides follow the order the photos were given. A folder is
  sorted by filename, which is shot order for iPhone `IMG_####` names.
- Instagram allows at most 20 slides per carousel.

## Step 2: Run it

```bash
python3 scripts/insta_post.py <card photos in order...> --cover <box photo>
```

- Output goes to a new `instagram-<timestamp>/` folder beside the first
  photo: `01.jpg`, `02.jpg`, and so on, plus `preview.jpg`. Nothing is
  overwritten.
- `--toploader-width` (default 680 of 1080 px) sets how big the card is.
  Change it only if the user asks for bigger or smaller cards, and keep it
  the same across posts so the grid looks consistent.
- `--out DIR` overrides the folder.

## Step 3: Check before handing over

Read `preview.jpg` (it's small) and look at every slide. The toploaders should
all be the same size and in the same position. If one looks bigger, smaller or
off-centre, the detector latched onto the card's printed border instead of
the toploader edge. Read that one slide at full size to confirm.

Output lines that need attention:

- `SKIP ... no toploader found`: no slide was made for that photo.
  Usually the toploader was cut off at the frame edge, or it's a slab.
- `WARNING: extended the backdrop past the photo edge`: the card was shot
  close, so the crop ran past the photo and the photo was mirrored at its
  edge to fill it. Usually invisible on the smooth backdrop. Glance at the
  top and sides of that slide.

Don't hand-patch a bad slide by cropping it some other way. That breaks the
alignment the whole tool exists for. Report it instead, and suggest a reshoot
with the whole toploader in frame.

## Step 4: Report

Give the output folder, the slide count and order (cover, then the cards by
player name), and anything flagged. Offer to `open` the folder in Finder.

## Later

- Watermark: the brand mark is `web/public/logo-mark.webp`. The user wants it
  eventually, placed in the same corner on every slide. Not built yet.
- Slabs: see above.
- **Magnetic one-touches (most single-card feature posts).** Not supported
  yet. A one-touch is a different size than a toploader, so anchoring on the
  holder would make one-touch cards a different size than toploader cards.
  Fix: anchor on the printed card (2.5"x3.5") instead, which works the same
  in toploaders, one-touches and slabs. Target size: the existing feed's
  cards fill about 54-58% of the 3:4 profile-grid tile width, and the
  toploader batch at the default `--toploader-width 680` lands at about 58%.
  Until this is built, warn the user if one-touch photos come in.

Dependencies: `python3 -m pip install -r requirements.txt` (opencv,
pillow, pillow-heif, numpy).
