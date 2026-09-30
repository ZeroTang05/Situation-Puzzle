DROP TABLE "active_room_users";--> statement-breakpoint
DROP INDEX "rooms_one_open_per_creator_uq";--> statement-breakpoint
ALTER TABLE "presence" DROP CONSTRAINT "presence_pkey";--> statement-breakpoint
ALTER TABLE "presence" ALTER COLUMN "room_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "presence" ADD CONSTRAINT "presence_room_id_user_id_pk" PRIMARY KEY("room_id","user_id");
