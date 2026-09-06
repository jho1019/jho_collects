#!/usr/bin/env python3
"""
Off-platform CSV backup of the ledger.

    python scripts/backup.py                 # write a dated backup, prune old ones
    python scripts/backup.py --keep 60       # keep 60 days instead of 30
    python scripts/backup.py --out D:/bak    # write somewhere other than ./backups

Why this exists (see docs/DECISIONS.md, "Free tier constraints"):
  - The Supabase free tier keeps ZERO backups. These are tax records.
  - It also pauses a project after 7 idle days. This job's daily connection
    doubles as the keep-alive.

Backs up table DATA only. The schema of record is schema/*.sql in git. Every
public base table is dumped, so new tables (cards, aliases) are picked up
automatically. Generated columns are included for the human record; a restore
(Phase 5) re-derives them and skips them on insert.

Reads .env.local for DATABASE_URL and the optional DB_SSL_* knobs, same as
scripts/check_connection.py. Output: backups/<UTC-timestamp>/<table>.csv plus
a manifest.txt with row counts. Exit non-zero on any failure.
"""

import argparse
import csv
import datetime as dt
import shutil
import ssl
import sys
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from check_connection import load_env, sql_ssl_context  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = REPO_ROOT / ".env.local"
SSL_KEYS = ("DB_SSL_INSECURE", "DB_SSL_ROOT_CERT")


def connect(env):
    import pg8000.native

    p = urllib.parse.urlparse(env["DATABASE_URL"])
    ctx, _ = sql_ssl_context(env)
    return pg8000.native.Connection(
        user=urllib.parse.unquote(p.username or ""),
        password=urllib.parse.unquote(p.password or ""),
        host=p.hostname,
        port=p.port or 5432,
        database=(p.path or "/postgres").lstrip("/") or "postgres",
        ssl_context=ctx,
        timeout=30,
    )


def public_tables(conn):
    rows = conn.run(
        "select tablename from pg_tables where schemaname = 'public' order by tablename"
    )
    return [r[0] for r in rows]


def dump_table(conn, table, dest):
    rows = conn.run(f'select * from public."{table}"')
    cols = [c["name"] for c in conn.columns]
    with open(dest, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(cols)
        w.writerows(rows)
    return len(rows)


def prune(out_root, keep_days):
    if keep_days <= 0:
        return []
    cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=keep_days)
    removed = []
    for d in sorted(p for p in out_root.iterdir() if p.is_dir()):
        try:
            stamp = dt.datetime.strptime(d.name, "%Y%m%dT%H%M%SZ").replace(
                tzinfo=dt.timezone.utc
            )
        except ValueError:
            continue
        if stamp < cutoff:
            shutil.rmtree(d)
            removed.append(d.name)
    return removed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep", type=int, default=30, help="days of backups to retain")
    ap.add_argument("--out", default=str(REPO_ROOT / "backups"), help="backup root dir")
    args = ap.parse_args()

    env = load_env(ENV_FILE)
    import os

    for k in SSL_KEYS:
        env.setdefault(k, os.environ.get(k, ""))
    if not env.get("DATABASE_URL"):
        sys.exit("DATABASE_URL missing from .env.local")

    out_root = Path(args.out)
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    dest_dir = out_root / stamp
    dest_dir.mkdir(parents=True, exist_ok=True)

    try:
        conn = connect(env)
    except ssl.SSLCertVerificationError as e:
        sys.exit(f"TLS verification failed: {e}\nSet DB_SSL_ROOT_CERT or DB_SSL_INSECURE=1.")
    except Exception as e:  # noqa: BLE001
        sys.exit(f"connect failed: {e}")

    manifest = [f"backup {stamp}", f"source {env['DATABASE_URL'].split('@')[-1]}", ""]
    total = 0
    try:
        tables = public_tables(conn)
        if not tables:
            sys.exit("no public tables found — nothing to back up")
        for t in tables:
            n = dump_table(conn, t, dest_dir / f"{t}.csv")
            total += n
            manifest.append(f"{t:24} {n:>8} rows")
    except Exception as e:  # noqa: BLE001
        shutil.rmtree(dest_dir, ignore_errors=True)
        sys.exit(f"dump failed, backup discarded: {e}")
    finally:
        conn.close()

    manifest.append("")
    manifest.append(f"{'TOTAL':24} {total:>8} rows")
    (dest_dir / "manifest.txt").write_text("\n".join(manifest) + "\n", encoding="utf-8")

    removed = prune(out_root, args.keep)
    print(f"backup written: {dest_dir}")
    print("\n".join(manifest[3:]))
    if removed:
        print(f"pruned {len(removed)} backup(s) older than {args.keep} days")


if __name__ == "__main__":
    main()
