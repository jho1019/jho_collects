# Verification fixtures

Three transactions with hand-checked results. Used to verify both the
spreadsheet and the SQL schema. Use them again after any change to `net_cash`
or `tax_summary`.

```sql
insert into transactions
  (occurred_on, type, platform, description, qty,
   item_amount, shipping_charged, sales_tax_collected,
   platform_fees, shipping_cost, other_cost)
values
  ('2026-08-15','purchase','ebay','Single rookie card',1, 50,0,0, 0,3,0),
  ('2026-09-01','purchase','card_show','Bulk lot 15 commons',15, 10,0,0, 0,0,0),
  ('2026-09-02','sale','ebay','Rookie card sold',1, 15,4.50,1.20, 2.60,0.90,0);
```

Expected:

| | |
|---|---|
| net cash position | -47.00 |
| running total by date | -53.00, -63.00, -47.00 |
| eBay gross receipts (2026) | 20.70 |
| sales tax collected | 1.20 |
| adjusted gross receipts | 19.50 |
| purchases (COGS input) | 63.00 |
| platform fees | 2.60 |
| postage on sales | 0.90 |
| net profit (ending inventory 0) | -47.00 |

Net profit equals net cash **only because ending inventory is zero**. Once
`inventory_counts` has a row they diverge, and that divergence is the point.

Also confirm the constraint bites:

```sql
-- must fail: buyer-side fields on a purchase
insert into transactions
  (occurred_on, type, platform, description, item_amount, sales_tax_collected)
values ('2026-09-05','purchase','ebay','bad row', 5, 1);
```
