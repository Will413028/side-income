import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { PgDb } from "@/db/pg/client";
import { listingBy } from "@/modules/listings/public";
import { FetchError, type Fetcher } from "@/platform/fetch";
import { collectSource } from "@/services/collect";
import { crunchdaoConnector, CRUNCHDAO_SETTINGS, deadlineOf, MAX_PAGES, normalize, pageUrl, scan } from ".";
import { freshPg } from "../../../../tests/helpers/pg";

// Opportunity types plan step 6b. The competitions below are synthetic, shaped on the fields measured
// 2026-11-22 (no captured response).

const serving = (pages: Record<string, string>): Fetcher & { urls: string[] } => {
  const urls: string[] = [];
  return {
    urls,
    get requests() {
      return urls.length;
    },
    async get({ url }) {
      urls.push(url);
      if (!Object.hasOwn(pages, url)) throw new FetchError("network", "unknown url");
      return { status: 200, body: new TextEncoder().encode(pages[url]), tier: "plain" };
    },
  };
};

const competition = (name: string, changes: Record<string, unknown> = {}) => ({
  id: 1, name, displayName: `Example ${name}`, fullName: null, hostedByName: "Example Host", status: "OPEN", visibility: "PUBLIC",
  end: "2026-11-30T16:00:00", continuous: false, prizePoolUsd: 100000.0, prizePoolShortText: "100,000 $USDC", url: "https://hub.crunchdao.com/", ...changes,
});
/** The API's pages over this list, `size` a page. */
const api = (all: unknown[], size = 20, total = all.length) => {
  const pages: Record<string, string> = {};
  const totalPages = Math.max(1, Math.ceil(total / size));
  for (let p = 0; p < Math.max(1, Math.ceil(all.length / size)); p++) pages[pageUrl(p)] = JSON.stringify({ content: all.slice(p * size, (p + 1) * size), pageNumber: p, pageSize: size, totalElements: total, totalPages });
  return pages;
};

describe("crunchdao competitions", () => {
  it("keeps a time without an offset as unusable text, an instant with one, and no deadline when continuous", () => {
    expect([deadlineOf("2026-11-30T16:00:00", false), deadlineOf("2027-02-01T16:00:00.896", false), deadlineOf("2026-11-30T16:00:00Z", false), deadlineOf("2026-11-30T16:00:00", true), deadlineOf(null, false), deadlineOf("soon", false)]).toEqual([
      { kind: "no_timezone", text: "2026-11-30T16:00:00" }, { kind: "no_timezone", text: "2027-02-01T16:00:00.896" }, { kind: "instant", at: "2026-11-30T16:00:00.000Z" }, null, null, { kind: "invalid", text: "soon" },
    ]);
  });

  it("derives the URL from the name, stores the pool in dollars and its text, and leaves a zero pool unknown", () => {
    expect(normalize(competition("synth", { prizePoolUsd: 30000.0, prizePoolShortText: "30k $USDC" }))).toMatchObject({
      external_id: "synth", title: "Example synth", company: "Example Host", url: "https://hub.crunchdao.com/competitions/synth", budget_max: 30000, currency: "USD", prize_text: "30k $USDC", invite_only: null,
    });
    expect(normalize(competition("pts", { prizePoolUsd: 0, prizePoolShortText: "Points" }))).toMatchObject({ budget_max: null, currency: null, prize_text: "Points" });
    expect(normalize(competition("frac", { prizePoolUsd: 0.4 })).budget_max).toBeNull();
    expect(normalize(competition("t", { displayName: " ", fullName: "Full name" })).title).toBe("Full name");
  });

  it("refuses a competition without a slug name or a title", () => {
    for (const c of [competition("../x"), competition("a", { displayName: null }), null]) expect(() => normalize(c)).toThrow(/crunchdao/);
  });
});

describe("crunchdao pages", () => {
  it("reads every page and keeps only open public competitions", async () => {
    const all = [competition("a"), competition("hidden", { visibility: "HIDDEN" }), competition("late", { status: "LATE_SUBMISSIONS" }), ...Array.from({ length: 20 }, (_, i) => competition(`closed-${i}`, { status: "CLOSED" })), competition("b", { continuous: true, end: null })];
    const f = serving(api(all));
    const got = await crunchdaoConnector(f);
    expect([f.urls, got.listings.map((l) => l.external_id), got.seen, got.truncated]).toEqual([[pageUrl(0), pageUrl(1)], ["a", "b"], 2, false]);
    expect(got.listings[1].deadline).toBeNull();
  });

  it("a read whose entries do not add up to the stated total is not complete", async () => {
    expect((await scan(serving(api([competition("a")], 20, 2)))).truncated).toBe(true);
  });

  it("a page stating other totals than the first is not complete", async () => {
    const pages = api(Array.from({ length: 25 }, (_, i) => competition(`c${i}`)));
    pages[pageUrl(1)] = JSON.stringify({ ...JSON.parse(pages[pageUrl(1)]), totalElements: 26 });
    expect((await scan(serving(pages))).truncated).toBe(true);
  });

  it("stops at the page cap and marks the read truncated", async () => {
    const all = Array.from({ length: (MAX_PAGES + 1) * 2 }, (_, i) => competition(`c${i}`, { status: "CLOSED" }));
    const f = serving(api(all, 2));
    const got = await scan(f);
    expect([f.urls.length, CRUNCHDAO_SETTINGS.maxRequestsPerRun, got.truncated]).toEqual([MAX_PAGES, MAX_PAGES, true]);
  });

  it("sets aside one open competition without its identity and keeps the others", async () => {
    const got = await scan(serving(api([competition("a"), competition("Bad Name"), competition("c")])));
    expect([got.listings.map((l) => l.external_id), got.rejected, got.examined]).toEqual([["a", "c"], 1, 3]);
  });

  it("refuses a page that is not JSON, has no list or no totals", async () => {
    for (const body of ["<html>", JSON.stringify({ items: [] }), JSON.stringify({ content: [] }), JSON.stringify({ content: [], totalElements: 0, totalPages: "1" })]) {
      await expect(scan(serving({ [pageUrl(0)]: body }))).rejects.toThrow(/crunchdao/);
    }
  });
});

describe("crunchdao through intake", () => {
  let db: PgDb, close: () => Promise<void>;
  beforeAll(async () => ({ db, close } = await freshPg()));
  afterAll(async () => close());
  beforeEach(async () => db.execute(sql`truncate listings cascade`));
  const NOW = new Date("2026-11-22T02:00:00Z");

  it("stores an unzoned deadline as unusable, and a second read inserts no rows", async () => {
    const pages = api([competition("a"), competition("b", { continuous: true, end: null })]);
    const first = await collectSource(db, "crunchdao", NOW, serving(pages));
    expect(first.intake).toEqual({ inserted: 2, updated: 0, unchanged: 0, versioned: 0 });
    expect(await listingBy(db, "crunchdao", "a")).toMatchObject({ opportunityType: "contest", budgetMax: 100000, deadlineKind: "no_timezone", deadlineAt: null });
    const second = await collectSource(db, "crunchdao", new Date(NOW.getTime() + 86_400_000), serving(pages));
    expect(second.intake).toEqual({ inserted: 0, updated: 0, unchanged: 2, versioned: 0 });
  });

  it("marks a competition gone when a complete read no longer lists it as open", async () => {
    await collectSource(db, "crunchdao", NOW, serving(api([competition("a"), competition("b")])));
    await collectSource(db, "crunchdao", NOW, serving(api([competition("a"), competition("b", { status: "CLOSED" })])));
    expect((await listingBy(db, "crunchdao", "b"))?.goneAt).toEqual(NOW);
  });
});
