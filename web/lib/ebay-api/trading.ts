import { ApiError, EbayApiError, type EbayErrorItem } from "./errors";
import type { FetchLike } from "./http";

// LEGACY Trading API (XML), isolated in this one file.
//
// Why it exists: the Inventory API only returns listings created through the
// Inventory API. Card Dealer Pro's own eBay push, Seller Hub and File
// Exchange listings are invisible to it. GetMyeBaySelling's ActiveList sees
// every active listing on the account, whatever created it.
//
// Auth: the OAuth *user* access token in X-EBAY-API-IAF-TOKEN (no Auth'n'Auth
// token needed). The XML is parsed minimally with regexes — only the handful
// of fields we normalise — rather than pulling in an XML dependency for one
// legacy call. Trading is in maintenance mode at eBay; if it is ever retired,
// delete this file and the `trading` source in listings.ts.

export const TRADING_COMPAT_LEVEL = "1193"; // matches the CDP export's FX Version
const ENTRIES_PER_PAGE = 200;

export interface TradingListing {
  itemId: string;
  title: string;
  sku: string | null;
  price: string | null;
  currency: string | null;
  quantityAvailable: number | null;
  quantity: number | null;
  listingType: string | null;
  startTime: string | null;
  url: string | null;
}

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}

/** First <Tag ...>value</Tag> inside `xml` (non-greedy, namespace-agnostic). */
export function tag(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? decode(m[1].trim()) : null;
}

function attr(xml: string, name: string, attribute: string): string | null {
  const m = new RegExp(`<${name}\\s[^>]*${attribute}="([^"]*)"`).exec(xml);
  return m ? m[1] : null;
}

function blocks(xml: string, name: string): string[] {
  return [...xml.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "g"))].map((m) => m[1]);
}

/** Raw inner XML of the first <name> element — containers must not be entity-decoded before parsing. */
function raw(xml: string, name: string): string {
  return blocks(xml, name)[0] ?? "";
}

const num = (s: string | null) => (s === null || s === "" || Number.isNaN(Number(s)) ? null : Number(s));

export function parseActiveList(xml: string): { items: TradingListing[]; totalPages: number } {
  const ack = tag(xml, "Ack");
  if (ack !== "Success" && ack !== "Warning") {
    const errors: EbayErrorItem[] = blocks(xml, "Errors").map((e) => ({
      errorId: num(tag(e, "ErrorCode")) ?? undefined,
      message: tag(e, "ShortMessage") ?? undefined,
      longMessage: tag(e, "LongMessage") ?? undefined,
      category: tag(e, "ErrorClassification") ?? undefined,
    }));
    // Trading reports most failures as HTTP 200 + Ack=Failure. Token problems
    // (931 / 21916984 family) are auth; everything else is a bad request.
    const authCodes = new Set([931, 932, 16110, 21916984, 21917053]);
    const isAuth = errors.some((e) => e.errorId !== undefined && authCodes.has(e.errorId));
    throw new EbayApiError(isAuth ? 401 : 400, errors, "GetMyeBaySelling");
  }
  const active = raw(xml, "ActiveList");
  const items = blocks(active, "Item").map((it): TradingListing => {
    const selling = raw(it, "SellingStatus");
    const details = raw(it, "ListingDetails");
    const price = tag(selling, "CurrentPrice") ?? tag(it, "BuyItNowPrice");
    return {
      itemId: tag(it, "ItemID") ?? "",
      title: tag(it, "Title") ?? "",
      sku: tag(it, "SKU"),
      price,
      currency: attr(selling, "CurrentPrice", "currencyID") ?? attr(it, "BuyItNowPrice", "currencyID"),
      quantityAvailable: num(tag(it, "QuantityAvailable")),
      quantity: num(tag(it, "Quantity")),
      listingType: tag(it, "ListingType"),
      startTime: tag(details, "StartTime"),
      url: tag(details, "ViewItemURL"),
    };
  });
  const pagination = raw(active, "PaginationResult");
  return { items, totalPages: num(tag(pagination, "TotalNumberOfPages")) ?? 1 };
}

export function activeListRequest(page: number): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ActiveList>
    <Include>true</Include>
    <Pagination><EntriesPerPage>${ENTRIES_PER_PAGE}</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination>
  </ActiveList>
  <DetailLevel>ReturnAll</DetailLevel>
  <ErrorLanguage>en_US</ErrorLanguage>
</GetMyeBaySellingRequest>`;
}

export async function getActiveListings(o: {
  endpoint: string;
  fetch: FetchLike;
  token: () => Promise<string>;
  maxPages?: number;
}): Promise<TradingListing[]> {
  const out: TradingListing[] = [];
  const maxPages = o.maxPages ?? 10;
  for (let page = 1; page <= maxPages; page++) {
    const token = await o.token();
    let res: Response;
    try {
      res = await o.fetch(o.endpoint, {
        method: "POST",
        headers: {
          "content-type": "text/xml",
          "x-ebay-api-compatibility-level": TRADING_COMPAT_LEVEL,
          "x-ebay-api-call-name": "GetMyeBaySelling",
          "x-ebay-api-siteid": "0",
          "x-ebay-api-iaf-token": token,
        },
        body: activeListRequest(page),
        signal: AbortSignal.timeout(25_000),
      });
    } catch {
      throw new ApiError(502, "ebay_unreachable", "GetMyeBaySelling: eBay unreachable");
    }
    const xml = await res.text();
    if (!res.ok && !xml.includes("<Ack>")) throw new EbayApiError(res.status, [], "GetMyeBaySelling");
    const { items, totalPages } = parseActiveList(xml);
    out.push(...items);
    if (page >= totalPages) break;
  }
  return out;
}
