#!/usr/bin/env python3
"""
Parse an eBay Seller Hub transaction report into ledger rows.

    python parse_ebay.py Transaction_report_20260801_20260831.csv
    python parse_ebay.py report.csv --json rows.json

Emits one row per sold line item, with that order's fees and shipping label
cost attached. Order-level costs on multi-item orders are split across items
in proportion to item subtotal.
"""

import argparse
import csv
import datetime as dt
import json
import re
import sys
from collections import defaultdict

# Cash movement between eBay's balance and your bank. Not income, not expense.
# Summing Net amount across every row double-counts badly: a shipping label
# your balance couldn't cover appears BOTH as a 'Shipping label' (-5.72) and a
# 'Charge' (+5.72) that pulls from your bank. They net to zero.
IGNORED_TYPES = {"payout", "secondary payout", "transfer", "charge",
                 "hold", "reserve"}


def money(s):
    s = (s or "").replace("--", "").replace("$", "").replace(",", "").strip()
    if not s:
        return 0.0
    neg = s.startswith("(") and s.endswith(")")
    if neg:
        s = s[1:-1]
    return -float(s) if neg else float(s)


def clean(s):
    s = (s or "").strip()
    return "" if s == "--" else s


def parse_date(s):
    s = clean(s)
    for fmt in ("%b %d, %Y", "%b-%d-%Y", "%Y-%m-%d"):
        try:
            return dt.datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    raise ValueError(f"unparseable date: {s!r}")


def split(amount, weights):
    """Apportion amount by weights; the last part takes the rounding remainder
    so the parts always sum to amount ($5.00 over 3 is 1.67/1.67/1.66)."""
    total = sum(weights)
    parts, left = [], round(amount, 2)
    for i, w in enumerate(weights):
        last = i == len(weights) - 1
        part = left if last else round(amount * (w / total if total else 1 / len(weights)), 2)
        parts.append(part)
        left = round(left - part, 2)
    return parts


def load(path):
    """Skip the notes preamble and find the real header row."""
    rows = list(csv.reader(open(path, encoding="utf-8-sig")))
    hi = next((i for i, r in enumerate(rows)
               if r and r[0].strip() == "Transaction creation date"), None)
    if hi is None:
        sys.exit("No header row found — is this a transaction report?")
    hdr = rows[hi]
    out = []
    for r in rows[hi + 1:]:
        if len(r) < len(hdr) or not clean(r[0]):
            continue
        out.append(dict(zip(hdr, r)))
    return out


TRACKING_RE = re.compile(r"Tracking no\.\s*(\S+)")
SERVICE_RE = re.compile(r"Tracking no\.\s*\S+\s+(.*?)\s*$")


def parse(path):
    raw = load(path)

    orders, labels, skipped = [], defaultdict(float), defaultdict(int)
    label_meta = {}

    for r in raw:
        typ = clean(r["Type"]).lower()
        if typ in IGNORED_TYPES:
            skipped[typ] += 1
            continue
        if typ == "shipping label":
            on = clean(r["Order number"])
            labels[on] += abs(money(r["Net amount"]))
            desc = clean(r.get("Description", ""))
            tm, sm = TRACKING_RE.search(desc), SERVICE_RE.search(desc)
            # Real reports vary: some label rows carry
            # "Tracking no. ESUS... eBay Standard Envelope", others just the
            # bare service name. Use the regex group when present, else the
            # whole Description as the service.
            label_meta[on] = {
                "tracking_number": tm.group(1) if tm else None,
                "shipping_service": (sm.group(1) if sm else desc) or None,
            }
        elif typ in ("order", "refund"):
            orders.append(r)
        else:
            skipped[typ] += 1

    # Group line items by order so order-level costs can be apportioned.
    by_order = defaultdict(list)
    for r in orders:
        by_order[clean(r["Order number"])].append(r)

    out = []
    sale_orders = set()
    for order_no, items in by_order.items():
        # A label is a cost of the sale. On a refund row it would flip into
        # income (the ledger negates refunds), so split it over sales only; an
        # order with no sale in this file sends its label to the orphan path.
        sales = [r for r in items if clean(r["Type"]).lower() == "order"]
        if sales:
            sale_orders.add(order_no)
        label_parts = split(labels.get(order_no, 0.0),
                            [money(r["Item subtotal"]) for r in sales])
        label_of = {id(r): p for r, p in zip(sales, label_parts)}
        meta = label_meta.get(order_no, {})

        for r in items:
            is_refund = clean(r["Type"]).lower() == "refund"
            # The ledger negates refund rows itself, so store their amounts
            # positive whichever sign eBay writes them with.
            amt = (lambda c: abs(money(r[c]))) if is_refund else (lambda c: money(r[c]))

            fees = sum(abs(money(r.get(c, "")))
                       for c in ("Final Value Fee - fixed",
                                 "Final Value Fee - variable",
                                 "Regulatory operating fee",
                                 "International fee",
                                 "Deposit processing fee",
                                 "Very high \"item not as described\" fee",
                                 "Below standard performance fee"))

            out.append({
                "occurred_on": parse_date(r["Transaction creation date"]).isoformat(),
                "type": "refund" if is_refund else "sale",
                "platform": "ebay",
                "description": clean(r["Item title"]),
                "qty": int(clean(r["Quantity"]) or 1),
                "item_amount": round(amt("Item subtotal"), 2),
                "shipping_charged": round(amt("Shipping and handling"), 2),
                "sales_tax_collected": round(amt("eBay collected tax")
                                             + amt("Seller collected tax"), 2),
                "platform_fees": round(fees, 2),
                "shipping_cost": label_of.get(id(r), 0.0),
                "other_cost": 0,
                "source_ref": clean(r["Transaction ID"]) or None,
                "order_ref": order_no,
                "item_number": clean(r["Item ID"]) or None,
                # eBay 'Custom label' == cards.sku. The loader uses it to close
                # a tracked card automatically. '--' becomes None (unlinked).
                "custom_label": clean(r.get("Custom label", "")) or None,
                "buyer_username": clean(r["Buyer username"]) or None,
                "buyer_name": clean(r["Buyer name"]) or None,
                "ship_to_city": clean(r["Ship to city"]) or None,
                "ship_to_state": clean(r["Ship to province/region/state"]) or None,
                "ship_to_zip": clean(r["Ship to zip"]) or None,
                "ship_to_country": clean(r["Ship to country"]) or None,
                "payout_date": (parse_date(r["Payout date"]).isoformat()
                                if clean(r["Payout date"]) else None),
                "fees_estimated": False,
                **meta,
            })

    # Labels whose order has no sale line in THIS file belong to a prior
    # month's order (or are a return label next to a refund). The loader must
    # attach these to the existing sale by order_ref, not drop them. See
    # docs/reference/ebay-report-notes.md.
    orphan_labels = {
        on: {"amount": round(amt, 2), **label_meta.get(on, {})}
        for on, amt in labels.items()
        if on not in sale_orders
    }

    out.sort(key=lambda x: (x["occurred_on"], x["source_ref"] or ""))
    return out, dict(skipped), orphan_labels


def net_cash(r):
    v = (r["item_amount"] + r["shipping_charged"]
         - r["platform_fees"] - r["shipping_cost"] - r["other_cost"])
    return -v if r["type"] == "refund" else v


def main():
    p = argparse.ArgumentParser()
    p.add_argument("path")
    p.add_argument("--json", help="write rows to this file")
    a = p.parse_args()

    rows, skipped, orphans = parse(a.path)

    print(f"{len(rows)} ledger rows"
          + (f"   (ignored: {skipped})" if skipped else "")
          + (f"   (orphan labels: {list(orphans)})" if orphans else ""))
    print(f"{'date':11} {'buyer':22} {'item':38} {'sub':>7} {'fees':>7} {'label':>7} {'net':>8}")
    for r in rows:
        print(f"{r['occurred_on']:11} {(r['buyer_username'] or '-')[:22]:22} "
              f"{r['description'][:38]:38} {r['item_amount']:7.2f} "
              f"{r['platform_fees']:7.2f} {r['shipping_cost']:7.2f} {net_cash(r):8.2f}")

    gross = sum(r["item_amount"] + r["shipping_charged"] + r["sales_tax_collected"]
                for r in rows if r["type"] == "sale")
    print(f"\n  gross buyer payments (1099-K) {gross:9.2f}")
    print(f"  order proceeds ex-tax         "
          f"{sum(r['item_amount'] + r['shipping_charged'] for r in rows):9.2f}")
    print(f"  eBay fees                     {-sum(r['platform_fees'] for r in rows):9.2f}")
    print(f"  shipping labels               {-sum(r['shipping_cost'] for r in rows):9.2f}")
    print(f"  net cash                      {sum(net_cash(r) for r in rows):9.2f}")

    if a.json:
        json.dump(rows, open(a.json, "w"), indent=2)
        print(f"\nwrote {a.json}")


if __name__ == "__main__":
    main()
