-- contract: run_sources.tier admits plain, browser_like, browser, stealth; the rollback image (the deploy before 6c-2) writes only the first three
ALTER TABLE "run_sources" DROP CONSTRAINT "run_sources_tier";--> statement-breakpoint
ALTER TABLE "run_sources" ADD CONSTRAINT "run_sources_tier" CHECK ("run_sources"."tier" in ('plain', 'browser_like', 'browser', 'stealth'));