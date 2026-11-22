import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { PgDb } from "@/db/pg/client";
import { listingBy } from "@/modules/listings/public";
import { FetchError, type Fetcher } from "@/platform/fetch";
import { collectSource } from "@/services/collect";
import { BHUNTR_SETTINGS, bhuntrConnector, idOf, LIST_URL, MAX_DETAILS, organiserOf, periodEnd, prizeOf, scan } from ".";
import { freshPg } from "../../../../tests/helpers/pg";

// Opportunity types plan step 6c-1. fixtures/ is the connector's ground truth: synthetic pages shaped on the
// rendered list and detail pages measured on the VM 2026-11-22 (no captured page).

const fixture = (f: string) => readFileSync(path.join(import.meta.dirname, "fixtures", f), "utf8");
const detailUrl = (id: string) => `https://bhuntr.com/tw/competitions/${id}`;

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
      return { status: 200, body: new TextEncoder().encode(pages[url]), tier: "browser" };
    },
  };
};
const site = (list = fixture("list.html"), detail = fixture("detail.html")) => ({
  [LIST_URL]: list, [detailUrl("aaaaaaaaaaaaaaaaa1")]: detail, [detailUrl("aaaaaaaaaaaaaaaaa2")]: detail,
});

describe("bhuntr readers", () => {
  it("reads the period's end as UTC (the browser service renders in UTC, D16), and nothing else", () => {
    expect(periodEnd("徵件期間 2026-10-22 02:00 至 2026-11-30 15:59 其他")).toBe("2026-11-30T15:59:00.000Z");
    expect([periodEnd("徵件期間 2026-10-22 02:00 至 2026-02-30 15:59"), periodEnd("徵件期間 2026-10-22 至 2026-11-30"), periodEnd("no period")]).toEqual([null, null, null]);
  });

  it("reads the prize in TWD and keeps other text without an amount", () => {
    expect([prizeOf("1,000,000 TWD"), prizeOf("獎品 TWD"), prizeOf(null)]).toEqual([
      { prize_text: "1,000,000 TWD", budget_max: 1000000, currency: "TWD" }, { prize_text: "獎品 TWD", budget_max: null, currency: null }, { prize_text: null, budget_max: null, currency: null },
    ]);
  });

  it("takes the organiser from the JSON-LD Event and the id from the competition path", () => {
    expect(organiserOf(fixture("detail.html"))).toBe("範例基金會");
    expect(organiserOf("<script type=\"application/ld+json\">not json</script>")).toBeNull();
    expect([idOf("/tw/competitions/aaaaaaaaaaaaaaaaa1"), idOf("/tw/competitions/../../events/abcdef"), idOf("/tw/events/aaaaaaaaaaaaaaaaa1")]).toEqual(["aaaaaaaaaaaaaaaaa1", null, null]);
  });
});

describe("bhuntr pages", () => {
  it("renders the list, then only the open cards' pages, and keeps their end, organiser and prize", async () => {
    const f = serving(site());
    const got = await bhuntrConnector(f);
    expect(f.urls).toEqual([LIST_URL, detailUrl("aaaaaaaaaaaaaaaaa1"), detailUrl("aaaaaaaaaaaaaaaaa2")]);
    expect([got.seen, got.truncated, got.rejected]).toEqual([2, false, 0]);
    expect(got.listings.map((l) => [l.external_id, l.title, l.company, l.budget_max, l.currency, l.deadline])).toEqual([
      ["aaaaaaaaaaaaaaaaa1", "範例設計獎", "範例基金會", 1000000, "TWD", { kind: "instant", at: "2026-11-30T15:59:00.000Z" }],
      ["aaaaaaaaaaaaaaaaa2", "範例影像競賽", "範例基金會", 500000, "TWD", { kind: "instant", at: "2026-11-30T15:59:00.000Z" }],
    ]);
  });

  it("one open page without a readable period keeps that deadline unknown", async () => {
    const got = await scan(serving({ ...site(), [detailUrl("aaaaaaaaaaaaaaaaa2")]: "<html><body>changed</body></html>" }));
    expect(got.listings.map((l) => [l.external_id, l.deadline === null, l.company])).toEqual([["aaaaaaaaaaaaaaaaa1", false, "範例基金會"], ["aaaaaaaaaaaaaaaaa2", true, null]]);
  });

  it("fails the run when no page read shows its period (the layout or the render changed)", async () => {
    await expect(scan(serving(site(undefined, "<html><body>changed</body></html>")))).rejects.toThrow(/no detail page shows its period/);
  });

  it("reads a period whose date and time sit in separate elements", () => {
    expect(periodEnd("徵件期間2026-10-2202:00至2026-11-3015:59")).toBe("2026-11-30T15:59:00.000Z");
  });

  it("fails the run when no card shows a timeline badge", async () => {
    await expect(scan(serving(site(fixture("list.html").replaceAll("bh-timeline-block", "bh-other-block"))))).rejects.toThrow(/timeline badge/);
  });

  it("reads an absolute link with a query as the same id", () => {
    expect(idOf("https://bhuntr.com/tw/competitions/aaaaaaaaaaaaaaaaa1?utm_source=list")).toBe("aaaaaaaaaaaaaaaaa1");
    expect([idOf("https://example.com/tw/competitions/aaaaaaaaaaaaaaaaa1"), idOf("/tw/competitions/aaaa.aaaaaaaa")]).toEqual([null, null]);
  });

  it("renders at most MAX_DETAILS pages and marks the read truncated beyond them", async () => {
    const one = fixture("list.html").split('<div class="col-12')[1];
    const ids = Array.from({ length: MAX_DETAILS + 1 }, (_, i) => `bbbbbbbbbbbbbbbb${String(i).padStart(2, "0")}`);
    const list = `<html><body>${ids.map((id) => `<div class="col-12${one.replace("aaaaaaaaaaaaaaaaa1", id)}`).join("")}</body></html>`;
    const pages: Record<string, string> = { [LIST_URL]: list };
    for (const id of ids) pages[detailUrl(id)] = fixture("detail.html");
    const f = serving(pages);
    const got = await scan(f);
    expect([f.urls.length, got.listings.length, got.truncated, BHUNTR_SETTINGS.maxRequestsPerRun]).toEqual([1 + MAX_DETAILS, MAX_DETAILS, true, 1 + MAX_DETAILS]);
  });

  it("sets aside an open card without an id and refuses a list with no cards", async () => {
    const got = await scan(serving(site(fixture("list.html").replace("/tw/competitions/aaaaaaaaaaaaaaaaa2", "/tw/competitions/../../events/abcdef"))));
    expect([got.listings.map((l) => l.external_id), got.rejected, got.examined]).toEqual([["aaaaaaaaaaaaaaaaa1"], 1, 2]);
    await expect(scan(serving({ [LIST_URL]: "<html><body>maintenance</body></html>" }))).rejects.toThrow(/no competition cards/);
  });

  it("fails the run when an open card's page does not render", async () => {
    await expect(scan(serving({ [LIST_URL]: fixture("list.html") }))).rejects.toThrow();
  });
});

describe("bhuntr through intake", () => {
  let db: PgDb, close: () => Promise<void>;
  beforeAll(async () => ({ db, close } = await freshPg()));
  afterAll(async () => close());
  beforeEach(async () => db.execute(sql`truncate listings cascade`));
  const NOW = new Date("2026-11-22T02:00:00Z");

  it("stores both contests with an instant deadline, and a second read inserts no rows", async () => {
    const first = await collectSource(db, "bhuntr", NOW, serving(site()));
    expect(first.intake).toEqual({ inserted: 2, updated: 0, unchanged: 0, versioned: 0 });
    expect(await listingBy(db, "bhuntr", "aaaaaaaaaaaaaaaaa1")).toMatchObject({ opportunityType: "contest", budgetMax: 1000000, currency: "TWD", deadlineKind: "instant", online: null, inviteOnly: null });
    const second = await collectSource(db, "bhuntr", new Date(NOW.getTime() + 86_400_000), serving(site()));
    expect(second.intake).toEqual({ inserted: 0, updated: 0, unchanged: 2, versioned: 0 });
  });
});
