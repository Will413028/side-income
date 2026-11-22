-- contract: per-type column rules (opportunity types plan D10, step 5c-2). Since deploy E1 (76b4757) no image writes a job fact on a contest row (contestFacts stores null) and no image writes a contest column on a job row; the UPDATEs null what deploy D's image wrote on contests before E1's re-evaluation, so the rules hold whether or not the daily run re-evaluated them first.
UPDATE "listings" SET "category" = NULL, "category_score" = NULL, "confirmed_base" = NULL WHERE "opportunity_type" <> 'job';--> statement-breakpoint
UPDATE "listing_versions" SET "category" = NULL, "category_score" = NULL, "confirmed_base" = NULL WHERE "opportunity_type" <> 'job';--> statement-breakpoint
ALTER TABLE "listing_versions" ADD CONSTRAINT "listing_versions_job_facts" CHECK (case when "listing_versions"."opportunity_type" = 'job'
    then "listing_versions"."category" is not null and "listing_versions"."category_score" is not null and "listing_versions"."confirmed_base" is not null
    else "listing_versions"."category" is null and "listing_versions"."category_score" is null and "listing_versions"."confirmed_base" is null end);--> statement-breakpoint
ALTER TABLE "listing_versions" ADD CONSTRAINT "listing_versions_contest_columns" CHECK ("listing_versions"."opportunity_type" = 'contest' or ("listing_versions"."registration_deadline" is null and "listing_versions"."prize_text" is null
    and "listing_versions"."online" is null and "listing_versions"."invite_only" is null and "listing_versions"."hackathon" is null));--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_job_facts" CHECK (case when "listings"."opportunity_type" = 'job'
    then "listings"."category" is not null and "listings"."category_score" is not null and "listings"."confirmed_base" is not null
    else "listings"."category" is null and "listings"."category_score" is null and "listings"."confirmed_base" is null end);--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_contest_columns" CHECK ("listings"."opportunity_type" = 'contest' or ("listings"."registration_deadline" is null and "listings"."prize_text" is null
    and "listings"."online" is null and "listings"."invite_only" is null and "listings"."hackathon" is null));