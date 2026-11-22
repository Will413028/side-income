import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { PgDb } from "@/db/pg/client";
import { listingBy } from "@/modules/listings/public";
import { FetchError, type Fetcher } from "@/platform/fetch";
import { collectSource } from "@/services/collect";
import { DETAIL_WAIT, idOf, KAGGLE_SETTINGS, kaggleConnector, LIST_URL, LIST_WAIT, MAX_DETAILS, parseDetail, parseList, prizeOf, scan } from ".";
import { freshPg } from "../../../../tests/helpers/pg";

// Opportunity types plan step 6c-3. fixtures/ is the connector's ground truth: synthetic pages shaped on the
// list and detail pages the stealth service rendered on the VM 2026-11-22 (no captured page).

const fixture = (f: string) => readFileSync(path.join(import.meta.dirname, "fixtures", f), "utf8");
const detailUrl = (slug: string) => `https://www.kaggle.com/competitions/${slug}`;
const LATE = fixture("detail.html").replace("10 days to go</span></div>", "Nov 2, 2026</span></div>");

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
      return { status: 200, body: new TextEncoder().encode(pages[url]), tier: "stealth" };
    },
  };
};
const site = (detail = fixture("detail.html")) => ({
  [LIST_URL]: fixture("list.html"), [detailUrl("example-agent")]: detail,
  [detailUrl("example-bowl")]: detail.replaceAll("Example Agent Competition", "Example Bowl"), [detailUrl("example-late")]: LATE,
});

describe("kaggle list", () => {
  it("reads every competition card once, with its title, icon, prize and state, the list rows included", () => {
    expect(parseList(fixture("list.html"))).toEqual([
      { slug: "titanic", title: "Example Starter", hackathon: false, prize: "Knowledge", state: "ongoing" },
      { slug: "example-agent", title: "Example Agent Competition", hackathon: false, prize: "$75,000", state: "to_go" },
      { slug: "example-bowl", title: "Example Bowl", hackathon: true, prize: "Kudos", state: "to_go" },
      { slug: "example-late", title: "Example Late", hackathon: false, prize: "$850,000", state: "unknown" },
    ]);
  });

  it("refuses a page with no competition card", () => {
    expect(() => parseList("<html><body>maintenance</body></html>")).toThrow(/no competition cards/);
  });

  it("takes one-segment competition paths on kaggle.com only", () => {
    expect([idOf("/competitions/example-agent"), idOf("https://www.kaggle.com/competitions/example-agent?tab=overview"), idOf("/competitions/example-agent/leaderboard"), idOf("/competitions/../datasets"), idOf("https://example.com/competitions/x1y2")]).toEqual(["example-agent", "example-agent", null, null, null]);
  });

  it("reads a dollar prize as USD and keeps swag and kudos as text", () => {
    expect([prizeOf("$75,000"), prizeOf("3 Swag"), prizeOf(null)]).toEqual([
      { prize_text: "$75,000", budget_max: 75000, currency: "USD" }, { prize_text: "3 Swag", budget_max: null, currency: null }, { prize_text: null, budget_max: null, currency: null },
    ]);
  });
});

describe("kaggle detail", () => {
  it("reads the final submission and entry deadlines, with the UTC note, the open state and the host", () => {
    expect(parseDetail(fixture("detail.html"))).toEqual({ open: true, deadline: { kind: "instant", at: "2026-12-02T23:59:00.000Z" }, entry: "2026-11-25", title: "Example Agent Competition", host: "Example Host" });
  });

  it("reads the date after the label too, and an entry deadline that is the final one", () => {
    const page = "<h1>T</h1><div><span>Close</span><span>8 days to go</span></div><p>Start Date - November 1, 2026 Entry Deadline - Same as the Final Submission Deadline Team Merger Deadline - Same as the Final Submission Deadline Final Submission Deadline - November 30, 2026 All deadlines are at 11:59 PM UTC on the corresponding day unless otherwise noted.</p>";
    expect(parseDetail(page)).toMatchObject({ open: true, deadline: { kind: "instant", at: "2026-11-30T23:59:00.000Z" }, entry: "2026-11-30" });
  });

  it("keeps a date without the UTC note as a date (D12), and no entry deadline when the timeline has none", () => {
    const page = "<h1>T</h1><span>Close</span><span>A month to go</span><p>October 6, 2026 - Start Date. January 6, 2027 - Final Submission Deadline.</p>";
    expect(parseDetail(page)).toMatchObject({ open: true, deadline: { kind: "date", date: "2027-01-06" }, entry: null });
  });

  it("reads a closed competition (an absolute close date) as not open, and a page without a close field as unknown", () => {
    expect(parseDetail(LATE).open).toBe(false);
    expect(parseDetail("<h1>T</h1><p>nothing</p>")).toEqual({ open: null, deadline: null, entry: null, title: "T", host: null });
    expect(parseDetail("<h1>T</h1><p>February 30, 2027 - Final Submission Deadline.</p>").deadline).toBeNull();
  });
});

describe("kaggle pages", () => {
  it("waits for visible elements: the render service waits until its selector is visible, which a script never is", () => {
    for (const sel of [LIST_WAIT, DETAIL_WAIT]) expect(sel).not.toMatch(/^\s*(script|meta|link|head|style|template)\b/i);
  });

  it("renders the list, then every card that is not ongoing, and keeps only the open ones", async () => {
    const f = serving(site());
    const got = await kaggleConnector(f);
    expect(f.urls).toEqual([LIST_URL, detailUrl("example-agent"), detailUrl("example-bowl"), detailUrl("example-late")]);
    expect([got.seen, got.truncated, got.rejected]).toEqual([2, false, 0]);
    expect(got.listings.map((l) => [l.external_id, l.title, l.company, l.budget_max, l.currency, l.hackathon, l.online, l.deadline, l.registration_deadline, l.url])).toEqual([
      ["example-agent", "Example Agent Competition", "Example Host", 75000, "USD", false, true, { kind: "instant", at: "2026-12-02T23:59:00.000Z" }, "2026-11-25", detailUrl("example-agent")],
      ["example-bowl", "Example Bowl", "Example Host", null, null, true, true, { kind: "instant", at: "2026-12-02T23:59:00.000Z" }, "2026-11-25", detailUrl("example-bowl")],
    ]);
    expect(got.listings[1].prize_text).toBe("Kudos");
  });

  it("falls back to the list's `to go` when a page shows no close field, and drops a list row whose page shows none", async () => {
    const bare = "<h1>Example Bowl</h1><p>nothing readable</p>";
    const got = await scan(serving({ ...site(), [detailUrl("example-bowl")]: bare, [detailUrl("example-late")]: bare }));
    expect(got.listings.map((l) => [l.external_id, l.deadline])).toEqual([["example-agent", { kind: "instant", at: "2026-12-02T23:59:00.000Z" }], ["example-bowl", null]]);
  });

  it("fails the run when no page read shows a final submission deadline (the layout or the render changed)", async () => {
    const bare = "<h1>T</h1><span>Close</span><span>10 days to go</span>";
    await expect(scan(serving({ ...site(bare), [detailUrl("example-late")]: bare }))).rejects.toThrow(/no detail page shows a final submission deadline/);
  });

  it("fails the run when a page does not render, and on Kaggle's check page", async () => {
    await expect(scan(serving({ [LIST_URL]: fixture("list.html") }))).rejects.toThrow();
    await expect(scan(serving({ ...site(), [LIST_URL]: "<html><head><title>Checking your browser - reCAPTCHA</title></head></html>" }))).rejects.toThrow(/challenge/i);
  });

  it("renders at most MAX_DETAILS pages and marks the read truncated beyond them", async () => {
    const card = (s: string) => `<a href="/competitions/${s}"><span class="google-symbols">trophy</span><div>${s}</div><h2>$1</h2><span>9 days to go</span></a>`;
    const slugs = Array.from({ length: MAX_DETAILS + 1 }, (_, i) => `c${String(i).padStart(3, "0")}`);
    const pages: Record<string, string> = { [LIST_URL]: `<html><body>${slugs.map(card).join("")}</body></html>` };
    for (const s of slugs) pages[detailUrl(s)] = fixture("detail.html");
    const f = serving(pages);
    const got = await scan(f);
    expect([f.urls.length, got.listings.length, got.truncated, KAGGLE_SETTINGS.maxRequestsPerRun, KAGGLE_SETTINGS.maxTier]).toEqual([1 + MAX_DETAILS, MAX_DETAILS, true, 1 + MAX_DETAILS, "stealth"]);
  });
});

describe("kaggle through intake", () => {
  let db: PgDb, close: () => Promise<void>;
  beforeAll(async () => ({ db, close } = await freshPg()));
  afterAll(async () => close());
  beforeEach(async () => db.execute(sql`truncate listings cascade`));
  const NOW = new Date("2026-11-22T02:00:00Z");

  it("stores both open contests with an instant deadline, and a second read inserts no rows", async () => {
    const first = await collectSource(db, "kaggle", NOW, serving(site()));
    expect(first.intake).toEqual({ inserted: 2, updated: 0, unchanged: 0, versioned: 0 });
    expect(await listingBy(db, "kaggle", "example-agent")).toMatchObject({ opportunityType: "contest", budgetMax: 75000, currency: "USD", deadlineKind: "instant", registrationDeadline: "2026-11-25", online: true, hackathon: false });
    const second = await collectSource(db, "kaggle", new Date(NOW.getTime() + 86_400_000), serving(site()));
    expect(second.intake).toEqual({ inserted: 0, updated: 0, unchanged: 2, versioned: 0 });
  });
});
