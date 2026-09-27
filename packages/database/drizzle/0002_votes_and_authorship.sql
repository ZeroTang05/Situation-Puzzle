-- 投票 v2 与作者署名（docs/rebuild/11-VOTES-AND-AUTHORSHIP.md §4/§6）。
-- 评价语义整体更换（good/hard/bad → up/down、不再关联局、取消文字评论），
-- 旧评价行不再有对应语义，随列一起清除（本迁移执行时无生产数据）。
DELETE FROM "ratings";--> statement-breakpoint
ALTER TABLE "ratings" DROP COLUMN "value";--> statement-breakpoint
ALTER TABLE "ratings" DROP COLUMN "review";--> statement-breakpoint
ALTER TABLE "ratings" DROP COLUMN "round_id";--> statement-breakpoint
DROP TYPE "rating_value";--> statement-breakpoint
CREATE TYPE "public"."vote_value" AS ENUM('up', 'down');--> statement-breakpoint
CREATE TYPE "public"."author_display_mode" AS ENUM('anonymous', 'signature');--> statement-breakpoint
ALTER TABLE "ratings" ADD COLUMN "value" "vote_value" NOT NULL;--> statement-breakpoint
ALTER TABLE "ratings" ADD COLUMN "voted_version_id" uuid;--> statement-breakpoint
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_voted_version_id_puzzle_versions_id_fk" FOREIGN KEY ("voted_version_id") REFERENCES "public"."puzzle_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "puzzles" ADD COLUMN "author_display_mode" "author_display_mode" DEFAULT 'anonymous' NOT NULL;--> statement-breakpoint
ALTER TABLE "puzzles" ADD COLUMN "author_display_name" text;--> statement-breakpoint
ALTER TABLE "puzzles" ADD COLUMN "author_pending_name" text;