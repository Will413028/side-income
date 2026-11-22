import { parseContestInput, type ContestInput } from "@/modules/listings/public";
import type { Fetcher } from "@/platform/fetch";
import { codePoints, isObject } from "../shared/json";
import { USER_AGENT } from "../shared/job-pages";
import { setAside } from "../shared/set-aside";
import { parseIsoTime } from "../shared/time";
import { SourceError, type Collected, type PageSourceSettings } from "../types";

// CrunchDAO: the public JSON list of competitions, paged (opportunity types plan step 6b; measured 2026-11-22
// without following redirects: 25 competitions on 2 pages of 20, 2 `OPEN` and `PUBLIC`). Only a competition
// that is `status: OPEN` and `visibility: PUBLIC` is kept (plan step 6b). `end` carries no offset and the
// API documents no zone, so it is kept as text and unusable (`no_timezone`); a `continuous` competition has
// no deadline. `url` on the list is the hub's front page, not the competition, so the URL is derived from
// `name` (`hub.crunchdao.com/competitions/<name>`, 200 measured 2026-11-22). `prizePoolUsd` is the pool in
// US dollars; `prizePoolShortText` (sometimes per week or month) is kept as the text; a pool under one dollar (0 with `Points`) is no amount. `PUBLIC` says who can see the listing, not who can join, so invite-only stays unknown. No region, age or
// student rule and no place on the list: those stay unknown (null).

export const ENDPOINT = "https://api.hub.crunchdao.com/v2/competitions";
export const pageUrl = (page: number) => `${ENDPOINT}?page=${page}`;
/** 2 pages of 20 held the 25 competitions on 2026-11-22. */
export const MAX_PAGES = 5;
const MAX_BYTES = 2_000_000;
export const competitionUrl = (name: string) => `https://hub.crunchdao.com/competitions/${name}`;

const textOr = (v: unknown, max: number) => (typeof v === "string" && v.trim() && codePoints(v) <= max ? v.trim() : null);

/** `end` as given; null when continuous or absent, `no_timezone` text when a time without offset (plan step 6b). */
export function deadlineOf(end: unknown, continuous: unknown): ContestInput["deadline"] {
  if (continuous === true || end === null || end === undefined) return null;
  const t = typeof end === "string" ? parseIsoTime(end) : null;
  if (t?.kind === "aware") return { kind: "instant", at: t.instant.toISOString() };
  return { kind: t?.kind === "naive" ? "no_timezone" : "invalid", text: typeof end === "string" ? end : JSON.stringify(end) };
}

/** One open public competition; throws SourceError when its identity is missing (`setAside` sets it aside). */
export function normalize(item: unknown): ContestInput {
  if (!isObject(item)) throw new SourceError("crunchdao: a competition is not an object");
  const { name } = item;
  if (typeof name !== "string" || !/^[a-z0-9][a-z0-9-]{0,199}$/.test(name)) throw new SourceError("crunchdao: identifier required");
  const title = textOr(item.displayName, 500) ?? textOr(item.fullName, 500);
  if (!title) throw new SourceError("crunchdao: invalid title");
  const url = competitionUrl(name);
  const usd = item.prizePoolUsd;
  const amount = typeof usd === "number" && Number.isFinite(usd) && usd >= 1 && Number.isSafeInteger(Math.round(usd)) ? Math.round(usd) : null;
  return parseContestInput({
    opportunity_type: "contest", external_id: name, title, company: textOr(item.hostedByName, 500), url, canonical_url: url,
    prize_text: textOr(item.prizePoolShortText, 500), budget_max: amount, currency: amount === null ? null : "USD",
    online: null, invite_only: null, hackathon: null, listing_closed: false,
    deadline: deadlineOf(item.end, item.continuous),
    registration_deadline: null,
    extra: { continuous: typeof item.continuous === "boolean" ? item.continuous : null },
  });
}

/** One API page: its competitions and the totals it states; refuses anything else. */
export function parsePage(body: Uint8Array): { entries: unknown[]; totalElements: number; totalPages: number } {
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new SourceError("crunchdao: page is not JSON");
  }
  if (!isObject(data) || !Array.isArray(data.content)) throw new SourceError("crunchdao: invalid API envelope");
  const { totalElements, totalPages } = data;
  const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  if (!count(totalElements) || !count(totalPages)) throw new SourceError("crunchdao: no totals");
  return { entries: data.content, totalElements, totalPages };
}

const isOpen = (e: unknown) => isObject(e) && e.status === "OPEN" && e.visibility === "PUBLIC";

/**
 * Reads every page the first states (up to the cap) and keeps the open public competitions, each once by
 * name. `truncated` unless every page was read, each stated the same totals and the entries read match
 * the total (a competition added or removed while paging shifts the pages).
 */
export async function scan(fetcher: Fetcher): Promise<{ seen: number; listings: ContestInput[]; truncated: boolean; rejected: number; examined: number }> {
  const contests = new Map<string, ContestInput>();
  const totals = new Set<string>();
  let read = 0, pages = 1, rejected = 0, examined = 0;
  for (let page = 0; page < Math.min(pages, MAX_PAGES); page++) {
    const r = await fetcher.get({ url: pageUrl(page), maxBytes: MAX_BYTES, timeoutMs: 25_000, headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
    const p = parsePage(r.body);
    if (page === 0) pages = p.totalPages;
    totals.add(`${p.totalElements}/${p.totalPages}`);
    read += p.entries.length;
    const open = p.entries.filter(isOpen);
    const kept = setAside(open, (e) => {
      const c = normalize(e);
      contests.set(c.external_id, c);
      return c;
    });
    rejected += kept.rejected;
    examined += kept.examined;
  }
  const [total] = [...totals].map((t) => Number(t.split("/")[0]));
  const complete = pages <= MAX_PAGES && totals.size === 1 && read === total;
  return { seen: contests.size + rejected, listings: [...contests.values()], truncated: !complete, rejected, examined };
}

export async function crunchdaoConnector(fetcher: Fetcher): Promise<Collected<ContestInput>> {
  return { ...(await scan(fetcher)), sourceKept: () => true };
}

export const CRUNCHDAO_SETTINGS: Omit<PageSourceSettings, "order"> = {
  opportunityType: "contest",
  label: "CrunchDAO", name: "crunchdao", connector: crunchdaoConnector, maxTier: "plain",
  minIntervalMs: 2_000, maxRequestsPerRun: MAX_PAGES,
  // One untruncated read holds every competition the API lists (plan D9).
  completeRead: true, disabled: null,
};
