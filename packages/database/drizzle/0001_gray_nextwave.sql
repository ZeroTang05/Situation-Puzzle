ALTER TYPE "public"."close_reason" ADD VALUE IF NOT EXISTS 'round_ended';--> statement-breakpoint
CREATE TABLE "room_followups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_room_id" uuid NOT NULL,
	"target_room_id" uuid NOT NULL,
	"initiated_by" text NOT NULL,
	"member_results" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "rounds_one_active_per_room_uq";--> statement-breakpoint
DROP INDEX "rounds_room_no_uq";--> statement-breakpoint
ALTER TABLE "room_followups" ADD CONSTRAINT "room_followups_source_room_id_rooms_id_fk" FOREIGN KEY ("source_room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_followups" ADD CONSTRAINT "room_followups_target_room_id_rooms_id_fk" FOREIGN KEY ("target_room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_followups" ADD CONSTRAINT "room_followups_initiated_by_user_id_fk" FOREIGN KEY ("initiated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "room_followups_source_uq" ON "room_followups" USING btree ("source_room_id");--> statement-breakpoint
CREATE INDEX "room_followups_target_idx" ON "room_followups" USING btree ("target_room_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rounds_room_id_uq" ON "rounds" USING btree ("room_id");