import { moneyCell } from "../money";
import type { Amount } from "../http";
import { usd } from "../http";
import { buildCondition, type ConditionDescriptor } from "./conditions";
import type { CdpRow } from "./mapping";

// Canonical CDP row -> the exact Inventory API payloads:
//   inventory item  PUT  /sell/inventory/v1/inventory_item/{sku}
//                        (sent via bulk_create_or_replace_inventory_item)
//   offer           POST /sell/inventory/v1/offer   (via bulk_create_offer)
//
// Pure: no I/O, no env. Policy IDs are passed in already resolved (or null
// in a dry run that has none configured).

export const DEFAULT_CATEGORY_ID = "261328"; // Sports Trading Cards > Single Cards
const TITLE_MAX = 80;
const PRODUCT_DESCRIPTION_MAX = 4000;
const IMAGES_MAX = 24;
const SKU_MAX = 50;

export interface InventoryItemPayload {
  sku: string;
  locale: "en_US";
  product: {
    title: string;
    description?: string;
    aspects: Record<string, string[]>;
    imageUrls: string[];
  };
  condition: string;
  conditionDescriptors: ConditionDescriptor[];
  availability: { shipToLocationAvailability: { quantity: number } };
}

export interface PolicyIds {
  fulfillmentPolicyId: string | null;
  paymentPolicyId: string | null;
  returnPolicyId: string | null;
  merchantLocationKey: string | null;
}

export interface OfferPayload {
  sku: string;
  marketplaceId: string;
  format: "FIXED_PRICE";
  availableQuantity: number;
  categoryId: string;
  listingDescription?: string;
  listingDuration: "GTC";
  pricingSummary: { price: Amount };
  listingPolicies: {
    fulfillmentPolicyId: string | null;
    paymentPolicyId: string | null;
    returnPolicyId: string | null;
    bestOfferTerms?: { bestOfferEnabled: boolean; autoAcceptPrice?: Amount; autoDeclinePrice?: Amount };
  };
  merchantLocationKey: string | null;
}

export interface BuiltRow {
  line: number;
  sku: string;
  title: string;
  quantity: number;
  price: string | null;
  graded: boolean | null;
  errors: string[];
  warnings: string[];
  /** Quantity 0: valid, but the Inventory API cannot publish it. Skipped by default. */
  zeroQuantity: boolean;
  inventoryItem?: InventoryItemPayload;
  offer?: OfferPayload;
  card: { player?: string; year?: string; set?: string; cardNumber?: string; parallel?: string; grader?: string; grade?: string };
}

const truthy = (v?: string) => /^(1|y|yes|true)$/i.test((v ?? "").trim());

/** PicURL: several URLs separated by `|` (CDP writes " | "), also `;`. */
export function splitPhotos(v: string | undefined): string[] {
  return (v ?? "").split(/[|;]/).map((s) => s.trim()).filter(Boolean);
}

export function buildRow(row: CdpRow, policies: PolicyIds, marketplaceId: string): BuiltRow {
  const f = row.fields;
  const errors: string[] = [];
  const warnings: string[] = [];
  const sku = f.sku ?? "";
  const title = f.title ?? "";

  const action = (f.action ?? "Add").trim();
  if (action && !/^(add|verifyadd)$/i.test(action)) {
    errors.push(`Action "${action}" is not supported; only Add (create-or-replace)`);
  }
  if (!sku) errors.push("CustomLabel (SKU) is empty");
  else if (sku.length > SKU_MAX) errors.push(`SKU is ${sku.length} chars; eBay allows ${SKU_MAX}`);
  if (!title) errors.push("Title is empty");
  else if (title.length > TITLE_MAX) errors.push(`Title is ${title.length} chars; eBay allows ${TITLE_MAX}`);

  const price = moneyCell(f.price);
  if (!price) errors.push(`StartPrice "${f.price ?? ""}" is not a positive price`);

  let quantity = 1;
  if (f.quantity === undefined) warnings.push("no Quantity column; using 1");
  else if (!/^\d+$/.test(f.quantity)) errors.push(`Quantity "${f.quantity}" is not a whole number`);
  else quantity = Number(f.quantity);
  const zeroQuantity = quantity === 0 && !errors.some((e) => e.startsWith("Quantity"));
  if (zeroQuantity) warnings.push("Quantity is 0: the Inventory API cannot publish it; row skipped (not sent to eBay)");

  const format = (f.format ?? "FixedPrice").trim();
  if (!/^(fixedprice|fixed_price|fixed price|bin|buyitnow)$/i.test(format)) {
    errors.push(`Format "${format}" is not supported; only FixedPrice`);
  }
  const duration = (f.duration ?? "GTC").trim();
  if (duration && !/^gtc$/i.test(duration)) warnings.push(`Duration "${duration}" ignored; fixed-price listings are always GTC`);

  const categoryId = (f.category_id || DEFAULT_CATEGORY_ID).trim();
  if (!/^\d+$/.test(categoryId)) errors.push(`Category "${categoryId}" is not a numeric eBay category id`);
  else if (categoryId !== DEFAULT_CATEGORY_ID) warnings.push(`Category ${categoryId} is not ${DEFAULT_CATEGORY_ID}; condition descriptors assume trading cards`);

  const photos = splitPhotos(f.photos);
  if (!photos.length) errors.push("no photo URLs (PicURL); eBay requires at least one");
  if (photos.length > IMAGES_MAX) errors.push(`${photos.length} photos; eBay allows ${IMAGES_MAX}`);
  for (const p of photos) if (!/^https:\/\//i.test(p)) errors.push(`photo URL must be https: ${p}`);

  // Condition descriptors come from CD:/CDA: columns, or canonical fields in a non-FX CSV.
  const desc = (id: string) => row.descriptors.find((d) => d.id === id)?.value;
  const cond = buildCondition({
    conditionId: f.condition_id,
    graded: f.graded,
    grader: desc("27501") ?? f.grader,
    grade: desc("27502") ?? f.grade,
    certNumber: desc("27503") ?? f.cert_number,
    cardCondition: desc("40001") ?? f.card_condition,
  });
  if (!cond.ok) errors.push(...cond.errors);

  // Best offer: MinimumBestOfferPrice is eBay's auto-decline threshold.
  let bestOfferTerms: OfferPayload["listingPolicies"]["bestOfferTerms"];
  if (truthy(f.best_offer_enabled)) {
    const accept = moneyCell(f.best_offer_auto_accept);
    const decline = moneyCell(f.best_offer_auto_decline);
    if (f.best_offer_auto_accept && !accept) errors.push(`BestOfferAutoAcceptPrice "${f.best_offer_auto_accept}" is not a price`);
    if (f.best_offer_auto_decline && !decline) errors.push(`MinimumBestOfferPrice "${f.best_offer_auto_decline}" is not a price`);
    const cents = (s: string) => Math.round(Number(s) * 100);
    if (accept && price && cents(accept) >= cents(price)) errors.push("best offer auto-accept must be below the price");
    if (accept && decline && cents(decline) >= cents(accept)) errors.push("best offer auto-decline must be below auto-accept");
    bestOfferTerms = {
      bestOfferEnabled: true,
      ...(accept ? { autoAcceptPrice: usd(accept) } : {}),
      ...(decline ? { autoDeclinePrice: usd(decline) } : {}),
    };
  }

  const description = f.description?.trim() || undefined;
  const card = {
    player: f.player, year: f.year, set: f.set, cardNumber: f.card_number,
    parallel: f.parallel, grader: desc("27501") ?? f.grader, grade: desc("27502") ?? f.grade,
  };
  const base: BuiltRow = {
    line: row.line, sku, title, quantity, price, graded: cond.ok ? cond.value.graded : null,
    errors, warnings, zeroQuantity, card,
  };
  if (errors.length || !cond.ok || !price) return base;

  const aspects: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(row.aspects)) if (v.length) aspects[k] = v;
  aspects.Graded = [cond.value.graded ? "Yes" : "No"];

  let productDescription = description;
  if (description && description.length > PRODUCT_DESCRIPTION_MAX) {
    productDescription = undefined;
    warnings.push(`description is ${description.length} chars; sent only as the listing description (product.description max ${PRODUCT_DESCRIPTION_MAX})`);
  }

  base.inventoryItem = {
    sku,
    locale: "en_US",
    product: {
      title,
      ...(productDescription ? { description: productDescription } : {}),
      aspects,
      imageUrls: photos,
    },
    condition: cond.value.condition,
    conditionDescriptors: cond.value.conditionDescriptors,
    availability: { shipToLocationAvailability: { quantity } },
  };
  base.offer = {
    sku,
    marketplaceId,
    format: "FIXED_PRICE",
    availableQuantity: quantity,
    categoryId,
    ...(description ? { listingDescription: description } : {}),
    listingDuration: "GTC",
    pricingSummary: { price: usd(price) },
    listingPolicies: {
      fulfillmentPolicyId: policies.fulfillmentPolicyId,
      paymentPolicyId: policies.paymentPolicyId,
      returnPolicyId: policies.returnPolicyId,
      ...(bestOfferTerms ? { bestOfferTerms } : {}),
    },
    merchantLocationKey: policies.merchantLocationKey,
  };
  return base;
}

export function findDuplicateSkus(rows: BuiltRow[]): Set<string> {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const r of rows) {
    if (!r.sku) continue;
    if (seen.has(r.sku)) dup.add(r.sku);
    seen.add(r.sku);
  }
  return dup;
}
