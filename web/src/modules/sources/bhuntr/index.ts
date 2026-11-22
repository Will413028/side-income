import { load } from "cheerio";
import { parseContestInput, type ContestInput } from "@/modules/listings/public";
import type { Fetcher } from "@/platform/fetch";
import { codePoints, isObject } from "../shared/json";
import { htmlText } from "../shared/html";
import { pageHtml, renderRequest } from "../shared/job-pages";
import { setAside } from "../shared/set-aside";
import { SourceError, type Collected, type PageSourceSettings } from "../types";

// 獎金獵人 (bhuntr): the competition list renders in a browser only (a plain request answers 404; opportunity
// types plan step 6c-1, measured on the VM 2026-11-22). The list page shows the cards of current
// competitions (`bh-contest-card`: title link `/tw/competitions/<id>`, total prize `bh-item-total` as
// `N TWD`, an `is-processing` timeline badge on the open ones); it has no deadline, so the connector renders
// each open card's own page and reads `徵件期間 <start> 至 <end>`. Those times carry no zone: the page
// renders them in the browser's zone, which the `browser` service fixes to UTC (plan D16;
// deploy/check-compose.mjs keeps it), so the end is read as UTC. The organiser comes from the page's
// JSON-LD `Event.organizer.name`. The eligibility fields (`國籍/地區限制`, `身分限制`) have no measured
// boundary in the rendered text, so they stay unknown (null) rather than guessed.

export const ORIGIN = "https://bhuntr.com";
export const LIST_URL = `${ORIGIN}/tw/competitions`;
export const LIST_WAIT = "a.bh-title";
/**
 * The period's label: the render service waits for a visible match (Playwright's default), so a `<script>`
 * never matches (the first VM run answered 422, 2026-11-22); `text=` is Playwright's text selector, measured
 * on the VM the same day.
 */
export const DETAIL_WAIT = "text=徵件期間";
/** Detail pages read per run (24 open cards on 2026-11-22); more is a truncated read. */
export const MAX_DETAILS = 30;

export type Card = { id: string; title: string; prize: string | null; open: boolean; badge: boolean };

/** `/tw/competitions/<id>` (lowercase alphanumeric, 18 characters measured) on bhuntr.com, read with the URL parser (query and fragment dropped); null otherwise. */
export function idOf(href: string | undefined): string | null {
  const u = href && URL.canParse(href.trim(), ORIGIN) ? new URL(href.trim(), ORIGIN) : null;
  const m = u && u.origin === ORIGIN ? /^\/tw\/competitions\/([a-z0-9]{8,40})\/?$/.exec(u.pathname) : null;
  return m ? m[1] : null;
}

/** The cards on the rendered list page, each once (the first shown); refuses a page with no card. */
export function parseList(html: string): Card[] {
  const $ = load(html, { scriptingEnabled: false });
  const cards = new Map<string, Card>();
  for (const el of $(".bh-contest-card").toArray()) {
    const c = $(el);
    const link = c.find("a.bh-title").first();
    const id = idOf(link.attr("href"));
    const amount = htmlText(c.find(".bh-item-total .bh-amount").not(".bh-amount-mobile").first().html() ?? "");
    const currency = htmlText(c.find(".bh-item-total .bh-currency").first().html() ?? "");
    const card = { id: id ?? "", title: htmlText(link.html() ?? ""), prize: amount ? `${amount} ${currency}`.trim() : null, open: c.find(".bh-timeline-block .is-processing").length > 0, badge: c.find(".bh-timeline-block .bh-item").length > 0 };
    if (!cards.has(card.id) || !id) cards.set(id ?? `#${cards.size}`, card);
  }
  if (!cards.size) throw new SourceError("bhuntr: no competition cards");
  // Without any timeline badge no card could be read as open: the layout changed, so the run fails
  // instead of reading nothing.
  if (![...cards.values()].some((c) => c.badge)) throw new SourceError("bhuntr: no card shows a timeline badge");
  return [...cards.values()];
}

/** `1,000,000 TWD` as an amount; any other text keeps the text only. */
export function prizeOf(text: string | null): Pick<ContestInput, "prize_text" | "budget_max" | "currency"> {
  if (!text || codePoints(text) > 200) return { prize_text: null, budget_max: null, currency: null };
  const m = /^(\d{1,3}(?:,\d{3})*|\d+) ([A-Z]{3})$/.exec(text);
  const amount = m ? Number(m[1].replace(/,/g, "")) : NaN;
  return m && Number.isSafeInteger(amount) ? { prize_text: text, budget_max: amount, currency: m[2] } : { prize_text: text, budget_max: null, currency: null };
}

/** The end of `徵件期間 YYYY-MM-DD HH:MM 至 YYYY-MM-DD HH:MM`, read as UTC (D16); null when absent or not a real time. */
export function periodEnd(pageText: string): string | null {
  const m = /徵件期間\s*\d{4}-\d{2}-\d{2}\s*\d{2}:\d{2}\s*至\s*(\d{4})-(\d{2})-(\d{2})\s*(\d{2}):(\d{2})/.exec(pageText);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi));
  return h < 24 && mi < 60 && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? t.toISOString() : null;
}

/** The organiser's name from the page's JSON-LD Event; null when absent or unreadable. */
export function organiserOf(html: string): string | null {
  const $ = load(html, { scriptingEnabled: false });
  for (const el of $('script[type="application/ld+json"]').toArray()) {
    let data: unknown;
    try {
      data = JSON.parse($(el).text());
    } catch {
      continue;
    }
    const nodes = isObject(data) && Array.isArray(data["@graph"]) ? data["@graph"] : [data];
    for (const n of nodes) {
      const name = isObject(n) && n["@type"] === "Event" && isObject(n.organizer) ? n.organizer.name : null;
      if (typeof name === "string" && name.trim() && codePoints(name) <= 500) return name.trim();
    }
  }
  return null;
}

export type Detail = { end: string | null; organiser: string | null };

export function normalize(card: Card, detail: Detail | null): ContestInput {
  if (!card.id) throw new SourceError("bhuntr: identifier required");
  if (codePoints(card.title) < 1 || codePoints(card.title) > 500) throw new SourceError("bhuntr: invalid title");
  const url = `${ORIGIN}/tw/competitions/${card.id}`;
  return parseContestInput({
    opportunity_type: "contest", external_id: card.id, title: card.title, company: detail?.organiser ?? null, url, canonical_url: url,
    ...prizeOf(card.prize),
    online: null, invite_only: null, hackathon: null, listing_closed: false,
    deadline: detail?.end ? { kind: "instant", at: detail.end } : null,
    registration_deadline: null,
    extra: {},
  });
}

export async function scan(fetcher: Fetcher): Promise<{ seen: number; listings: ContestInput[]; truncated: boolean; rejected: number; examined: number }> {
  const open = parseList(pageHtml("bhuntr", (await fetcher.get(renderRequest(LIST_URL, LIST_WAIT))).body)).filter((c) => c.open);
  const withId = open.filter((c) => c.id);
  // Cards past the cap are left out rather than written without their page's deadline (which would
  // overwrite a stored one); the read is then truncated.
  const read = withId.slice(0, MAX_DETAILS);
  const details = new Map<string, Detail>();
  // A detail page that fails to render fails the run (a request failure).
  for (const c of read) {
    const html = pageHtml("bhuntr", (await fetcher.get(renderRequest(`${ORIGIN}/tw/competitions/${c.id}`, DETAIL_WAIT))).body);
    details.set(c.id, { end: periodEnd(htmlText(html)), organiser: organiserOf(html) });
  }
  // No readable period on any page read means the page layout (or its render) changed: fail the run
  // rather than store every deadline as unknown.
  if (details.size && ![...details.values()].some((d) => d.end)) throw new SourceError("bhuntr: no detail page shows its period");
  const kept = setAside([...read, ...open.filter((c) => !c.id)], (c) => normalize(c, details.get(c.id) ?? null));
  return { seen: open.length, listings: kept.listings, truncated: withId.length > MAX_DETAILS, rejected: kept.rejected, examined: kept.examined };
}

export async function bhuntrConnector(fetcher: Fetcher): Promise<Collected<ContestInput>> {
  return { ...(await scan(fetcher)), sourceKept: () => true };
}

export const BHUNTR_SETTINGS: Omit<PageSourceSettings, "order"> = {
  opportunityType: "contest",
  label: "獎金獵人", name: "bhuntr", connector: bhuntrConnector, maxTier: "browser",
  minIntervalMs: 3_000, maxRequestsPerRun: 1 + MAX_DETAILS,
  // The list page shows the current competitions only; no pagination was seen, but a scroll-loaded tail is
  // not measured, so a read is not taken as complete (plan D9): a competition no read shows ages out.
  completeRead: false, disabled: null,
};
