import { parseContestInput, type ContestInput } from "@/modules/listings/public";
import type { Fetcher } from "@/platform/fetch";
import { codePoints, isObject } from "../shared/json";
import { USER_AGENT } from "../shared/job-pages";
import { setAside } from "../shared/set-aside";
import { parseIsoTime } from "../shared/time";
import { SourceError, type Collected, type PageSourceSettings } from "../types";

// Superteam Earn: bounties from the site's public JSON list (opportunity types plan step 7). Stored as
// contests (Will 2026-11-23: D8 already gives bounties the contests' ordering and tab, and a contest's
// columns hold every field the list gives; the bounty kind is kept in `extra`). Measured 2026-11-23: the
// list answers every open bounty in one response (12, matching `/api/listings/count`'s `All`), entries
// of another `type` (`project`, a freelance gig) are left out. `deadline` is ISO 8601 with `Z`. The reward
// is `rewardAmount` in `token` (USDC, USDG, NOS: a token, not an ISO currency) for `fixed`, unknown
// otherwise. The list states no region, no invite-only flag and
// nothing about online or in person: those stay unknown (null). The URL is derived from `slug`.

const BASE = "https://superteam.fun";
const QUERY = "context=all&tab=bounties&status=open";
export const LIST_URL = `${BASE}/api/listings?${QUERY}`;
export const COUNT_URL = `${BASE}/api/listings/count?${QUERY}`;
export const listingUrl = (slug: string) => `${BASE}/earn/listing/${slug}`;
const MAX_BYTES = 2_000_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const textOr = (v: unknown, max: number) => (typeof v === "string" && v.trim() && codePoints(v) <= max ? v.trim() : null);
/** A whole positive amount; a fractional token amount (e.g. 1.5 SOL) is not rounded but left unknown. */
const positive = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 1 ? v : null);

function deadlineOf(v: unknown): ContestInput["deadline"] {
  if (v === null || v === undefined) return null;
  const t = typeof v === "string" ? parseIsoTime(v) : null;
  if (t?.kind === "aware") return { kind: "instant", at: t.instant.toISOString() };
  return { kind: t?.kind === "naive" ? "no_timezone" : "invalid", text: typeof v === "string" ? v : JSON.stringify(v) };
}

/** One open bounty; throws SourceError when its identity is missing (`setAside` sets it aside). */
export function normalize(item: unknown): ContestInput {
  if (!isObject(item)) throw new SourceError("superteam: a listing is not an object");
  const { id, slug } = item;
  if (typeof id !== "string" || !UUID.test(id)) throw new SourceError("superteam: identifier required");
  if (typeof slug !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._~-]{0,299}$/.test(slug)) throw new SourceError("superteam: slug required");
  const title = textOr(item.title, 500);
  if (!title) throw new SourceError("superteam: invalid title");
  const token = textOr(item.token, 20);
  // Only a fixed reward is an amount: the contests page shows `budget_max` as the prize, so a range's upper
  // bound would read as a fixed prize; `range` and `variable` stay unknown (none in the 2026-11-23 list).
  const amount = token && item.compensationType === "fixed" ? positive(item.rewardAmount) : null;
  const url = listingUrl(slug);
  return parseContestInput({
    opportunity_type: "contest", external_id: id, title, company: isObject(item.sponsor) ? textOr(item.sponsor.name, 500) : null, url, canonical_url: url,
    prize_text: null, budget_min: null, budget_max: amount, currency: amount === null ? null : token,
    online: null, invite_only: null, hackathon: null, listing_closed: false,
    deadline: deadlineOf(item.deadline), registration_deadline: null,
    extra: { kind: "bounty", compensation: textOr(item.compensationType, 20) },
  });
}

function json(body: Uint8Array, what: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new SourceError(`superteam: ${what} is not JSON`);
  }
}

const isOpen = (e: unknown) => isObject(e) && e.status === "OPEN";

/**
 * Reads the list and the count the site shows over it (both `status=open`). `truncated` unless the open
 * bounties listed match the stated count (the list has no paging; a count above it means the list was cut).
 */
export async function scan(fetcher: Fetcher): Promise<{ seen: number; listings: ContestInput[]; truncated: boolean; rejected: number; examined: number }> {
  const headers = { "User-Agent": USER_AGENT, Accept: "application/json" };
  const list = json((await fetcher.get({ url: LIST_URL, maxBytes: MAX_BYTES, timeoutMs: 25_000, headers })).body, "the list");
  if (!Array.isArray(list)) throw new SourceError("superteam: the list is not an array");
  const count = json((await fetcher.get({ url: COUNT_URL, maxBytes: 100_000, timeoutMs: 25_000, headers })).body, "the count");
  const total = isObject(count) ? count.All : undefined;
  if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) throw new SourceError("superteam: no count");
  // The query asks for bounties only; a `type` the code does not recognise means the API changed.
  const bounties = list.filter((e) => isObject(e) && typeof e.type === "string" && e.type.toLowerCase() === "bounty");
  if (list.length > 0 && bounties.length === 0) throw new SourceError("superteam: no entry is a bounty");
  const contests = new Map<string, ContestInput>();
  const open = bounties.filter(isOpen);
  const kept = setAside(open, (e) => {
    const c = normalize(e);
    contests.set(c.external_id, c);
    return c;
  });
  return { seen: contests.size + kept.rejected, listings: [...contests.values()], truncated: open.length !== total, rejected: kept.rejected, examined: kept.examined };
}

export async function superteamConnector(fetcher: Fetcher): Promise<Collected<ContestInput>> {
  return { ...(await scan(fetcher)), sourceKept: () => true };
}

export const SUPERTEAM_SETTINGS: Omit<PageSourceSettings, "order"> = {
  opportunityType: "contest",
  label: "Superteam Earn", name: "superteam", connector: superteamConnector, maxTier: "plain",
  minIntervalMs: 2_000, maxRequestsPerRun: 2,
  // One untruncated read holds every open bounty the site lists.
  completeRead: true, disabled: null,
};
