ALTER TABLE "listing_versions" ALTER COLUMN "category" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "listing_versions" ALTER COLUMN "category_score" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "listing_versions" ALTER COLUMN "confirmed_base" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "listings" ALTER COLUMN "category" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "listings" ALTER COLUMN "category_score" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "listings" ALTER COLUMN "confirmed_base" DROP NOT NULL;