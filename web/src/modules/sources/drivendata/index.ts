import { load } from "cheerio";
import { parseContestInput, type ContestInput } from "@/modules/listings/public";
import type { Fetcher } from "@/platform/fetch";
import { codePoints } from "../shared/json";
import { htmlText } from "../shared/html";
import { pageHtml, pageRequest } from "../shared/job-pages";
import { setAside } from "../shared/set-aside";
import { SourceError, type Collected, type PageSourceSettings } from "../types";

// DrivenData: one public list page holds every competition, open and completed, as cards (opportunity types
// plan step 6b; measured 2026-11-22 without following redirects: 75 cards, 9 active of which 3 with prizes).
// Each card carries its state and reward kind in `data-status_*` / `data-reward_*` attributes and its end
// day in `data-deadline` (`-1YYYYMMDD` on an active card). The connector keeps the active prize competitions;
// practice competitions (no prize) and benchmarks are not opportunities and are skipped. The end instant is
// read from the competition's own page (`Competition End Date Dec. 3, 2026, 10 p.m. UTC`); a card hosted on
// another site, or a page whose end the connector cannot read, keeps the card's end day (a date deadline).
// The list gives no region, age or student rule and no place: those stay unknown (null).

export const ORIGIN = "https://www.drivendata.org";
export const LIST_URL = `${ORIGIN}/competitions/`;
/** One list page plus one page per open prize competition (3 on 2026-11-22). */
export const MAX_DETAILS = 20;

const CURRENCY: Record<string, string> = { $: "USD", "€": "EUR", "£": "GBP" };

/** `$50,000` / `€25,000` / `£585,000` as an amount and currency; any other text keeps the text only. */
export function prizeOf(text: string | null): Pick<ContestInput, "prize_text" | "budget_max" | "currency"> {
  if (!text || codePoints(text) > 200) return { prize_text: null, budget_max: null, currency: null };
  const m = /^([$€£])(\d{1,3}(?:,\d{3})*)$/.exec(text);
  const amount = m ? Number(m[2].replace(/,/g, "")) : NaN;
  return m && Number.isSafeInteger(amount) ? { prize_text: text, budget_max: amount, currency: CURRENCY[m[1]] } : { prize_text: text, budget_max: null, currency: null };
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * The competition page's end, in Django's default date format: `Dec. 3, 2026, 10 p.m. UTC`,
 * `Feb. 8, 2027, 11:59 p.m. UTC`, `May 1, 2027, midnight UTC`, `noon`. Null for any other spelling.
 */
export function endOf(pageText: string): string | null {
  const m = /Competition End Date\s*([A-Z][a-z]{2,4})\.? (\d{1,2}), (\d{4}), (midnight|noon|(\d{1,2})(?::(\d{2}))? ([ap])\.m\.) UTC/.exec(pageText);
  const month = m ? MONTHS[m[1].toLowerCase()] : undefined;
  if (!m || !month) return null;
  const [day, year] = [Number(m[2]), Number(m[3])];
  let hour = 0, minute = 0;
  if (m[4] === "noon") hour = 12;
  else if (m[4] !== "midnight") {
    hour = Number(m[5]);
    minute = Number(m[6] ?? 0);
    if (hour < 1 || hour > 12 || minute > 59) return null;
    hour = (hour % 12) + (m[7] === "p" ? 12 : 0);
  }
  const d = new Date(Date.UTC(year, month - 1, day, hour, minute));
  return d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? d.toISOString() : null;
}

/** A card's end day (`-1YYYYMMDD` on an active card) as an ISO date; null otherwise. */
export function cardDay(value: string | undefined): string | null {
  const m = value ? /^-1(\d{4})(\d{2})(\d{2})$/.exec(value) : null;
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

export type Card = { href: string; title: string; host: string | null; prize: string | null; active: boolean; prizeComp: boolean; day: string | null; stated: boolean };

/** The cards on the list page; refuses a page with no card (the layout changed). */
export function parseList(html: string): Card[] {
  const $ = load(html, { scriptingEnabled: false });
  const cards = $("div.panel-container").toArray().map((el) => {
    const c = $(el);
    const link = c.find("h3.panel-competition-title a").first();
    const alt = c.find("img[alt^='Hosted by ']").attr("alt");
    return {
      href: (link.attr("href") ?? "").trim(),
      title: htmlText(link.html() ?? ""),
      host: alt ? alt.slice("Hosted by ".length).trim() || null : null,
      prize: htmlText(c.find(".prize strong").first().html() ?? "") || null,
      active: c.attr("data-status_active") === "1",
      prizeComp: c.attr("data-reward_prize") === "1",
      day: cardDay(c.attr("data-deadline")),
      stated: c.attr("data-status_active") !== undefined || c.attr("data-status_completed") !== undefined,
    };
  });
  if (!cards.length) throw new SourceError("drivendata: no competition cards");
  // A card without its state attributes would read as not open, and a complete read of none would mark
  // every stored competition gone: the layout changed, so the run fails instead.
  if (cards.some((c) => !c.stated)) throw new SourceError("drivendata: a card states no status");
  return cards;
}

/** The card's identity: `<N>` for a DrivenData competition page, the URL itself for one hosted elsewhere. */
export function identity(href: string): { id: string; url: string; own: boolean } {
  const u = URL.canParse(href, ORIGIN) ? new URL(href, ORIGIN) : null;
  if (!u || u.protocol !== "https:" || u.username || u.password) throw new SourceError("drivendata: invalid competition link");
  u.hash = "";
  const own = u.origin === ORIGIN ? /^\/competitions\/(\d{1,9})\/[a-z0-9-]+\/$/.exec(u.pathname) : null;
  return own ? { id: own[1], url: u.toString(), own: true } : { id: u.toString(), url: u.toString(), own: false };
}

/** One open prize competition; `end` is the instant read from its own page, null when not read. */
export function normalize(card: Card, end: string | null): ContestInput {
  const { id, url } = identity(card.href);
  if (codePoints(card.title) < 1 || codePoints(card.title) > 500) throw new SourceError("drivendata: invalid title");
  return parseContestInput({
    opportunity_type: "contest", external_id: id, title: card.title, company: card.host && codePoints(card.host) <= 500 ? card.host : null, url, canonical_url: url,
    ...prizeOf(card.prize),
    online: null, invite_only: null, hackathon: null, listing_closed: false,
    deadline: end ? { kind: "instant", at: end } : card.day ? { kind: "date", date: card.day } : null,
    registration_deadline: null,
    extra: {},
  });
}

/** Benchmarks share the card layout under `/benchmarks/`; they are not competitions. */
const isBenchmark = (href: string) => URL.canParse(href, ORIGIN) && new URL(href, ORIGIN).pathname.startsWith("/benchmarks/");

/** The competition's own DrivenData page, or null for a card hosted elsewhere or with a bad link (set aside later). */
function ownPage(c: Card): string | null {
  try {
    const i = identity(c.href);
    return i.own ? i.url : null;
  } catch {
    return null;
  }
}

export async function scan(fetcher: Fetcher): Promise<{ seen: number; listings: ContestInput[]; truncated: boolean; rejected: number; examined: number }> {
  const cards = parseList(pageHtml("drivendata", (await fetcher.get(pageRequest(LIST_URL))).body));
  const open = cards.filter((c) => c.active && c.prizeComp && !isBenchmark(c.href));
  const pages = open.map(ownPage).filter((u): u is string => u !== null);
  const ends = new Map<string, string | null>();
  // A detail page that fails to load fails the run (a request failure); one that loads without a readable
  // end keeps the card's day.
  for (const url of pages.slice(0, MAX_DETAILS)) ends.set(url, endOf(htmlText(pageHtml("drivendata", (await fetcher.get(pageRequest(url))).body))));
  const kept = setAside(open, (c) => normalize(c, ends.get(ownPage(c) ?? "") ?? null));
  // A competition shown twice (a featured block and the grid) is kept once, as last read.
  const listings = [...new Map(kept.listings.map((l) => [l.external_id, l])).values()];
  return { seen: open.length, listings, truncated: pages.length > MAX_DETAILS, rejected: kept.rejected, examined: kept.examined };
}

export async function drivendataConnector(fetcher: Fetcher): Promise<Collected<ContestInput>> {
  return { ...(await scan(fetcher)), sourceKept: () => true };
}

export const DRIVENDATA_SETTINGS: Omit<PageSourceSettings, "order"> = {
  opportunityType: "contest",
  label: "DrivenData", name: "drivendata", connector: drivendataConnector, maxTier: "plain",
  minIntervalMs: 2_000, maxRequestsPerRun: 1 + MAX_DETAILS,
  // The one list page holds every competition (no pagination, measured 2026-11-22) (plan D9).
  completeRead: true, disabled: null,
};
