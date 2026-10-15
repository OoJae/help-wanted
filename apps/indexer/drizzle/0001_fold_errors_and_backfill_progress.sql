ALTER TABLE "cursors" ADD COLUMN "backfill_from" bigint;--> statement-breakpoint
ALTER TABLE "cursors" ADD COLUMN "backfill_next" bigint;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "fold_error" text;