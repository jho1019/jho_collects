#!/usr/bin/env python3
"""
Load a parsed eBay transaction report into the ledger.

    python importers/load_ebay.py Transaction_report_20260801_20260831.csv
    python importers/load_ebay.py report.csv --dry-run     # connect, count, roll back

Idempotent by design — re-importing an overlapping date range is a safe no-op:

  - sale / refund rows insert with
    ON CONFLICT (user_id, platform, source_ref) DO NOTHING
  - buyers upsert on (user_id, platform, platform_username), widening the
    first/last-seen window and refreshing name + city/state
  - orphan shipping labels (a label whose order has no line item in this file
    — it belongs to a prior month's order) UPDATE that existing transaction's
    shipping_cost, guarded by a note marker so a re-run does not double-add

Reads .env.local for DATABASE_URL, OWNER_USER_ID and the optional DB_SSL_*
knobs, same as scripts/check_connection.py. eBay fees come only from this
import; nothing here estimates them.
"""

import argparse
import os
import ssl
import sys
import urllib.parse
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent
sys.path.insert(0, str(REPO_ROOT / "scripts"))
sys.path.insert(0, str(HERE))

from check_connection import load_env, sql_ssl_context  # noqa: E402
from parse_ebay import parse  # noqa: E402

ENV_FILE = REPO_ROOT / ".env.local"
SSL_KEYS = ("DB_SSL_INSECURE", "DB_SSL_ROOT_CERT")

# transaction columns fed straight from a parsed row
TXN_COLS = [
    "occurred_on", "type", "platform", "description", "qty",
    "item_amount", "shipping_charged", "sales_tax_collected", "platform_fees",
    "shipping_cost", "other_cost", "source_ref", "order_ref", "item_number",
    "ship_to_city", "ship_to_state", "ship_to_zip", "ship_to_country",
    "shipping_service", "tracking_number", "fees_estimated",
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


def resolve_owner(conn, env):
    owner = (env.get("OWNER_USER_ID") or "").strip()
    if owner:
        return owner
    rows = conn.run("select id from auth.users order by created_at")
    if len(rows) != 1:
        sys.exit(f"set OWNER_USER_ID in .env.local — auth.users has {len(rows)} rows")
    return str(rows[0][0])


def aggregate_buyers(rows):
    """One record per buyer_username, with the widest seen window."""
    buyers = {}
    for r in rows:
        u = r.get("buyer_username")
        if not u:
            continue
        d = r["occurred_on"]
        b = buyers.setdefault(u, {
            "display_name": None, "last_city": None, "last_state": None,
            "last_country": None, "first_seen_on": d, "last_seen_on": d,
            "_last": "",
        })
        b["first_seen_on"] = min(b["first_seen_on"], d)
        b["last_seen_on"] = max(b["last_seen_on"], d)
        if d >= b["_last"]:  # latest row wins for the mutable fields
            b["_last"] = d
            b["display_name"] = r.get("buyer_name") or b["display_name"]
            b["last_city"] = r.get("ship_to_city") or b["last_city"]
            b["last_state"] = r.get("ship_to_state") or b["last_state"]
            b["last_country"] = r.get("ship_to_country") or b["last_country"]
    return buyers


def upsert_buyers(conn, owner, buyers):
    ids = {}
    for u, b in buyers.items():
        row = conn.run(
            """
            insert into buyers (user_id, platform, platform_username,
              display_name, last_city, last_state, last_country,
              first_seen_on, last_seen_on)
            values (:o, 'ebay', :u, :dn, :city, :st, :co, :first, :last)
            on conflict (user_id, platform, platform_username) do update set
              display_name  = coalesce(excluded.display_name,  buyers.display_name),
              last_city     = coalesce(excluded.last_city,     buyers.last_city),
              last_state    = coalesce(excluded.last_state,    buyers.last_state),
              last_country  = coalesce(excluded.last_country,  buyers.last_country),
              first_seen_on = least(buyers.first_seen_on,      excluded.first_seen_on),
              last_seen_on  = greatest(buyers.last_seen_on,    excluded.last_seen_on)
            returning id
            """,
            o=owner, u=u, dn=b["display_name"], city=b["last_city"],
            st=b["last_state"], co=b["last_country"],
            first=b["first_seen_on"], last=b["last_seen_on"],
        )
        ids[u] = row[0][0]
    return ids


def insert_transactions(conn, owner, rows, buyer_ids):
    inserted = 0
    collist = ", ".join(["user_id", "buyer_id", "ship_to_name", *TXN_COLS])
    placeholders = ", ".join([":user_id", ":buyer_id", ":ship_to_name",
                              *[f":{c}" for c in TXN_COLS]])
    for r in rows:
        params = {c: r.get(c) for c in TXN_COLS}
        params["user_id"] = owner
        params["buyer_id"] = buyer_ids.get(r.get("buyer_username"))
        params["ship_to_name"] = r.get("buyer_name")
        params["fees_estimated"] = bool(r.get("fees_estimated", False))
        res = conn.run(
            f"""
            insert into transactions ({collist})
            values ({placeholders})
            on conflict (user_id, platform, source_ref)
              where source_ref is not null
              do nothing
            returning id
            """,
            **params,
        )
        inserted += len(res)
    return inserted, len(rows) - inserted


def link_cards_by_sku(conn, owner, rows):
    """
    eBay 'Custom label' == cards.sku. Close any held/listed tracked card whose
    sku matches an imported eBay sale, linking it to that transaction. Idempotent
    (status guard) and independent of whether the row was inserted this run, so
    a card created after its sale was imported still gets linked on a re-run.
    """
    linked = 0
    for r in rows:
        label = r.get("custom_label")
        src = r.get("source_ref")
        if not label or not src or r.get("type") != "sale":
            continue
        res = conn.run(
            """
            update cards c set
              status = 'sold',
              sale_transaction_id = t.id,
              sold_on = t.occurred_on
            from transactions t
            where c.user_id = :o and c.sku = :sku and c.status <> 'sold'
              and t.user_id = :o and t.platform = 'ebay' and t.source_ref = :src
            returning c.id
            """,
            o=owner, sku=label, src=src,
        )
        linked += len(res)
    return linked


def apply_orphan_labels(conn, owner, orphans):
    applied, already, unresolved = [], [], []
    for order_ref, meta in orphans.items():
        amount = meta["amount"]
        marker = f"[orphan-label {order_ref}]"
        rows = conn.run(
            """
            select id, item_amount from transactions
            where user_id = :o and platform = 'ebay' and order_ref = :oref
              and type in ('sale', 'refund')
            order by id
            """,
            o=owner, oref=order_ref,
        )
        if not rows:
            unresolved.append(order_ref)
            continue
        total = sum(float(x[1]) for x in rows) or float(len(rows))
        changed = 0
        for tid, item_amt in rows:
            share = (float(item_amt) / total) if total else (1.0 / len(rows))
            portion = round(amount * share, 2)
            res = conn.run(
                """
                update transactions set
                  shipping_cost    = shipping_cost + :p,
                  tracking_number  = coalesce(tracking_number, :tn::text),
                  shipping_service = coalesce(shipping_service, :svc::text),
                  notes = concat_ws(' ', notes, :marker::text)
                where id = :id
                  and (notes is null or notes not like :like::text)
                returning id
                """,
                p=portion, tn=meta.get("tracking_number"),
                svc=meta.get("shipping_service"),
                marker=marker, like=f"%{marker}%", id=tid,
            )
            changed += len(res)
        (applied if changed else already).append(order_ref)
    return applied, already, unresolved


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--dry-run", action="store_true",
                    help="do everything, then roll back instead of committing")
    args = ap.parse_args()

    rows, skipped, orphans = parse(args.path)
    print(f"parsed {len(rows)} sale/refund rows"
          + (f", ignored {skipped}" if skipped else "")
          + (f", {len(orphans)} orphan label(s)" if orphans else ""))
    if not rows and not orphans:
        sys.exit("nothing to load")

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

    try:
        owner = resolve_owner(conn, env)
        conn.run("begin")
        buyers = aggregate_buyers(rows)
        buyer_ids = upsert_buyers(conn, owner, buyers)
        inserted, already = insert_transactions(conn, owner, rows, buyer_ids)
        cards_linked = link_cards_by_sku(conn, owner, rows)
        applied, label_already, unresolved = apply_orphan_labels(conn, owner, orphans)
        conn.run("rollback" if args.dry_run else "commit")
    except Exception as e:  # noqa: BLE001
        conn.run("rollback")
        conn.close()
        sys.exit(f"load failed, rolled back: {e}")
    conn.close()

    tag = "[dry run] " if args.dry_run else ""
    print(f"{tag}buyers upserted:        {len(buyer_ids)}")
    print(f"{tag}transactions inserted:  {inserted}")
    print(f"{tag}already present:        {already}")
    print(f"{tag}cards closed by SKU:    {cards_linked}")
    if orphans:
        print(f"{tag}orphan labels applied:  {len(applied)} {applied or ''}")
        if label_already:
            print(f"{tag}orphan labels already applied: {len(label_already)}")
        if unresolved:
            print(f"{tag}orphan labels UNRESOLVED (no matching order): {unresolved}")
    if args.dry_run:
        print("rolled back -- no changes written")


if __name__ == "__main__":
    main()
