import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { PgDb } from "@/db/pg/client";
import { listingBy } from "@/modules/listings/public";
import { FetchError, type Fetcher } from "@/platform/fetch";
import { collectSource } from "@/services/collect";
import { COUNT_URL, LIST_URL, normalize, scan, superteamConnector, SUPERTEAM_SETTINGS } from ".";
import { freshPg } from "../../../../tests/helpers/pg";

// Opportunity types plan step 7 (D8, stored as contests: Will 2026-11-23). The bounties below are
// synthetic, shaped on the fields measured 2026-11-23 (no captured response).

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

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const bounty = (n: number, changes: Record<string, unknown> = {}) => ({
  id: ID(n), slug: `example-bounty-${n}`, title: `Example bounty ${n}`, type: "bounty", status: "OPEN",
  deadline: "2026-11-30T23:59:59.000Z", rewardAmount: 500, token: "USDC", compensationType: "fixed", minRewardAsk: null, maxRewardAsk: null,
  sponsor: { name: "Example Sponsor", slug: "example" }, ...changes,
});
const api = (all: unknown[], total = all.filter((b) => (b as { type?: unknown }).type === "bounty").length) => ({
  [LIST_URL]: JSON.stringify(all),
  [COUNT_URL]: JSON.stringify({ "For You": 0, All: total, Content: total }),
});

describe("superteam bounties", () => {
  it("stores a bounty as a contest: id as identity, the reward in its token, the deadline as an instant, the bounty kind in extra", () => {
    expect(normalize(bounty(1))).toMatchObject({
      opportunity_type: "contest", external_id: ID(1), title: "Example bounty 1", company: "Example Sponsor",
      url: "https://superteam.fun/earn/listing/example-bounty-1", budget_min: null, budget_max: 500, currency: "USDC",
      deadline: { kind: "instant", at: "2026-11-30T23:59:59.000Z" }, registration_deadline: null,
      online: null, invite_only: null, hackathon: null, extra: { kind: "bounty", compensation: "fixed" },
    });
  });

  it("reads only a fixed reward as an amount: a range, a variable reward or a missing token stay unknown", () => {
    expect(normalize(bounty(1, { compensationType: "range", rewardAmount: 300, minRewardAsk: 100, maxRewardAsk: 300 }))).toMatchObject({ budget_min: null, budget_max: null, currency: null });
    expect(normalize(bounty(1, { compensationType: "variable", rewardAmount: null }))).toMatchObject({ budget_min: null, budget_max: null, currency: null });
    expect(normalize(bounty(1, { token: null }))).toMatchObject({ budget_max: null, currency: null });
    expect(normalize(bounty(1, { rewardAmount: 0 })).budget_max).toBeNull();
  });

  it("keeps a deadline without an offset as unusable text, and a missing one as unknown", () => {
    expect(normalize(bounty(1, { deadline: "2026-11-30T23:59:59" })).deadline).toEqual({ kind: "no_timezone", text: "2026-11-30T23:59:59" });
    expect(normalize(bounty(1, { deadline: null })).deadline).toBeNull();
  });

  it("refuses a bounty without a UUID id, a slug or a title", () => {
    for (const b of [bounty(1, { id: "x" }), bounty(1, { slug: "../x" }), bounty(1, { title: " " }), null]) expect(() => normalize(b)).toThrow(/superteam/);
  });
});

describe("superteam reads", () => {
  it("keeps open bounties only, reads two URLs and is complete when the count matches", async () => {
    const f = serving(api([bounty(1), bounty(2, { type: "project" }), bounty(3, { status: "REVIEW" }), bounty(4)], 3));
    const got = await superteamConnector(f);
    expect([f.urls, got.listings.map((l) => l.external_id), got.seen, got.truncated]).toEqual([[LIST_URL, COUNT_URL], [ID(1), ID(4)], 2, false]);
  });

  it("is not complete when the stated count differs from the bounties listed", async () => {
    expect((await scan(serving(api([bounty(1)], 2)))).truncated).toBe(true);
  });

  it("sets aside one bounty without its identity and keeps the others", async () => {
    const got = await scan(serving(api([bounty(1), bounty(2, { id: "bad" }), bounty(3)])));
    expect([got.listings.map((l) => l.external_id), got.rejected, got.examined]).toEqual([[ID(1), ID(3)], 1, 3]);
  });

  it("refuses a list that is not a JSON array and a count without a number", async () => {
    for (const pages of [{ [LIST_URL]: "<html>", [COUNT_URL]: "{}" }, { [LIST_URL]: JSON.stringify({ listings: [] }), [COUNT_URL]: "{}" }, { [LIST_URL]: "[]", [COUNT_URL]: JSON.stringify({ All: "1" }) }]) {
      await expect(scan(serving(pages))).rejects.toThrow(/superteam/);
    }
  });

  it("is a plain-tier contest source with a complete read and two requests", () => {
    expect(SUPERTEAM_SETTINGS).toMatchObject({ opportunityType: "contest", maxTier: "plain", completeRead: true, maxRequestsPerRun: 2, disabled: null });
  });
});

describe("superteam through intake", () => {
  let db: PgDb, close: () => Promise<void>;
  beforeAll(async () => ({ db, close } = await freshPg()));
  afterAll(async () => close());
  beforeEach(async () => db.execute(sql`truncate listings cascade`));
  const NOW = new Date("2026-11-23T02:00:00Z");

  it("stores bounties as contests with the job facts null, and a second read inserts no rows", async () => {
    const pages = api([bounty(1), bounty(2)]);
    const first = await collectSource(db, "superteam", NOW, serving(pages));
    expect(first.intake).toEqual({ inserted: 2, updated: 0, unchanged: 0, versioned: 0 });
    expect(await listingBy(db, "superteam", ID(1))).toMatchObject({ opportunityType: "contest", budgetMax: 500, currency: "USDC", category: null, deadlineAt: new Date("2026-11-30T23:59:59Z") });
    const second = await collectSource(db, "superteam", new Date(NOW.getTime() + 86_400_000), serving(pages));
    expect(second.intake).toEqual({ inserted: 0, updated: 0, unchanged: 2, versioned: 0 });
  });

  it("marks a bounty gone when a complete read no longer lists it as open", async () => {
    await collectSource(db, "superteam", NOW, serving(api([bounty(1), bounty(2)])));
    await collectSource(db, "superteam", NOW, serving(api([bounty(1), bounty(2, { status: "REVIEW" })])));
    expect((await listingBy(db, "superteam", ID(2)))?.goneAt).toEqual(NOW);
  });
});
