import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { PG_MIGRATIONS } from "@/db/pg/migrate";

// Opportunity types plan step 5c-2: migration 0006 applies over the rows deploy D's image wrote (a contest
// with the job facts' neutral values, not yet re-evaluated by deploy E1's image) and nulls them first.

const files = readdirSync(PG_MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
const run = async (db: PGlite, file: string) => {
  for (const statement of readFileSync(path.join(PG_MIGRATIONS, file), "utf8").split("--> statement-breakpoint")) {
    if (statement.replace(/--.*$/gm, "").trim()) await db.exec(statement);
  }
};
const insert = (type: string, ext: string, category: string, score: number) => `insert into listings
  (source, external_id, fingerprint, raw, title, hard_excluded, source_kept, opportunity_type, category, category_score, confirmed_base)
  values ('s', '${ext}', 'f${ext}', '{}', 't', false, true, '${type}', '${category}', ${score}, 0)`;

describe("migration 0006 over deploy D's contest rows", () => {
  it("nulls the job facts of a contest, keeps a job's, then adds the rules", async () => {
    const db = new PGlite();
    const last = files.indexOf(files.find((f) => f.startsWith("0006_"))!);
    expect(last).toBeGreaterThan(0);
    for (const f of files.slice(0, last)) await run(db, f);
    await db.exec(insert("contest", "c", "其他", 0));
    await db.exec(insert("job", "j", "AI agent", 95));
    // A version row of each type too (deploy D wrote none for contests; the UPDATE covers one anyway).
    for (const ext of ["c", "j"]) await db.exec(`insert into listing_versions (listing_id, fingerprint, raw, title, hard_excluded, opportunity_type, category, category_score, confirmed_base)
      select id, 'v' || external_id, '{}', 't', false, opportunity_type, category, category_score, confirmed_base from listings where external_id = '${ext}'`);
    await run(db, files[last]);
    const versions = await db.query("select opportunity_type, category, category_score, confirmed_base from listing_versions order by opportunity_type");
    expect(versions.rows).toEqual([
      { opportunity_type: "contest", category: null, category_score: null, confirmed_base: null },
      { opportunity_type: "job", category: "AI agent", category_score: 95, confirmed_base: 0 },
    ]);
    const rows = await db.query<{ external_id: string; category: string | null; category_score: number | null; confirmed_base: number | null }>(
      "select external_id, category, category_score, confirmed_base from listings order by external_id");
    expect(rows.rows).toEqual([
      { external_id: "c", category: null, category_score: null, confirmed_base: null },
      { external_id: "j", category: "AI agent", category_score: 95, confirmed_base: 0 },
    ]);
    await expect(db.exec(insert("contest", "c2", "其他", 0))).rejects.toThrow(/listings_job_facts/);
    await db.close();
  });
});
