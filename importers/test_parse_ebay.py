#!/usr/bin/env python3
"""
Self-check for the label split and refund handling in parse_ebay.py.

    python importers/test_parse_ebay.py

Synthetic report, made-up buyers. No database.
"""

import csv
import os
import tempfile

from parse_ebay import net_cash, parse, split

COLS = ["Transaction creation date", "Type", "Order number", "Buyer username",
        "Buyer name", "Ship to city", "Ship to province/region/state",
        "Ship to zip", "Ship to country", "Net amount", "Payout date",
        "Transaction ID", "Item ID", "Item title", "Custom label", "Quantity",
        "Item subtotal", "Shipping and handling", "Seller collected tax",
        "eBay collected tax", "Final Value Fee - fixed",
        "Final Value Fee - variable", "Description"]


def row(typ, order, txn="--", subtotal="--", fee="--", net="--", desc="--"):
    r = dict.fromkeys(COLS, "--")
    r.update({"Transaction creation date": "Sep 3, 2026", "Type": typ,
              "Order number": order, "Buyer username": "test_buyer",
              "Transaction ID": txn, "Item title": f"card {txn}",
              "Quantity": "1", "Item subtotal": subtotal,
              "Final Value Fee - variable": fee, "Net amount": net,
              "Description": desc})
    return [r[c] for c in COLS]


ROWS = [
    # A: three equal items share one $5.00 label -> 1.67 / 1.67 / 1.66
    row("Order", "A", "a1", "10.00", "-1.40"),
    row("Order", "A", "a2", "10.00", "-1.40"),
    row("Order", "A", "a3", "10.00", "-1.40"),
    row("Shipping label", "A", net="-5.00",
        desc="Tracking no. ESUS1 eBay Standard Envelope"),
    # B: sale and its refund in the same file; the label stays on the sale
    row("Order", "B", "b1", "10.00", "-1.40"),
    row("Refund", "B", "b2", "-10.00", "1.40"),
    row("Shipping label", "B", net="-5.72"),
    # C: refund only, with a return label -> the label is an orphan cost
    row("Refund", "C", "c1", "(8.00)", "1.10"),
    row("Shipping label", "C", net="-6.00"),
]


def main():
    assert split(5.00, [1, 1, 1]) == [1.67, 1.67, 1.66]
    assert split(0.78, [0, 0]) == [0.39, 0.39]
    assert split(5.72, []) == []

    fd, path = tempfile.mkstemp(suffix=".csv")
    with os.fdopen(fd, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["Notes preamble"])
        w.writerow(COLS)
        w.writerows(ROWS)
    try:
        rows, _, orphans = parse(path)
    finally:
        os.remove(path)
    by = {r["source_ref"]: r for r in rows}

    assert [by[t]["shipping_cost"] for t in ("a1", "a2", "a3")] == [1.67, 1.67, 1.66]
    assert by["b1"]["shipping_cost"] == 5.72
    assert by["b2"]["shipping_cost"] == 0
    assert by["b2"]["item_amount"] == 10.00          # stored positive
    assert by["c1"]["item_amount"] == 8.00 and by["c1"]["shipping_cost"] == 0
    assert set(orphans) == {"C"} and orphans["C"]["amount"] == 6.00
    # sale B nets 10 - 1.40 - 5.72; its refund gives back 10 - 1.40
    assert round(net_cash(by["b1"]) + net_cash(by["b2"]), 2) == -5.72
    print("ok")


if __name__ == "__main__":
    main()
