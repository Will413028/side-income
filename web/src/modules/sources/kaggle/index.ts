import { load } from "cheerio";
import { parseContestInput, type ContestInput } from "@/modules/listings/public";
import { ZodError } from "zod";
import { FetchError, type Fetcher } from "@/platform/fetch";
import { codePoints } from "../shared/json";
import { htmlText } from "../shared/html";
import { AccessChallenge, pageHtml, renderRequest } from "../shared/job-pages";
import { SourceError, type Collected, type PageSourceSettings } from "../types";

// Kaggle: the browser tier gets a reCAPTCHA check page on some reads, the stealth tier does not (plan D15;
// measured on the VM 2026-11-22). The list page renders each competition as one link `/competitions/<slug>`
// holding an icon (`trophy`, or `rocket_launch` for a hackathon), the title, a prize (`$100,000`, `3 Swag`,
// `Kudos`) and a state: the grid cards say `N … to go` or `Ongoing` (Knowledge competitions, no deadline,
// not read), the list rows say only when they started (`20 days ago`). The deadline is on each competition's
// page: its timeline gives `<Month D, YYYY> - Final Submission Deadline` (or the label first) and the note
// `All deadlines are at 11:59 PM UTC on the corresponding day`, so the deadline is 23:59 UTC that day (a date
// without the note, D12); the entry deadline is the registration deadline. The page's `Close` field says
// `N … to go` while it is open and a date once closed. Kaggle's check page has no competition link, so a
// render waiting for one answers 422 first: a block then shows as `browser_tier` (http_422), and the check
// page's title in shared/job-pages.ts is a backstop for a render that returns it. These dates are text in the page, not times the browser renders, so the render's zone does
// not matter (D16 applies to the browser tier's zone-free times only).

export const ORIGIN = "https://www.kaggle.com";
export const LIST_URL = `${ORIGIN}/competitions`;
export const LIST_WAIT = "a[href^='/competitions/']";
/** Every competition page measured shows its timeline heading. */
export const DETAIL_WAIT = "text=Timeline";
/** Pages read per run (20 cards `… to go` on 2026-11-22); more is a truncated read. */
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
    // The grid card's prize and state sit beside its link, not in it (measured on the VM 2026-11-22: the
    // link holds the icon, title, summary and team count): the card is the largest ancestor that links
    // to this competition only.
    let card = a;
    for (let i = 0; i < 8; i++) {
      const up = card.parent();
      if (!up.length || up.is("body") || new Set(up.find("a[href]").toArray().map((x) => idOf($(x).attr("href"))).filter(Boolean)).size > 1) break;
      card = up;
    }
    const titleEl = a.find("div").filter((_, d) => $(d).children().length === 0 && $(d).text().trim() !== "").first();
    const texts = leaves($, card.get(0)!);
    const row = card.find("span").toArray().map((s) => $(s).text().trim()).find((t) => t.includes(" · "));
    const heading = card.find("h2").first().text().trim();
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
  // The first `Close` leaf followed by `… to go` (open) or a date (closed); any other `Close` (a dialog's
  // button) is passed over.
  const closed = new RegExp(`^(?:${MONTHS.map((m) => m.slice(0, 3)).join("|")}) \\d{1,2}, \\d{4}$`);
  const value = texts.find((t, i) => i > 0 && texts[i - 1] === "Close" && (TO_GO.test(t) || closed.test(t)));
  const open = value === undefined ? null : TO_GO.test(value);
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
  // Only the cards that say `… to go` are open: the list rows' `… ago` is when they closed (measured: a row
  // `20 days ago` whose page says `Close Nov 2, 2026`, 20 days before), and `Ongoing` has no deadline.
  const cards = parseList(pageHtml("kaggle", (await fetcher.get(renderRequest(LIST_URL, LIST_WAIT))).body));
  // No card in either known state means the card wording changed: fail rather than read nothing.
  if (!cards.some((c) => c.state !== "unknown")) throw new SourceError("kaggle: no card shows `… to go` or `Ongoing`");
  const open = cards.filter((c) => c.state === "to_go");
  // Cards past the cap are left out rather than written without their page's deadline (which would
  // overwrite a stored one); the read is then truncated.
  const read = open.slice(0, MAX_DETAILS);
  const listings: ContestInput[] = [];
  let rejected = 0, examined = 0, rendered = 0, deadlines = 0;
  for (const c of read) {
    examined++;
    try {
      const detail = parseDetail(pageHtml("kaggle", (await fetcher.get(renderRequest(`${ORIGIN}/competitions/${c.slug}`, DETAIL_WAIT))).body));
      rendered++;
      if (detail.deadline) deadlines++;
      // A page that shows itself closed is left out; one without a readable deadline is set aside, so a
      // deadline stored by an earlier read is kept.
      if (detail.open === false) {
        examined--;
        continue;
      }
      if (!detail.deadline) throw new SourceError("kaggle: no final submission deadline");
      listings.push(normalize(c, detail));
    } catch (e) {
      // One page that fails to render or read is set aside (counted; services/collect fails the run when
      // more than half are); the check page, an access refusal and the request cap are not one page's problem.
      if (e instanceof FetchError) {
        if (e.kind === "request_limit") return { seen: open.length, listings, truncated: true, rejected, examined: examined - 1 };
        if (e.kind === "http_status" && [401, 403, 429].includes(e.status ?? 0)) throw e;
      } else if (e instanceof AccessChallenge || !(e instanceof SourceError || e instanceof ZodError)) throw e;
      rejected++;
    }
  }
  // No final submission deadline on any page read means the page layout (or its render) changed: fail the
  // run rather than set every competition aside.
  if (rendered > 0 && deadlines === 0) throw new SourceError("kaggle: no detail page shows a final submission deadline");
  return { seen: open.length, listings, truncated: open.length > MAX_DETAILS, rejected, examined };
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
