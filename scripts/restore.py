#!/usr/bin/env python3
"""
Restore a CSV backup (from scripts/backup.py) into the database.

    python scripts/restore.py backups/20260906T172729Z
    python scripts/restore.py backups/20260906T172729Z --dry-run   # insert, roll back

Intended for a fresh/empty database (disaster recovery), but safe to re-run:
every insert is ON CONFLICT (primary key) DO NOTHING, so rows already present
are left untouched. Generated columns (net_cash, buyer_paid_total, search_text)
are re-derived by Postgres and skipped on insert. Row ids are preserved and the
identity sequences are bumped past the restored maximum.

The whole restore runs in one transaction — all rows land or none do.

Reads .env.local for DATABASE_URL and the optional DB_SSL_* knobs, same as
scripts/check_connection.py.
"""

import argparse
import csv
import os
import ssl
import sys
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from check_connection import load_env, sql_ssl_context  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = REPO_ROOT / ".env.local"
SSL_KEYS = ("DB_SSL_INSECURE", "DB_SSL_ROOT_CERT")

# Load order respects foreign keys. (table, conflict-target columns, has identity id)
PLAN = [
    ("buyers", ["id"], True),
    ("inventory_counts", ["user_id", "tax_year"], False),
    ("transactions", ["id"], True),
    ("cards", ["id"], True),
    ("card_aliases", ["id"], True),
]


def connect(env):
    import pg8000.native

    p = urllib.parse.urlparse(env["DATABASE_URL"])
    ctx, note = sql_ssl_context(env)
    if note:
        print(f"  db TLS{note}")
    return pg8000.native.Connection(
        user=urllib.parse.unquote(p.username or ""),
        password=urllib.parse.unquote(p.password or ""),
        host=p.hostname,
        port=p.port or 5432,
        database=(p.path or "/postgres").lstrip("/") or "postgres",
        ssl_context=ctx,
        timeout=30,
    )


def generated_columns(conn, table):
    rows = conn.run(
        """
        select column_name from information_schema.columns
        where table_schema = 'public' and table_name = :t
          and is_generated = 'ALWAYS'
        """,
        t=table,
    )
    return {r[0] for r in rows}


def coerce(v):
    """CSV cell -> value for a parameterised insert. backup.py wrote pg8000
    Python values through csv.writer, so None became '' and bools 'True'/'False'.
    Everything else is passed as text; Postgres assignment-casts it."""
    if v == "":
        return None
    if v == "True":
        return True
    if v == "False":
        return False
    return v


def restore_table(conn, backup_dir, table, conflict_cols):
    path = backup_dir / f"{table}.csv"
    if not path.exists():
        return 0, 0, 0

    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.reader(f)
        header = next(reader, None)
        if not header:
            return 0, 0, 0
        rows = list(reader)

    if not rows:
        return 0, 0, 0

    skip = generated_columns(conn, table)
    cols = [c for c in header if c not in skip]
    idx = [header.index(c) for c in cols]
    collist = ", ".join(f'"{c}"' for c in cols)
    params = ", ".join(f":{c}" for c in cols)
    # id is GENERATED ALWAYS — restoring the original value needs the override.
    overriding = "overriding system value " if "id" in cols else ""
    q = (
        f'insert into public."{table}" ({collist}) {overriding}values ({params}) '
        f"on conflict ({', '.join(conflict_cols)}) do nothing returning 1"
    )

    inserted = 0
    for raw in rows:
        vals = {c: coerce(raw[i]) for c, i in zip(cols, idx)}
        inserted += len(conn.run(q, **vals))
    return len(rows), inserted, len(rows) - inserted


def bump_sequence(conn, table):
    conn.run(
        f"""
        select setval(
          pg_get_serial_sequence('public."{table}"', 'id'),
          greatest(coalesce((select max(id) from public."{table}"), 1), 1),
          (select max(id) is not null from public."{table}")
        )
        """
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("backup_dir")
    ap.add_argument("--dry-run", action="store_true",
                    help="insert everything, then roll back")
    args = ap.parse_args()

    backup_dir = Path(args.backup_dir)
    if not backup_dir.is_dir():
        sys.exit(f"not a directory: {backup_dir}")

    env = load_env(ENV_FILE)
    for k in SSL_KEYS:
        env.setdefault(k, os.environ.get(k, ""))
    if not env.get("DATABASE_URL"):
        sys.exit("DATABASE_URL missing from .env.local")

    try:
        conn = connect(env)
    except ssl.SSLCertVerificationError as e:
        sys.exit(f"TLS verification failed: {e}\nSet DB_SSL_ROOT_CERT or DB_SSL_INSECURE=1.")
    except Exception as e:  # noqa: BLE001
        sys.exit(f"connect failed: {e}")

    total_in = total_new = 0
    try:
        conn.run("begin")
        for table, conflict_cols, has_id in PLAN:
            seen, new, skipped = restore_table(conn, backup_dir, table, conflict_cols)
            total_in += seen
            total_new += new
            if seen:
                note = f", {skipped} already present" if skipped else ""
                print(f"  {table:20} {seen:>6} rows -> {new} inserted{note}")
            if has_id and not args.dry_run:
                bump_sequence(conn, table)
        conn.run("rollback" if args.dry_run else "commit")
    except Exception as e:  # noqa: BLE001
        conn.run("rollback")
        conn.close()
        sys.exit(f"restore failed, rolled back: {e}")
    conn.close()

    tag = "[dry run] " if args.dry_run else ""
    print(f"\n{tag}{total_new} of {total_in} rows inserted from {backup_dir}"
          + (" -- rolled back" if args.dry_run else ""))


if __name__ == "__main__":
    main()
