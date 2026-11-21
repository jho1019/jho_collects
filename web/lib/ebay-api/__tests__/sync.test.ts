import { describe, expect, it } from "vitest";
import { normaliseOrder, type RawOrder, type SaleOrder } from "../fulfillment";
import { runSync, type CloseResult, type SyncRepo, type SyncedLineWrite } from "../sync/run";
import type { CardRef, FuzzyCandidate, LedgerSale, SyncedLine } from "../sync/types";

// In-memory stand-in for the Supabase tables the sync touches. closeCard
// mirrors schema/024's ebay_close_card_for_sale rules. The fake has NO way to
// insert a transaction — mirroring the real repo, which has none either.

interface Card { id: number; sku: string | null; title: string; status: string; sale_transaction_id: number | null; exited_on: string | null }
interface Txn { id: number; type: "sale" | "refund"; platform: "ebay"; order_ref: string; item_number: string | null; occurred_on: string; item_amount: string }

class FakeDb implements SyncRepo {
  cards: Card[] = [];
  txns: Txn[] = [];
  synced = new Map<string, SyncedLineWrite>();
  links: { listingId: string | null; sku: string; cardId: number }[] = [];
  state: { cursorAt: Date | null; lastStatus?: string } = { cursorAt: null };
  writes = 0;
  closes = 0;
  fuzzyCalls: string[] = [];

  async getState() { return { cursorAt: this.state.cursorAt }; }
  async saveState(_e: string, s: { cursorAt?: Date; lastStatus: string }) {
    if (s.cursorAt) this.state.cursorAt = s.cursorAt;
    this.state.lastStatus = s.lastStatus;
  }
  private toSynced(w: SyncedLineWrite): SyncedLine {
    return { ...w, title: w.title, matchType: w.matchType };
  }
  async getSyncedLines(_e: string, keys: { orderId: string; lineItemId: string }[]) {
    return keys.map((k) => this.synced.get(`${k.orderId}#${k.lineItemId}`)).filter((x): x is SyncedLineWrite => Boolean(x)).map((w) => this.toSynced(w));
  }
  async getPendingLines() {
    return [...this.synced.values()].filter((w) => w.status === "pending_ledger").map((w) => this.toSynced(w));
  }
  async getLedgerSales(orderIds: string[]): Promise<LedgerSale[]> {
    return this.txns.filter((t) => t.type === "sale" && orderIds.includes(t.order_ref)).map((t) => ({
      id: t.id, orderRef: t.order_ref, itemNumber: t.item_number, occurredOn: t.occurred_on,
      linkedCardId: this.cards.find((c) => c.sale_transaction_id === t.id)?.id ?? null,
    }));
  }
  private ref(c: Card): CardRef { return { id: c.id, sku: c.sku, title: c.title, status: c.status, saleTransactionId: c.sale_transaction_id }; }
  async getCardsBySku(skus: string[]) { return this.cards.filter((c) => c.sku && skus.includes(c.sku)).map((c) => this.ref(c)); }
  async getCardsById(ids: number[]) { return this.cards.filter((c) => ids.includes(c.id)).map((c) => this.ref(c)); }
  async getListingLinks(_e: string, q: { listingIds: string[]; skus: string[] }) {
    return this.links.filter((l) => (l.listingId && q.listingIds.includes(l.listingId)) || q.skus.includes(l.sku));
  }
  /** Crude stand-in for find_cards: every word of the card title appears in the eBay title. */
  async findCards(title: string): Promise<FuzzyCandidate[]> {
    this.fuzzyCalls.push(title);
    const t = title.toLowerCase();
    return this.cards
      .filter((c) => !["sold", "traded"].includes(c.status) && c.title.toLowerCase().split(" ").every((w) => t.includes(w)))
      .map((c) => ({ id: c.id, sku: c.sku, title: c.title, matchType: "fuzzy" as const, score: 0.7 }));
  }
  async closeCard(cardId: number, transactionId: number): Promise<CloseResult> {
    const c = this.cards.find((x) => x.id === cardId);
    const t = this.txns.find((x) => x.id === transactionId);
    if (!c || !t || t.type !== "sale") return { result: "conflict", message: "card or sale not found" };
    if (["sold", "traded"].includes(c.status)) {
      return c.sale_transaction_id === transactionId ? { result: "already_closed" } : { result: "conflict", message: "card already left inventory" };
    }
    if (this.cards.some((x) => x.sale_transaction_id === transactionId)) return { result: "conflict", message: "sale linked to another card" };
    Object.assign(c, { status: "sold", sale_transaction_id: transactionId, exited_on: t.occurred_on });
    this.closes++;
    return { result: "closed" };
  }
  async upsertLine(_e: string, row: SyncedLineWrite) {
    this.writes++;
    this.synced.set(`${row.orderId}#${row.lineItemId}`, { ...row });
  }
  txnCount() { return this.txns.length; }
}

const NOW = new Date("2026-11-21T14:00:00Z");

function card(id: number, title: string, sku: string | null = null, status = "listed"): Card {
  return { id, sku, title, status, sale_transaction_id: null, exited_on: null };
}

function rawOrder(orderId: string, lines: { id: string; item: string; sku?: string; title: string; qty?: number; refunded?: boolean }[], extra: Partial<RawOrder> = {}): SaleOrder {
  return normaliseOrder({
    orderId, creationDate: "2026-11-20T18:00:00.000Z", lastModifiedDate: "2026-11-20T18:05:00.000Z",
    orderPaymentStatus: "PAID", cancelStatus: { cancelState: "NONE_REQUESTED" },
    lineItems: lines.map((l) => ({
      lineItemId: l.id, legacyItemId: l.item, sku: l.sku, title: l.title, quantity: l.qty ?? 1,
      lineItemCost: { value: "10.00", currency: "USD" },
      refunds: l.refunded ? [{ amount: { value: "10.00", currency: "USD" } }] : [],
    })),
    ...extra,
  });
}

function sale(id: number, orderRef: string, itemNumber: string | null): Txn {
  return { id, type: "sale", platform: "ebay", order_ref: orderRef, item_number: itemNumber, occurred_on: "2026-11-20", item_amount: "10.00" };
}

function deps(db: FakeDb, orders: SaleOrder[]) {
  const sinces: Date[] = [];
  return {
    sinces,
    d: {
      environment: "production" as const,
      repo: db,
      now: () => NOW,
      fetchOrders: async (since: Date) => {
        sinces.push(since);
        return orders;
      },
    },
  };
}

const status = (db: FakeDb, k: string) => db.synced.get(k)?.status;

describe("sold-order sync", () => {
  it("links a new sale by SKU and closes the card against the importer's sale row", async () => {
    const db = new FakeDb();
    db.cards = [card(1, "Graham Mertz Pink", "204-19tvfb")];
    db.txns = [sale(100, "07-11111-11111", "3550001")];
    const { d } = deps(db, [rawOrder("07-11111-11111", [{ id: "L1", item: "3550001", sku: "204-19tvfb", title: "2025 Donruss #347 Graham Mertz" }])]);
    const r = await runSync(d, { dryRun: false });
    expect(r.counts).toEqual({ closed: 1 });
    expect(db.cards[0]).toMatchObject({ status: "sold", sale_transaction_id: 100, exited_on: "2026-11-20" });
    expect(db.synced.get("07-11111-11111#L1")).toMatchObject({ status: "closed", cardId: 1, transactionId: 100, matchType: "sku" });
    expect(db.txnCount()).toBe(1);
    expect(r.cursor_advanced).toBe(true);
    expect(db.fuzzyCalls).toHaveLength(0);
  });

  it("holds a matched card as pending_ledger until the report import lands, then closes it", async () => {
    const db = new FakeDb();
    db.cards = [card(1, "Graham Mertz Pink", "204-19tvfb")];
    const order = rawOrder("07-22222-22222", [{ id: "L1", item: "3550001", sku: "204-19tvfb", title: "Mertz" }]);
    const { d } = deps(db, [order]);
    expect((await runSync(d, { dryRun: false })).counts).toEqual({ pending_ledger: 1 });
    expect(db.cards[0].status).toBe("listed"); // cannot be sold without a sale row (CHECK constraint)

    db.txns.push(sale(200, "07-22222-22222", "3550001")); // weekly report import
    const { d: d2 } = deps(db, []); // order is now outside the fetch window
    const r2 = await runSync(d2, { dryRun: false });
    expect(r2.counts).toEqual({ closed: 1 });
    expect(db.cards[0]).toMatchObject({ status: "sold", sale_transaction_id: 200 });
  });

  it("closes on a single fuzzy title match and reports it for a glance", async () => {
    const db = new FakeDb();
    db.cards = [card(7, "ashton jeanty green"), card(8, "quinn ewers")];
    db.txns = [sale(300, "07-33333-33333", "3550005")];
    const { d } = deps(db, [rawOrder("07-33333-33333", [{ id: "L1", item: "3550005", title: "2025 Donruss #305 Ashton Jeanty Press Proofs Green" }])]);
    const r = await runSync(d, { dryRun: false });
    expect(r.counts).toEqual({ closed: 1 });
    expect(db.cards[0]).toMatchObject({ status: "sold", sale_transaction_id: 300 });
    expect(r.fuzzy_matches).toEqual([expect.objectContaining({ card_id: 7, match_type: "fuzzy", score: 0.7 })]);
  });

  it("marks an ambiguous title needs_review, lists candidates and closes nothing", async () => {
    const db = new FakeDb();
    db.cards = [card(1, "michael jordan psa 10"), card(2, "michael jordan psa 10")];
    db.txns = [sale(400, "07-44444-44444", "3550010")];
    const { d } = deps(db, [rawOrder("07-44444-44444", [{ id: "L1", item: "3550010", title: "1997 Michael Jordan PSA 10" }])]);
    const r = await runSync(d, { dryRun: false });
    expect(r.counts).toEqual({ needs_review: 1 });
    expect(r.decisions[0].candidates!.map((c) => c.id)).toEqual([1, 2]);
    expect(db.cards.every((c) => c.status === "listed")).toBe(true);
    expect(db.closes).toBe(0);
  });

  it("marks no match needs_review (never blocks, never guesses)", async () => {
    const db = new FakeDb();
    db.cards = [card(1, "quinn ewers")];
    db.txns = [sale(500, "07-55555-55555", "3550011")];
    const { d } = deps(db, [rawOrder("07-55555-55555", [{ id: "L1", item: "3550011", title: "Bulk lot 50 commons" }])]);
    const r = await runSync(d, { dryRun: false });
    expect(r.decisions[0]).toMatchObject({ status: "needs_review", reason: expect.stringMatching(/no_card_match/), transaction_id: 500 });
    expect(db.cards[0].status).toBe("listed");
  });

  it("drops a fuzzy candidate whose own SKU contradicts the sold SKU", async () => {
    const db = new FakeDb();
    db.cards = [card(1, "quinn ewers", "OTHER-SKU")];
    db.txns = [sale(510, "07-55556-55556", "3550012")];
    const { d } = deps(db, [rawOrder("07-55556-55556", [{ id: "L1", item: "3550012", sku: "UNKNOWN-SKU", title: "2025 Donruss Quinn Ewers" }])]);
    const r = await runSync(d, { dryRun: false });
    expect(r.decisions[0].reason).toMatch(/no_card_match/);
  });

  it("an order already imported by the report (card closed by SKU) is not double-counted or re-closed", async () => {
    const db = new FakeDb();
    db.txns = [sale(600, "07-66666-66666", "3550020")];
    db.cards = [{ ...card(1, "Egbuka Bomb Squad", "203-19tvfa"), status: "sold", sale_transaction_id: 600, exited_on: "2026-11-20" }];
    // a lookalike unsold card must NOT be picked up by fuzzy matching
    db.cards.push(card(2, "egbuka bomb squad"));
    const { d } = deps(db, [rawOrder("07-66666-66666", [{ id: "L1", item: "3550020", sku: "203-19tvfa", title: "2025 Donruss Emeka Egbuka Bomb Squad" }])]);
    const r = await runSync(d, { dryRun: false });
    expect(r.counts).toEqual({ already_closed: 1 });
    expect(db.synced.get("07-66666-66666#L1")).toMatchObject({ status: "already_closed", cardId: 1, transactionId: 600 });
    expect(db.cards[1].status).toBe("listed");
    expect(db.txnCount()).toBe(1);
    expect(db.closes).toBe(0);
    expect(db.fuzzyCalls).toHaveLength(0);
  });

  it("trusts the importer's link even when the API line carries no SKU (no fuzzy lookalike close)", async () => {
    const db = new FakeDb();
    db.txns = [sale(610, "07-66667-66667", "3550021")];
    db.cards = [{ ...card(1, "egbuka bomb squad", "203-19tvfa"), status: "sold", sale_transaction_id: 610, exited_on: "2026-11-20" }, card(2, "egbuka bomb squad")];
    const r = await runSync(deps(db, [rawOrder("07-66667-66667", [{ id: "L1", item: "3550021", title: "Emeka Egbuka Bomb Squad" }])]).d, { dryRun: false });
    expect(r.decisions[0]).toMatchObject({ status: "already_closed", card_id: 1, match_type: "ledger" });
    expect(db.fuzzyCalls).toHaveLength(0);
  });

  it("re-running is a no-op: no writes, no closes", async () => {
    const db = new FakeDb();
    db.cards = [card(1, "Mertz", "204-19tvfb"), card(2, "x"), card(3, "michael jordan"), card(4, "michael jordan")];
    db.txns = [sale(700, "07-77777-77777", "3550030"), sale(701, "07-77778-77778", "3550031")];
    const orders = [
      rawOrder("07-77777-77777", [{ id: "L1", item: "3550030", sku: "204-19tvfb", title: "Mertz" }]),
      rawOrder("07-77778-77778", [{ id: "L1", item: "3550031", title: "Michael Jordan" }]),
      rawOrder("07-77779-77779", [{ id: "L1", item: "3550032", title: "Cancelled card" }], { cancelStatus: { cancelState: "CANCELED" } }),
    ];
    await runSync(deps(db, orders).d, { dryRun: false });
    const writes = db.writes;
    const snapshot = JSON.stringify([...db.synced.entries()]);
    const r2 = await runSync(deps(db, orders).d, { dryRun: false });
    expect(r2.counts).toEqual({ noop: 3 });
    expect(db.writes).toBe(writes);
    expect(db.closes).toBe(1);
    expect(JSON.stringify([...db.synced.entries()])).toBe(snapshot);
  });

  it("ignores cancelled and refunded orders, defers unpaid ones", async () => {
    const db = new FakeDb();
    db.cards = [card(1, "a", "SKU-A"), card(2, "b", "SKU-B"), card(3, "c", "SKU-C"), card(4, "d", "SKU-D")];
    const { d } = deps(db, [
      rawOrder("o-cancel", [{ id: "L1", item: "1", sku: "SKU-A", title: "a" }], { cancelStatus: { cancelState: "CANCELED" } }),
      rawOrder("o-refund", [{ id: "L1", item: "2", sku: "SKU-B", title: "b" }], { orderPaymentStatus: "FULLY_REFUNDED" }),
      rawOrder("o-linerefund", [{ id: "L1", item: "3", sku: "SKU-C", title: "c", refunded: true }], { orderPaymentStatus: "PARTIALLY_REFUNDED" }),
      rawOrder("o-unpaid", [{ id: "L1", item: "4", sku: "SKU-D", title: "d" }], { orderPaymentStatus: "PENDING" }),
    ]);
    const r = await runSync(d, { dryRun: false });
    expect(r.counts).toEqual({ ignored: 3, defer: 1 });
    expect(status(db, "o-unpaid#L1")).toBeUndefined(); // no row: retried when the order changes
    expect(db.cards.every((c) => c.status === "listed")).toBe(true);
  });

  it("flags a refund that arrives after the card was closed", async () => {
    const db = new FakeDb();
    db.cards = [card(1, "Mertz", "204-19tvfb")];
    db.txns = [sale(800, "07-88888-88888", "3550040")];
    const line = [{ id: "L1", item: "3550040", sku: "204-19tvfb", title: "Mertz" }];
    await runSync(deps(db, [rawOrder("07-88888-88888", line)]).d, { dryRun: false });
    const r = await runSync(deps(db, [rawOrder("07-88888-88888", line, { orderPaymentStatus: "FULLY_REFUNDED" })]).d, { dryRun: false });
    expect(r.decisions[0]).toMatchObject({ status: "needs_review", reason: expect.stringMatching(/refunded_after_close/), card_id: 1 });
    // and that flag is itself terminal
    expect((await runSync(deps(db, [rawOrder("07-88888-88888", line, { orderPaymentStatus: "FULLY_REFUNDED" })]).d, { dryRun: false })).counts).toEqual({ noop: 1 });
  });

  it("handles multi-line orders: each line matches its own sale row by item number", async () => {
    const db = new FakeDb();
    db.cards = [card(1, "Mertz", "SKU-1"), card(2, "Ewers", "SKU-2"), card(3, "michael jordan")];
    db.links = [{ listingId: "3550052", sku: "CDP-JORDAN", cardId: 3 }];
    db.txns = [sale(901, "07-99999-99999", "3550050"), sale(902, "07-99999-99999", "3550051"), sale(903, "07-99999-99999", "3550052")];
    const { d } = deps(db, [rawOrder("07-99999-99999", [
      { id: "L1", item: "3550050", sku: "SKU-1", title: "Mertz" },
      { id: "L2", item: "3550051", sku: "SKU-2", title: "Ewers" },
      { id: "L3", item: "3550052", sku: "CDP-JORDAN", title: "Jordan" },
      { id: "L4", item: "3550053", title: "Bulk commons", qty: 3 },
    ])]);
    const r = await runSync(d, { dryRun: false });
    expect(r.counts).toEqual({ closed: 3, needs_review: 1 });
    expect(db.cards.map((c) => c.sale_transaction_id)).toEqual([901, 902, 903]);
    expect(r.decisions[2].match_type).toBe("listing");
    expect(r.decisions[3].reason).toMatch(/multi_quantity_line/);
  });

  it("dry run returns the plan and writes nothing", async () => {
    const db = new FakeDb();
    db.cards = [card(1, "Mertz", "204-19tvfb")];
    db.txns = [sale(100, "07-11111-11111", "3550001")];
    const { d } = deps(db, [rawOrder("07-11111-11111", [{ id: "L1", item: "3550001", sku: "204-19tvfb", title: "Mertz" }])]);
    const r = await runSync(d, { dryRun: true });
    expect(r.decisions[0]).toMatchObject({ action: "close", status: "closed", card_id: 1, transaction_id: 100 });
    expect(db.writes).toBe(0);
    expect(db.cards[0].status).toBe("listed");
    expect(db.state.cursorAt).toBeNull();
  });

  it("does not advance the cursor when a line fails, and overlaps the next fetch", async () => {
    const db = new FakeDb();
    db.cards = [card(1, "Mertz", "204-19tvfb")];
    db.txns = [sale(100, "o1", "1")];
    db.upsertLine = async () => { throw new Error("db unavailable"); };
    const { d } = deps(db, [rawOrder("o1", [{ id: "L1", item: "1", sku: "204-19tvfb", title: "Mertz" }])]);
    const r = await runSync(d, { dryRun: false });
    expect(r.errors).toHaveLength(1);
    expect(r.cursor_advanced).toBe(false);
    expect(db.state).toMatchObject({ cursorAt: null, lastStatus: "error" });

    const ok = new FakeDb();
    ok.state.cursorAt = new Date("2026-11-21T00:00:00Z");
    const { d: d2, sinces } = deps(ok, []);
    await runSync(d2, { dryRun: false });
    expect(sinces[0].toISOString()).toBe("2026-11-20T23:00:00.000Z");
    expect(ok.state.cursorAt).toEqual(NOW);
  });

  it("a close the database rejects becomes needs_review, not a crash", async () => {
    const db = new FakeDb();
    db.cards = [card(1, "Mertz", "204-19tvfb")];
    db.txns = [sale(100, "o1", "1")];
    db.closeCard = async () => ({ result: "conflict", message: "sale 100 is linked to card 9" });
    const r = await runSync(deps(db, [rawOrder("o1", [{ id: "L1", item: "1", sku: "204-19tvfb", title: "Mertz" }])]).d, { dryRun: false });
    expect(r.decisions[0]).toMatchObject({ status: "needs_review", reason: expect.stringMatching(/close_conflict/) });
    expect(status(db, "o1#L1")).toBe("needs_review");
  });
});
