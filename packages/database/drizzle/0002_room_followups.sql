-- 补建缺失的 room_followups 表（0000_consolidated.sql 漏建）。
-- 用于续玩关系（再来一题）：源房 → 目标房的迁移记录。
-- 详见 packages/database/src/schema/rooms.ts roomFollowups 定义。

CREATE TABLE "room_followups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_room_id" uuid NOT NULL REFERENCES "rooms"("id") ON DELETE CASCADE,
	"target_room_id" uuid NOT NULL REFERENCES "rooms"("id") ON DELETE CASCADE,
	"initiated_by" text NOT NULL REFERENCES "user"("id"),
	"member_results" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "room_followups_source_uq" ON "room_followups" USING btree ("source_room_id");
CREATE INDEX "room_followups_target_idx" ON "room_followups" USING btree ("target_room_id");
