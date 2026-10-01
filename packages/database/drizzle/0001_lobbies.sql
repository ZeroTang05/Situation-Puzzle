-- 会客厅 v3：每个用户固定一个会客厅 id（host_user_id UNIQUE），
-- 临时态写在 user_lobbies 行上；start() 单事务内清临时态 + revoke 邀请。
-- 详见 apps/api/src/rooms/lobby.service.ts 头部注释。

CREATE TYPE "public"."lobby_status" AS ENUM('closed', 'open');

CREATE TABLE "user_lobbies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"host_user_id" text NOT NULL UNIQUE REFERENCES "user"("id") ON DELETE CASCADE,
	"status" "lobby_status" DEFAULT 'closed' NOT NULL,
	"capacity" integer DEFAULT 8 NOT NULL,
	"selected_puzzle_id" text,
	"selected_puzzle_lang" text,
	"selected_puzzle_title" text,
	"selected_puzzle_surface" text,
	"started_room_id" uuid REFERENCES "rooms"("id") ON DELETE SET NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opened_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"started_at" timestamp with time zone
);
CREATE INDEX "user_lobbies_status_idx" ON "user_lobbies" USING btree ("status");

CREATE TABLE "lobby_members" (
	"lobby_id" uuid NOT NULL REFERENCES "user_lobbies"("id") ON DELETE CASCADE,
	"user_id" text NOT NULL REFERENCES "user"("id"),
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	PRIMARY KEY ("lobby_id","user_id")
);
CREATE INDEX "lobby_members_user_idx" ON "lobby_members" USING btree ("user_id");

CREATE TABLE "lobby_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lobby_id" uuid NOT NULL REFERENCES "user_lobbies"("id") ON DELETE CASCADE,
	"token_hash" text NOT NULL UNIQUE,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
CREATE INDEX "lobby_invites_lobby_idx" ON "lobby_invites" USING btree ("lobby_id");
CREATE INDEX "lobby_invites_active_idx" ON "lobby_invites" USING btree ("lobby_id") WHERE revoked_at IS NULL;
