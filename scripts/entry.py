#!/usr/bin/env python3
"""
Manual ledger entry. One row per call, structured arguments in.

    python scripts/entry.py purchase --amount 10 --qty 15
    python scripts/entry.py purchase --amount 10 --qty 15 --date yesterday --dry-run
    python scripts/entry.py sale --amount 45 --platform collx --description "Wembanyama base"
    python scripts/entry.py expense --amount 30 --category supplies --description "toploaders"
    python scripts/entry.py review

Natural language ("bought 15 cards for $10 at the show today") is turned into
one of these calls by the card-entry skill; this script is the write path.

Rules (from CLAUDE.md / docs/DECISIONS.md):
  - money is numeric(10,2); net_cash / buyer_paid_total are generated, never set
  - purchases and expenses carry NO shipping_charged / sales_tax_collected
    (a CHECK enforces it) — money paid to receive cards goes in --shipping-cost
  - a missing optional field is not a blocker: the row is written with
    needs_review = true and cleaned up later in batch
  - contradictions (buyer-side fields on a purchase, qty <= 0, bad date,
    unknown enum) fail loudly and write nothing

Reads .env.local for DATABASE_URL, OWNER_USER_ID and the optional DB_SSL_*
knobs, same as scripts/check_connection.py.
"""

import argparse
import datetime as dt
import os
import ssl
import sys
import urllib.parse
from decimal import Decimal, InvalidOperation
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from check_connection import load_env, sql_ssl_context  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = REPO_ROOT / ".env.local"
SSL_KEYS = ("DB_SSL_INSECURE", "DB_SSL_ROOT_CERT")

PLATFORMS = ("ebay", "collx", "card_show", "local", "lcs", "online", "other", "na")
CATEGORIES = ("supplies", "postage_shipping", "subscriptions", "fees",
              "mileage", "equipment", "other")
DEFAULT_PLATFORM = {"purchase": "card_show", "sale": "card_show",
                    "refund": "card_show", "expense": "na"}


class EntryError(Exception):
    """A contradiction the user must fix. Nothing is written."""


def money(s, field):
    try:
        d = Decimal(str(s)).quantize(Decimal("0.01"))
    except (InvalidOperation, ValueError):
        raise EntryError(f"{field}: {s!r} is not an amount")
    if d < 0:
        raise EntryError(f"{field}: must not be negative (got {d})")
    return d


def parse_when(s):
    s = (s or "today").strip().lower()
    today = dt.date.today()
    if s in ("today", "now"):
        return today
    if s == "yesterday":
        return today - dt.timedelta(days=1)
    if s.endswith(" days ago"):
        try:
            return today - dt.timedelta(days=int(s.split()[0]))
        except ValueError:
            pass
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%m/%d", "%m-%d"):
        try:
            d = dt.datetime.strptime(s, fmt).date()
            return d.replace(year=today.year) if "%Y" not in fmt else d
        except ValueError:
            continue
    raise EntryError(f"date: cannot read {s!r} "
                     f"(use today, yesterday, N days ago, YYYY-MM-DD or M/D)")


def connect(env):
    import pg8000.native

    p = urllib.parse.urlparse(env["DATABASE_URL"])
    ctx, note = sql_ssl_context(env)
    if note:
        print(f"  db TLS{note}")
    return pg8000.native.Connection(
        user=urllib.parse.unquote(p.username or ""),
        password=urllib.parse.unquote(p.password or ""),
        host=p.hostname, port=p.port or 5432,
        database=(p.path or "/postgres").lstrip("/") or "postgres",
        ssl_context=ctx, timeout=30,
    )


def build_row(a):
    """Validate and assemble one transactions row. Raises EntryError on a
    contradiction; sets needs_review for anything merely missing."""
    typ = a.command
    review = bool(a.needs_review)
    notes = []

    amount = money(a.amount if a.amount is not None else 0, "--amount")
    if a.amount is None or amount == 0:
        review = True
        notes.append("amount missing/zero")

    qty = a.qty if a.qty is not None else 1
    if qty <= 0:
        raise EntryError(f"--qty must be > 0 (got {qty})")

    platform = (a.platform or DEFAULT_PLATFORM[typ]).lower()
    if platform not in PLATFORMS:
        raise EntryError(f"--platform {platform!r} not one of {', '.join(PLATFORMS)}")

    occurred_on = parse_when(a.date)

    ship_charged = money(a.shipping_charged or 0, "--shipping-charged")
    sales_tax = money(a.sales_tax or 0, "--sales-tax")
    if typ in ("purchase", "expense") and (ship_charged or sales_tax):
        raise EntryError(
            f"a {typ} carries no --shipping-charged or --sales-tax "
            f"(a CHECK enforces this). Money you paid to receive cards "
            f"goes in --shipping-cost.")

    category = None
    if typ == "expense":
        category = (a.category or "").lower() or None
        if category is None:
            category = "other"
            review = True
            notes.append("expense category defaulted to 'other'")
        elif category not in CATEGORIES:
            raise EntryError(
                f"--category {category!r} not one of {', '.join(CATEGORIES)}")

    # A synthesized description is fine for a self-describing bulk row
    # ("purchase x15"); not a reason to flag for review.
    description = a.description or f"{typ} x{qty} ({occurred_on})"

    if a.notes:
        notes.append(a.notes)

    return {
        "occurred_on": occurred_on, "type": typ, "platform": platform,
        "description": description, "qty": qty,
        "item_amount": amount,
        "shipping_charged": ship_charged, "sales_tax_collected": sales_tax,
        "platform_fees": money(a.platform_fees or 0, "--platform-fees"),
        "shipping_cost": money(a.shipping_cost or 0, "--shipping-cost"),
        "other_cost": money(a.other_cost or 0, "--other-cost"),
        "expense_category": category,
        "needs_review": review,
        "notes": "; ".join(notes) or None,
    }


def insert_row(conn, owner, row, dry_run):
    cols = list(row)
    q = (f"insert into transactions (user_id, {', '.join(cols)}) "
         f"values (:owner, {', '.join(':' + c for c in cols)}) "
         f"returning id, net_cash")
    if dry_run:
        conn.run("begin")
    res = conn.run(q, owner=owner, **row)
    new_id, net_cash = res[0]
    position = conn.run(
        "select coalesce(sum(net_cash), 0) from transactions where user_id = :o",
        o=owner)[0][0]
    conn.run("rollback" if dry_run else "commit")
    return new_id, net_cash, position


def cmd_review(conn, owner, limit):
    rows = conn.run(
        """
        select id, occurred_on, type, platform, description, qty,
               item_amount, net_cash, notes
        from transactions
        where user_id = :o and needs_review
        order by occurred_on, id
        limit :lim
        """, o=owner, lim=limit)
    if not rows:
        print("no rows flagged for review")
        return
    print(f"{len(rows)} row(s) need review:\n")
    for r in rows:
        rid, on, typ, plat, desc, qty, amt, net, notes = r
        print(f"  #{rid}  {on}  {typ:8} {plat:9} x{qty:<3} "
              f"{amt:>8} net {net:>8}  {desc}")
        if notes:
            print(f"        note: {notes}")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="command", required=True)

    def add_common(p):
        p.add_argument("--date", default="today")
        p.add_argument("--platform")
        p.add_argument("--description")
        p.add_argument("--notes")
        p.add_argument("--needs-review", action="store_true")
        p.add_argument("--dry-run", action="store_true")

    p = sub.add_parser("purchase", help="cards bought (bulk lot or single)")
    p.add_argument("--amount", help="what you paid, item_amount")
    p.add_argument("--qty", type=int)
    p.add_argument("--shipping-cost", help="postage/shipping YOU paid to receive")
    p.add_argument("--other-cost")
    # accepted so build_row can reject them with a domain message, not an
    # argparse "unrecognized arguments" error
    p.add_argument("--shipping-charged", help=argparse.SUPPRESS)
    p.add_argument("--sales-tax", help=argparse.SUPPRESS)
    p.add_argument("--platform-fees", help=argparse.SUPPRESS)
    add_common(p)

    for name, helptext in (("sale", "a card sold"), ("refund", "a sale refunded")):
        p = sub.add_parser(name, help=helptext)
        p.add_argument("--amount", help="item price, item_amount")
        p.add_argument("--qty", type=int)
        p.add_argument("--shipping-charged", help="what the buyer paid for shipping")
        p.add_argument("--sales-tax", help="tax the marketplace collected")
        p.add_argument("--platform-fees")
        p.add_argument("--shipping-cost", help="label cost YOU paid")
        p.add_argument("--other-cost")
        add_common(p)

    p = sub.add_parser("expense", help="business cost that isn't buying cards")
    p.add_argument("--amount", help="item_amount")
    p.add_argument("--category", help=" / ".join(CATEGORIES))
    p.add_argument("--qty", type=int)
    add_common(p)
    p.set_defaults(shipping_charged=None, sales_tax=None, platform_fees=None,
                   shipping_cost=None, other_cost=None)

    p = sub.add_parser("review", help="list rows flagged needs_review")
    p.add_argument("--limit", type=int, default=50)

    a = ap.parse_args()
    for attr in ("shipping_charged", "sales_tax", "platform_fees",
                 "shipping_cost", "other_cost", "qty", "amount", "category"):
        if not hasattr(a, attr):
            setattr(a, attr, None)

    env = load_env(ENV_FILE)
    for k in SSL_KEYS:
        env.setdefault(k, os.environ.get(k, ""))
    owner = (env.get("OWNER_USER_ID") or "").strip()
    if not owner:
        sys.exit("OWNER_USER_ID missing from .env.local")
    if not env.get("DATABASE_URL"):
        sys.exit("DATABASE_URL missing from .env.local")

    if a.command != "review":
        try:
            row = build_row(a)
        except EntryError as e:
            sys.exit(f"rejected, nothing written: {e}")

    try:
        conn = connect(env)
    except ssl.SSLCertVerificationError as e:
        sys.exit(f"TLS verification failed: {e}\nSet DB_SSL_ROOT_CERT or DB_SSL_INSECURE=1.")
    except Exception as e:  # noqa: BLE001
        sys.exit(f"connect failed: {e}")

    try:
        if a.command == "review":
            cmd_review(conn, owner, a.limit)
        else:
            new_id, net_cash, position = insert_row(conn, owner, row, a.dry_run)
            tag = "[dry run] would record" if a.dry_run else "recorded"
            print(f"{tag} #{new_id}: {row['type']} x{row['qty']} "
                  f"{row['item_amount']} at {row['platform']} on {row['occurred_on']}"
                  f" -- this row net_cash {net_cash}")
            if row["needs_review"]:
                print(f"  needs_review = true ({row['notes']})")
            print(f"  net cash position: {position}"
                  + (" (unchanged -- rolled back)" if a.dry_run else ""))
    except Exception as e:  # noqa: BLE001
        conn.run("rollback")
        sys.exit(f"write failed, rolled back: {e}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
