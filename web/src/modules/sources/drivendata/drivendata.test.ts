import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { PgDb } from "@/db/pg/client";
import { listingBy } from "@/modules/listings/public";
import { FetchError, type Fetcher } from "@/platform/fetch";
import { collectSource } from "@/services/collect";
import { cardDay, drivendataConnector, endOf, identity, LIST_URL, MAX_DETAILS, prizeOf, scan } from ".";
import { freshPg } from "../../../../tests/helpers/pg";

// Opportunity types plan step 6b. fixtures/ is the connector's ground truth: synthetic pages shaped on the
// list and detail pages measured 2026-11-22 (no captured page).

const fixture = (f: string) => readFileSync(path.join(import.meta.dirname, "fixtures", f), "utf8");
const DETAIL = "https://www.drivendata.org/competitions/306/example-energy/";

/** A Fetcher over {url: body}; an unknown URL fails as the network does. */
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
const site = (detail = fixture("detail-306.html")) => ({ [LIST_URL]: fixture("list.html"), [DETAIL]: detail });

describe("drivendata readers", () => {
  it("reads the end in Django's date format as a UTC instant, and nothing else", () => {
    const at = (s: string) => endOf(`Competition End Date ${s} UTC`);
    expect([at("Dec. 3, 2026, 10 p.m."), at("Feb. 8, 2027, 11:59 p.m."), at("May 1, 2027, midnight"), at("June 5, 2027, noon"), at("Sept. 9, 2027, 12:30 a.m.")]).toEqual([
      "2026-12-03T22:00:00.000Z", "2027-02-08T23:59:00.000Z", "2027-05-01T00:00:00.000Z", "2027-06-05T12:00:00.000Z", "2027-09-09T00:30:00.000Z",
    ]);
    expect([at("Feb. 30, 2027, 1 p.m."), at("Dec. 3, 2026, 13 p.m."), endOf("Competition End Date Dec. 3, 2026, 10 p.m. EST"), endOf("no date")]).toEqual([null, null, null, null]);
  });

  it("reads an active card's end day and no other form", () => {
    expect([cardDay("-120261203"), cardDay("-1120261203"), cardDay("-120260231"), cardDay(undefined)]).toEqual(["2026-12-03", null, null, null]);
  });

  it("reads a prize in dollars, euros or pounds and keeps any other text without an amount", () => {
    expect([prizeOf("$300,000"), prizeOf("€25,000"), prizeOf("£585,000").currency, prizeOf("$10k + credits"), prizeOf(null)]).toEqual([
      { prize_text: "$300,000", budget_max: 300000, currency: "USD" }, { prize_text: "€25,000", budget_max: 25000, currency: "EUR" }, "GBP",
      { prize_text: "$10k + credits", budget_max: null, currency: null }, { prize_text: null, budget_max: null, currency: null },
    ]);
  });

  it("names a DrivenData competition by its number and one hosted elsewhere by its URL", () => {
    expect(identity("/competitions/306/example-energy/#top")).toEqual({ id: "306", url: DETAIL, own: true });
    expect(identity("https://platform.example.org/competitions/4/speech/")).toMatchObject({ id: "https://platform.example.org/competitions/4/speech/", own: false });
    expect(() => identity("http://example.org/x")).toThrow(/drivendata/);
  });
});

describe("drivendata pages", () => {
  it("keeps the active prize competitions, reads the end from the competition's own page, skips practice, benchmarks and completed ones", async () => {
    const f = serving(site());
    const got = await drivendataConnector(f);
    expect(f.urls).toEqual([LIST_URL, DETAIL]);
    expect([got.seen, got.truncated, got.rejected]).toEqual([2, false, 0]);
    expect(got.listings.map((l) => [l.external_id, l.title, l.company, l.budget_max, l.currency, l.deadline])).toEqual([
      ["306", "Example Energy Prize Challenge", "Example Agency", 300000, "USD", { kind: "instant", at: "2026-12-03T22:00:00.000Z" }],
      ["https://platform.example.org/competitions/4/speech/", "Example Speech Modeling", "Example Lab", 25000, "EUR", { kind: "date", date: "2027-02-08" }],
    ]);
  });

  it("keeps the card's day when the competition page shows no readable end", async () => {
    const got = await scan(serving(site("<html><body>changed layout</body></html>")));
    expect(got.listings[0].deadline).toEqual({ kind: "date", date: "2026-12-03" });
  });

  it("fails the run when a competition page does not load, and refuses a list with no cards", async () => {
    await expect(scan(serving({ [LIST_URL]: fixture("list.html") }))).rejects.toThrow();
    await expect(scan(serving({ [LIST_URL]: "<html><body>maintenance</body></html>" }))).rejects.toThrow(/no competition cards/);
  });

  it("reads at most MAX_DETAILS competition pages and marks the read truncated beyond them", async () => {
    const card = (n: number) => `<div class="panel-container" data-deadline="-120261203" data-reward_prize="1" data-status_active="1"><h3 class="panel-competition-title"><a href="/competitions/${n}/c/">C ${n}</a></h3></div>`;
    const pages: Record<string, string> = { [LIST_URL]: `<html><body>${Array.from({ length: MAX_DETAILS + 1 }, (_, i) => card(i + 1)).join("")}</body></html>` };
    for (let i = 1; i <= MAX_DETAILS + 1; i++) pages[`https://www.drivendata.org/competitions/${i}/c/`] = fixture("detail-306.html");
    const f = serving(pages);
    const got = await scan(f);
    expect([f.urls.length, got.listings.length, got.truncated]).toEqual([1 + MAX_DETAILS, MAX_DETAILS + 1, true]);
  });

  it("refuses a page whose cards state no status, instead of reading none as open", async () => {
    const list = fixture("list.html").replaceAll("data-status_active", "data-status-active");
    await expect(scan(serving({ ...site(), [LIST_URL]: list }))).rejects.toThrow(/states no status/);
  });

  it("keeps a competition shown twice once", async () => {
    const list = fixture("list.html").replace("</body>", `${/<div class=" d-flex[^]*?<\/div><\/div>/.exec(fixture("list.html"))![0]}</body>`);
    const got = await scan(serving({ ...site(), [LIST_URL]: list }));
    expect(got.listings.map((l) => l.external_id)).toEqual(["306", "https://platform.example.org/competitions/4/speech/"]);
  });

  it("sets aside a card without a title and keeps the others", async () => {
    const list = fixture("list.html").replace("Example Speech Modeling", "");
    const got = await scan(serving({ ...site(), [LIST_URL]: list }));
    expect([got.listings.map((l) => l.external_id), got.rejected, got.examined]).toEqual([["306"], 1, 2]);
  });
});

describe("drivendata through intake", () => {
  let db: PgDb, close: () => Promise<void>;
  beforeAll(async () => ({ db, close } = await freshPg()));
  afterAll(async () => close());
  beforeEach(async () => db.execute(sql`truncate listings cascade`));
  const NOW = new Date("2026-11-22T02:00:00Z");

  it("stores both contests and a second read inserts no rows", async () => {
    const first = await collectSource(db, "drivendata", NOW, serving(site()));
    expect(first.intake).toEqual({ inserted: 2, updated: 0, unchanged: 0, versioned: 0 });
    expect(await listingBy(db, "drivendata", "306")).toMatchObject({ opportunityType: "contest", budgetMax: 300000, currency: "USD", deadlineKind: "instant", online: null, inviteOnly: null });
    const second = await collectSource(db, "drivendata", new Date(NOW.getTime() + 86_400_000), serving(site()));
    expect(second.intake).toEqual({ inserted: 0, updated: 0, unchanged: 2, versioned: 0 });
  });
});
