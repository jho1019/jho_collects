#!/usr/bin/env python3
"""
Attach an image to a buying_list item.

    python scripts/upload_buying_image.py 11 path/to/card.webp

Uploads to the private card-images bucket at <OWNER_USER_ID>/buying/<id>.<ext>
and sets buying_list.image_path for that one row. Uses the service-role key
from .env.local, so this is a local CLI only — the key never goes to the
browser. Stdlib only.
"""

import json
import mimetypes
import os
import sys
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_env():
    env = {}
    with open(os.path.join(ROOT, ".env.local"), encoding="utf8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip('"')
    return env


def call(req):
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def main():
    if len(sys.argv) != 3 or not sys.argv[1].isdigit():
        sys.exit(__doc__)
    item_id, path = int(sys.argv[1]), sys.argv[2]
    env = load_env()
    base, key, owner = env["SUPABASE_URL"].rstrip("/"), env["SUPABASE_SERVICE_ROLE_KEY"], env["OWNER_USER_ID"]

    ext = os.path.splitext(path)[1].lower()
    # mimetypes on Windows doesn't know .webp
    ctype = {".webp": "image/webp"}.get(ext) or mimetypes.guess_type(path)[0] or "application/octet-stream"
    if not ctype.startswith("image/"):
        sys.exit(f"not an image: {path}")
    object_path = f"{owner}/buying/{item_id}{ext}"
    auth = {"Authorization": f"Bearer {key}", "apikey": key}

    with open(path, "rb") as f:
        body = f.read()
    status, out = call(urllib.request.Request(
        f"{base}/storage/v1/object/card-images/{object_path}",
        data=body, method="POST",
        headers={**auth, "Content-Type": ctype, "x-upsert": "true"},
    ))
    if status >= 300:
        sys.exit(f"upload failed ({status}): {out.decode()}")

    status, out = call(urllib.request.Request(
        f"{base}/rest/v1/buying_list?id=eq.{item_id}&user_id=eq.{owner}",
        data=json.dumps({"image_path": object_path}).encode(), method="PATCH",
        headers={**auth, "Content-Type": "application/json", "Prefer": "return=representation"},
    ))
    rows = json.loads(out) if status < 300 else None
    if not rows:
        sys.exit(f"row update failed or no such item ({status}): {out.decode()}")
    print(f"item {item_id}: {object_path} ({len(body)} bytes)")


if __name__ == "__main__":
    main()
