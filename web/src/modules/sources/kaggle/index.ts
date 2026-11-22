import { load } from "cheerio";
import { parseContestInput, type ContestInput } from "@/modules/listings/public";
import type { Fetcher } from "@/platform/fetch";
import { codePoints } from "../shared/json";
import { htmlText } from "../shared/html";
import { pageHtml, renderRequest } from "../shared/job-pages";
import { setAside } from "../shared/set-aside";
import { SourceError, type Collected, type PageSourceSettings } from "../types";

// Kaggle: the browser tier gets a reCAPTCHA check page on some reads, the stealth tier does not (plan D15;
// measured on the VM 2026-11-22). The list page renders each competition as one link `/competitions/<slug>`
// holding an icon (`trophy`, or `rocket_launch` for a hackathon), the title, a prize (`$100,000`, `3 Swag`,
// `Kudos`) and a state: the grid cards say `N … to go` or `Ongoing` (Knowledge competitions, no deadline,
// not read), the list rows say only when they started (`20 days ago`). The deadline is on each competition's
// page: its timeline gives `<Month D, YYYY> - Final Submission Deadline` (or the label first) and the note
// `All deadlines are at 11:59 PM UTC on the corresponding day`, so the deadline is 23:59 UTC that day (a date
// without the note, D12); the entry deadline is the registration deadline. The page's `Close` field says
// `N … to go` while it is open and a date once closed (a list row can be closed: measured with `Late
// Submission`). These dates are text in the page, not times the browser renders, so the render's zone does
// not matter (D16 applies to the browser tier's zone-free times only).

export const ORIGIN = "https://www.kaggle.com";
export const LIST_URL = `${ORIGIN}/competitions`;
export const LIST_WAIT = "a[href^='/competitions/']";
/** Every competition page measured shows its timeline heading. */
export const DETAIL_WAIT = "text=Timeline";
/** Pages read per run (29 not ongoing on 2026-11-22); more is a truncated read. */
export const MAX_DETAILS = 40;

export type Card = { slug: string; title: string; hackathon: boolean; prize: string | null; state: "to_go" | "ongoing" | "unknown" };

/** `/competitions/<slug>` with one segment on kaggle.com, read with the URL parser (query and fragment dropped); null otherwise. */
export function idOf(href: string | undefined): string | null {
  const u = href && URL.canParse(href.trim(), ORIGIN) ? new URL(href.trim(), ORIGIN) : null;
  const m = u && u.origin === ORIGIN ? /^\/competitions\/([a-z0-9][a-z0-9-]{1,99})\/?$/.exec(u.pathname) : null;
  return m ? m[1] : null;
}

const TO_GO = /^(?:\d+|an?) (?:minute|hour|day|week|month|year)s? to go$/i;

/** The texts of the elements without element children, in page order: the rendered page puts adjacent fields in
 * sibling spans, so its flattened text glues them (`Close10 days to go`, `$75,0002 months to go`; measured). */
function leaves($: ReturnType<typeof load>, root: Parameters<ReturnType<typeof load>>[0]): string[] {
  return $(root).find("*").toArray().filter((e) => $(e).children().length === 0 && !["script", "style"].includes(e.tagName)).map((e) => $(e).text().replace(/\s+/g, " ").trim()).filter(Boolean);
}

/** The competition cards on the rendered list page, each once (the first shown); refuses a page with none. */
export function parseList(html: string): Card[] {
  const $ = load(html, { scriptingEnabled: false });
  const cards = new Map<string, Card>();
  for (const el of $("a[href]").toArray()) {
    const a = $(el);
    const slug = idOf(a.attr("href"));
    if (!slug || cards.has(slug)) continue;
    const titleEl = a.find("div").filter((_, d) => $(d).children().length === 0 && $(d).text().trim() !== "").first();
    const texts = leaves($, el);
    const row = a.find("span").toArray().map((s) => $(s).text().trim()).find((t) => t.includes(" · "));
    const heading = a.find("h2").first().text().trim();
    cards.set(slug, {
      slug, title: titleEl.text().trim() || (a.attr("aria-label") ?? "").trim(),
      hackathon: a.find(".google-symbols").first().text().trim() === "rocket_launch",
      prize: (row ? row.split(" · ")[0].trim() : heading) || null,
      state: texts.some((t) => TO_GO.test(t)) ? "to_go" : texts.includes("Ongoing") ? "ongoing" : "unknown",
    });
  }
  if (!cards.size) throw new SourceError("kaggle: no competition cards");
  return [...cards.values()];
}

/** `$75,000` as an amount in USD; any other text keeps the text only. */
export function prizeOf(text: string | null): Pick<ContestInput, "prize_text" | "budget_max" | "currency"> {
  if (!text || codePoints(text) > 200) return { prize_text: null, budget_max: null, currency: null };
  const m = /^\$(\d{1,3}(?:,\d{3})*|\d+)$/.exec(text);
  const amount = m ? Number(m[1].replace(/,/g, "")) : NaN;
  return m && Number.isSafeInteger(amount) ? { prize_text: text, budget_max: amount, currency: "USD" } : { prize_text: text, budget_max: null, currency: null };
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DATE = `(${MONTHS.join("|")}) (\\d{1,2}), (\\d{4})`;

function isoDate(month: string, day: string, year: string): string | null {
  const [m, d, y] = [MONTHS.indexOf(month), Number(day), Number(year)];
  const t = new Date(Date.UTC(y, m, d));
  return t.getUTCMonth() === m && t.getUTCDate() === d ? t.toISOString().slice(0, 10) : null;
}

/** The first `<date> - <label>` or `<label> - <date>` in the page text; null when none is a real date. */
function dateFor(text: string, label: string): string | null {
  const m = new RegExp(`${DATE}\\s*-\\s*${label}|${label}\\s*-\\s*${DATE}`).exec(text);
  if (!m) return null;
  return m[1] ? isoDate(m[1], m[2], m[3]) : isoDate(m[4], m[5], m[6]);
}

export type Detail = { open: boolean | null; deadline: ContestInput["deadline"]; entry: string | null; title: string | null; host: string | null };

export function parseDetail(html: string): Detail {
  const text = htmlText(html);
  const $ = load(html, { scriptingEnabled: false });
  const texts = leaves($, "body");
  const at = texts.indexOf("Close");
  const close = at >= 0 ? (texts[at + 1] ?? null) : null;
  const open = close === null ? null : TO_GO.test(close) ? true : new RegExp(`^(?:${MONTHS.map((m) => m.slice(0, 3)).join("|")}) \\d{1,2}, \\d{4}$`).test(close) ? false : null;
  const final = dateFor(text, "Final Submission Deadline");
  const utc = /All deadlines are at 11:59 PM UTC/.test(text);
  const entry = /Entry Deadline\s*-\s*Same as the Final Submission Deadline/.test(text) ? final : dateFor(text, "Entry Deadline");
  const title = $("h1").first().text().trim() || null;
  const host = /Competition Host\s*(.{1,200}?)\s*Prizes & Awards/.exec(text)?.[1].trim() ?? null;
  return { open, deadline: final ? (utc ? { kind: "instant", at: `${final}T23:59:00.000Z` } : { kind: "date", date: final }) : null, entry, title, host };
}

export function normalize(card: Card, detail: Detail): ContestInput {
  const title = detail.title ?? card.title;
  if (codePoints(title) < 1 || codePoints(title) > 500) throw new SourceError("kaggle: invalid title");
  const url = `${ORIGIN}/competitions/${card.slug}`;
  return parseContestInput({
    opportunity_type: "contest", external_id: card.slug, title, company: detail.host && codePoints(detail.host) <= 500 ? detail.host : null, url, canonical_url: url,
    ...prizeOf(card.prize),
    // Kaggle competitions are submitted on the site; online says nothing about who may enter.
    online: true, invite_only: null, hackathon: card.hackathon, listing_closed: false,
    deadline: detail.deadline, registration_deadline: detail.entry,
    extra: {},
  });
}

export async function scan(fetcher: Fetcher): Promise<{ seen: number; listings: ContestInput[]; truncated: boolean; rejected: number; examined: number }> {
  const candidates = parseList(pageHtml("kaggle", (await fetcher.get(renderRequest(LIST_URL, LIST_WAIT))).body)).filter((c) => c.state !== "ongoing");
  // Cards past the cap are left out rather than written without their page's deadline (which would
  // overwrite a stored one); the read is then truncated.
  const read = candidates.slice(0, MAX_DETAILS);
  const details = new Map<string, Detail>();
  // A page that fails to render (or answers the check page) fails the run.
  for (const c of read) details.set(c.slug, parseDetail(pageHtml("kaggle", (await fetcher.get(renderRequest(`${ORIGIN}/competitions/${c.slug}`, DETAIL_WAIT))).body)));
  // No final submission deadline on any page read means the page layout (or its render) changed: fail the
  // run rather than store every deadline as unknown.
  if (details.size && ![...details.values()].some((d) => d.deadline)) throw new SourceError("kaggle: no detail page shows a final submission deadline");
  // Open: the page's Close field says `… to go`; a page without a readable Close field falls back to the
  // list's `… to go` (plan step 6c-3), and a list row without either is not taken as open.
  const open = read.filter((c) => details.get(c.slug)!.open ?? c.state === "to_go");
  const kept = setAside(open, (c) => normalize(c, details.get(c.slug)!));
  return { seen: open.length, listings: kept.listings, truncated: candidates.length > MAX_DETAILS, rejected: kept.rejected, examined: kept.examined };
}

export async function kaggleConnector(fetcher: Fetcher): Promise<Collected<ContestInput>> {
  return { ...(await scan(fetcher)), sourceKept: () => true };
}

export const KAGGLE_SETTINGS: Omit<PageSourceSettings, "order"> = {
  opportunityType: "contest",
  label: "Kaggle", name: "kaggle", connector: kaggleConnector, maxTier: "stealth",
  minIntervalMs: 5_000, maxRequestsPerRun: 1 + MAX_DETAILS,
  // The list page shows the current competitions; a scroll-loaded tail is not measured, so a read is not
  // taken as complete (plan D9): a competition no read shows ages out.
  completeRead: false, disabled: null,
};
