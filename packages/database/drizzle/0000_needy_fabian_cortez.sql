CREATE TYPE "public"."moderation_status" AS ENUM('draft', 'submitted', 'checking', 'pending_review', 'published', 'changes_requested', 'taken_down');--> statement-breakpoint
CREATE TYPE "public"."profile_status" AS ENUM('active', 'suspended', 'deletion_pending');--> statement-breakpoint
CREATE TYPE "public"."puzzle_source" AS ENUM('official', 'community', 'imported');--> statement-breakpoint
CREATE TYPE "public"."rating_value" AS ENUM('good', 'hard', 'bad');--> statement-breakpoint
CREATE TYPE "public"."report_object" AS ENUM('turn', 'puzzle', 'room', 'discussion', 'user');--> statement-breakpoint
CREATE TYPE "public"."report_status" AS ENUM('open', 'processing', 'resolved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."rights_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."staff_role" AS ENUM('admin', 'moderator', 'support', 'finance');--> statement-breakpoint
CREATE TYPE "public"."close_reason" AS ENUM('by_host', 'idle', 'all_offline', 'moderation', 'host_left');--> statement-breakpoint
CREATE TYPE "public"."member_status" AS ENUM('joined', 'left', 'kicked');--> statement-breakpoint
CREATE TYPE "public"."room_status" AS ENUM('waiting', 'playing', 'closed');--> statement-breakpoint
CREATE TYPE "public"."round_status" AS ENUM('active', 'solved', 'revealed', 'abandoned', 'aborted');--> statement-breakpoint
CREATE TYPE "public"."turn_kind" AS ENUM('ask', 'solve');--> statement-breakpoint
CREATE TYPE "public"."turn_status" AS ENUM('queued', 'processing', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."credit_action" AS ENUM('reserve', 'consume', 'release', 'refund');--> statement-breakpoint
CREATE TYPE "public"."entitlement_source" AS ENUM('free', 'sponsorship', 'test');--> statement-breakpoint
CREATE TYPE "public"."entitlement_status" AS ENUM('reserved', 'consumed', 'released', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."grant_status" AS ENUM('active', 'frozen', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."grant_type" AS ENUM('monthly', 'lifetime', 'test');--> statement-breakpoint
CREATE TYPE "public"."order_channel" AS ENUM('wechat_native', 'test');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('pending', 'paid', 'closing', 'closed', 'refund_pending', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."refund_status" AS ENUM('pending', 'refunded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."sponsor_ledger_action" AS ENUM('grant', 'freeze', 'revoke', 'extend', 'restore');--> statement-breakpoint
CREATE TYPE "public"."sponsor_product_type" AS ENUM('monthly', 'lifetime');--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_user_id" text,
	"action" text NOT NULL,
	"object_type" text NOT NULL,
	"object_id" text,
	"reason" text,
	"before_summary" jsonb,
	"after_summary" jsonb,
	"related_request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "moderation_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"conclusion" text NOT NULL,
	"reason" text,
	"operator_user_id" text,
	"model_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"user_id" text PRIMARY KEY NOT NULL,
	"nickname" text NOT NULL,
	"status" "profile_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "puzzle_rights" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"puzzle_id" uuid NOT NULL,
	"status" "rights_status" DEFAULT 'pending' NOT NULL,
	"source_url" text,
	"license_basis" text NOT NULL,
	"agreement_version" text NOT NULL,
	"agreed_at" timestamp with time zone,
	"confirmed_by" text,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "puzzle_test_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"input" text NOT NULL,
	"expected" text NOT NULL,
	"reason" text,
	"criticality" text DEFAULT 'normal' NOT NULL,
	"confirmed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "puzzle_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"puzzle_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"language" text NOT NULL,
	"title" text NOT NULL,
	"surface" text NOT NULL,
	"answer" text NOT NULL,
	"hints" jsonb NOT NULL,
	"core_facts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"causal_chain" text,
	"difficulty" text,
	"duration_minutes" integer,
	"content_warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"moderation_status" "moderation_status" DEFAULT 'draft' NOT NULL,
	"source_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "puzzles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"author_user_id" text,
	"source" "puzzle_source" NOT NULL,
	"legacy_id" text,
	"current_published_version_id" uuid,
	"unavailable" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ratings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"puzzle_id" uuid NOT NULL,
	"value" "rating_value" NOT NULL,
	"review" text,
	"round_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reporter_user_id" text NOT NULL,
	"object_type" "report_object" NOT NULL,
	"object_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"detail" text,
	"status" "report_status" DEFAULT 'open' NOT NULL,
	"resolution" text,
	"handled_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_assignments" (
	"user_id" text PRIMARY KEY NOT NULL,
	"role" "staff_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "active_room_users" (
	"user_id" text PRIMARY KEY NOT NULL,
	"room_id" uuid NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"client_request_id" text NOT NULL,
	"type" text NOT NULL,
	"room_id" uuid,
	"round_id" uuid,
	"payload_digest" text NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jev_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"turn_id" uuid,
	"review_version_id" uuid,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"status" text NOT NULL,
	"choice" text,
	"confidence" text,
	"usage" jsonb,
	"cost_source" text,
	"error_class" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "presence" (
	"user_id" text PRIMARY KEY NOT NULL,
	"room_id" uuid,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "room_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"round_id" uuid,
	"seq" bigint NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "room_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"status" "member_status" DEFAULT 'joined' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	"kicked_at" timestamp with time zone,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"creator_user_id" text NOT NULL,
	"host_user_id" text NOT NULL,
	"status" "room_status" DEFAULT 'waiting' NOT NULL,
	"capacity" integer DEFAULT 8 NOT NULL,
	"invite_token_hash" text NOT NULL,
	"control_version" integer DEFAULT 0 NOT NULL,
	"last_seq" bigint DEFAULT 0 NOT NULL,
	"entitlement_id" uuid,
	"selected_puzzle_version_id" uuid,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"close_reason" "close_reason",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "round_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"round_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	"knows_answer" boolean DEFAULT false NOT NULL,
	"can_read" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rounds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"round_no" integer NOT NULL,
	"puzzle_version_id" uuid NOT NULL,
	"language" text NOT NULL,
	"status" "round_status" DEFAULT 'active' NOT NULL,
	"hints_revealed" integer DEFAULT 0 NOT NULL,
	"effective_verdicts" integer DEFAULT 0 NOT NULL,
	"cancel_generation" integer DEFAULT 0 NOT NULL,
	"jev_config_version" text NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"round_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"kind" "turn_kind" NOT NULL,
	"text" text NOT NULL,
	"accepted_seq" bigint NOT NULL,
	"status" "turn_status" DEFAULT 'queued' NOT NULL,
	"result" text,
	"confidence" text,
	"fail_reason" text,
	"execution_token" uuid,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"deadline_at" timestamp with time zone,
	"cancel_generation" integer DEFAULT 0 NOT NULL,
	"jev_config_version" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "free_room_accounts" (
	"user_id" text PRIMARY KEY NOT NULL,
	"total" integer DEFAULT 10 NOT NULL,
	"consumed" integer DEFAULT 0 NOT NULL,
	"reserved" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "free_room_accounts_non_negative" CHECK (consumed >= 0 and reserved >= 0 and consumed + reserved <= total)
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"product_version_id" uuid NOT NULL,
	"product_snapshot" jsonb NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" text NOT NULL,
	"channel" "order_channel" NOT NULL,
	"status" "order_status" DEFAULT 'pending' NOT NULL,
	"merchant_order_no" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"paid_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel" "order_channel" NOT NULL,
	"notification_id" text NOT NULL,
	"order_id" uuid,
	"payload_digest" text NOT NULL,
	"verify_result" text NOT NULL,
	"handle_result" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel" "order_channel" NOT NULL,
	"transaction_id" text NOT NULL,
	"order_id" uuid NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" text NOT NULL,
	"success" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"price_minor" integer NOT NULL,
	"currency" text DEFAULT 'CNY' NOT NULL,
	"title" text NOT NULL,
	"available" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"refund_no" text NOT NULL,
	"amount_minor" integer NOT NULL,
	"reason" text NOT NULL,
	"status" "refund_status" DEFAULT 'pending' NOT NULL,
	"entitlement_status" text DEFAULT 'frozen' NOT NULL,
	"requested_by" text,
	"approved_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "room_credit_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"action" "credit_action" NOT NULL,
	"amount" integer DEFAULT 1 NOT NULL,
	"related_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "room_entitlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"creator_user_id" text NOT NULL,
	"source" "entitlement_source" NOT NULL,
	"sponsor_grant_id" uuid,
	"status" "entitlement_status" DEFAULT 'reserved' NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sponsor_accounts" (
	"user_id" text PRIMARY KEY NOT NULL,
	"monthly_anchor" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sponsor_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"order_id" uuid,
	"type" "grant_type" NOT NULL,
	"status" "grant_status" DEFAULT 'active' NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sponsor_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"action" "sponsor_ledger_action" NOT NULL,
	"grant_id" uuid,
	"order_id" uuid,
	"incident_id" text,
	"room_id" uuid,
	"detail" jsonb,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sponsor_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "sponsor_product_type" NOT NULL,
	"available" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_operator_user_id_user_id_fk" FOREIGN KEY ("operator_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_reviews" ADD CONSTRAINT "moderation_reviews_version_id_puzzle_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."puzzle_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_reviews" ADD CONSTRAINT "moderation_reviews_operator_user_id_user_id_fk" FOREIGN KEY ("operator_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "puzzle_rights" ADD CONSTRAINT "puzzle_rights_puzzle_id_puzzles_id_fk" FOREIGN KEY ("puzzle_id") REFERENCES "public"."puzzles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "puzzle_rights" ADD CONSTRAINT "puzzle_rights_confirmed_by_user_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "puzzle_test_cases" ADD CONSTRAINT "puzzle_test_cases_version_id_puzzle_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."puzzle_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "puzzle_test_cases" ADD CONSTRAINT "puzzle_test_cases_confirmed_by_user_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "puzzle_versions" ADD CONSTRAINT "puzzle_versions_puzzle_id_puzzles_id_fk" FOREIGN KEY ("puzzle_id") REFERENCES "public"."puzzles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "puzzles" ADD CONSTRAINT "puzzles_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "puzzles" ADD CONSTRAINT "puzzles_current_published_version_id_puzzle_versions_id_fk" FOREIGN KEY ("current_published_version_id") REFERENCES "public"."puzzle_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_puzzle_id_puzzles_id_fk" FOREIGN KEY ("puzzle_id") REFERENCES "public"."puzzles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_user_id_user_id_fk" FOREIGN KEY ("reporter_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_handled_by_user_id_fk" FOREIGN KEY ("handled_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "active_room_users" ADD CONSTRAINT "active_room_users_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "active_room_users" ADD CONSTRAINT "active_room_users_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commands" ADD CONSTRAINT "commands_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commands" ADD CONSTRAINT "commands_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commands" ADD CONSTRAINT "commands_round_id_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."rounds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jev_calls" ADD CONSTRAINT "jev_calls_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jev_calls" ADD CONSTRAINT "jev_calls_review_version_id_puzzle_versions_id_fk" FOREIGN KEY ("review_version_id") REFERENCES "public"."puzzle_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presence" ADD CONSTRAINT "presence_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presence" ADD CONSTRAINT "presence_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_events" ADD CONSTRAINT "room_events_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_events" ADD CONSTRAINT "room_events_round_id_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."rounds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_members" ADD CONSTRAINT "room_members_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_members" ADD CONSTRAINT "room_members_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_creator_user_id_user_id_fk" FOREIGN KEY ("creator_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_host_user_id_user_id_fk" FOREIGN KEY ("host_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "round_participants" ADD CONSTRAINT "round_participants_round_id_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."rounds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "round_participants" ADD CONSTRAINT "round_participants_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_puzzle_version_id_puzzle_versions_id_fk" FOREIGN KEY ("puzzle_version_id") REFERENCES "public"."puzzle_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_round_id_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."rounds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "free_room_accounts" ADD CONSTRAINT "free_room_accounts_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_product_version_id_product_versions_id_fk" FOREIGN KEY ("product_version_id") REFERENCES "public"."product_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_notifications" ADD CONSTRAINT "payment_notifications_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_versions" ADD CONSTRAINT "product_versions_product_id_sponsor_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."sponsor_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_approved_by_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_credit_ledger" ADD CONSTRAINT "room_credit_ledger_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_credit_ledger" ADD CONSTRAINT "room_credit_ledger_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_entitlements" ADD CONSTRAINT "room_entitlements_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_entitlements" ADD CONSTRAINT "room_entitlements_creator_user_id_user_id_fk" FOREIGN KEY ("creator_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_entitlements" ADD CONSTRAINT "room_entitlements_sponsor_grant_id_sponsor_grants_id_fk" FOREIGN KEY ("sponsor_grant_id") REFERENCES "public"."sponsor_grants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sponsor_accounts" ADD CONSTRAINT "sponsor_accounts_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sponsor_grants" ADD CONSTRAINT "sponsor_grants_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sponsor_grants" ADD CONSTRAINT "sponsor_grants_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sponsor_ledger" ADD CONSTRAINT "sponsor_ledger_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sponsor_ledger" ADD CONSTRAINT "sponsor_ledger_grant_id_sponsor_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."sponsor_grants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sponsor_ledger" ADD CONSTRAINT "sponsor_ledger_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sponsor_ledger" ADD CONSTRAINT "sponsor_ledger_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_provider_account_uq" ON "account" USING btree ("provider_id","account_id");--> statement-breakpoint
CREATE INDEX "account_user_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_token_uq" ON "session" USING btree ("token");--> statement-breakpoint
CREATE INDEX "session_user_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_email_uq" ON "user" USING btree ("email");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "audit_logs_object_idx" ON "audit_logs" USING btree ("object_type","object_id");--> statement-breakpoint
CREATE INDEX "audit_logs_created_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "moderation_reviews_version_idx" ON "moderation_reviews" USING btree ("version_id");--> statement-breakpoint
CREATE INDEX "puzzle_rights_puzzle_idx" ON "puzzle_rights" USING btree ("puzzle_id");--> statement-breakpoint
CREATE INDEX "puzzle_test_cases_version_idx" ON "puzzle_test_cases" USING btree ("version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "puzzle_versions_uq" ON "puzzle_versions" USING btree ("puzzle_id","version_no","language");--> statement-breakpoint
CREATE INDEX "puzzle_versions_status_idx" ON "puzzle_versions" USING btree ("moderation_status");--> statement-breakpoint
CREATE UNIQUE INDEX "puzzles_source_legacy_uq" ON "puzzles" USING btree ("source","legacy_id");--> statement-breakpoint
CREATE INDEX "puzzles_author_idx" ON "puzzles" USING btree ("author_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ratings_user_puzzle_uq" ON "ratings" USING btree ("user_id","puzzle_id");--> statement-breakpoint
CREATE INDEX "reports_object_idx" ON "reports" USING btree ("object_type","object_id");--> statement-breakpoint
CREATE INDEX "reports_status_idx" ON "reports" USING btree ("status");--> statement-breakpoint
CREATE INDEX "role_assignments_role_idx" ON "role_assignments" USING btree ("role");--> statement-breakpoint
CREATE UNIQUE INDEX "commands_user_request_uq" ON "commands" USING btree ("user_id","client_request_id");--> statement-breakpoint
CREATE INDEX "jev_calls_turn_idx" ON "jev_calls" USING btree ("turn_id");--> statement-breakpoint
CREATE INDEX "jev_calls_started_idx" ON "jev_calls" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "presence_room_idx" ON "presence" USING btree ("room_id");--> statement-breakpoint
CREATE UNIQUE INDEX "room_events_room_seq_uq" ON "room_events" USING btree ("room_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "room_events_event_id_uq" ON "room_events" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "room_events_room_created_idx" ON "room_events" USING btree ("room_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "room_members_room_user_uq" ON "room_members" USING btree ("room_id","user_id");--> statement-breakpoint
CREATE INDEX "room_members_user_idx" ON "room_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rooms_one_open_per_creator_uq" ON "rooms" USING btree ("creator_user_id") WHERE status <> 'closed';--> statement-breakpoint
CREATE UNIQUE INDEX "rooms_invite_token_uq" ON "rooms" USING btree ("invite_token_hash");--> statement-breakpoint
CREATE INDEX "rooms_status_idx" ON "rooms" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "round_participants_round_user_uq" ON "round_participants" USING btree ("round_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rounds_one_active_per_room_uq" ON "rounds" USING btree ("room_id") WHERE status = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "rounds_room_no_uq" ON "rounds" USING btree ("room_id","round_no");--> statement-breakpoint
CREATE INDEX "rounds_status_idx" ON "rounds" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "turns_one_processing_per_round_uq" ON "turns" USING btree ("round_id") WHERE status = 'processing';--> statement-breakpoint
CREATE UNIQUE INDEX "turns_one_active_per_user_uq" ON "turns" USING btree ("round_id","user_id") WHERE status in ('queued', 'processing');--> statement-breakpoint
CREATE INDEX "turns_round_status_idx" ON "turns" USING btree ("round_id","status");--> statement-breakpoint
CREATE INDEX "turns_user_idx" ON "turns" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "free_room_accounts_user_uq" ON "free_room_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_merchant_no_uq" ON "orders" USING btree ("merchant_order_no");--> statement-breakpoint
CREATE INDEX "orders_user_idx" ON "orders" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "orders_status_idx" ON "orders" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_notifications_uq" ON "payment_notifications" USING btree ("channel","notification_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_transactions_uq" ON "payment_transactions" USING btree ("channel","transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_versions_product_no_uq" ON "product_versions" USING btree ("product_id","version_no");--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_no_uq" ON "refunds" USING btree ("refund_no");--> statement-breakpoint
CREATE INDEX "refunds_order_idx" ON "refunds" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "refunds_status_idx" ON "refunds" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "room_credit_ledger_room_action_uq" ON "room_credit_ledger" USING btree ("room_id","action");--> statement-breakpoint
CREATE INDEX "room_credit_ledger_user_idx" ON "room_credit_ledger" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "room_entitlements_room_uq" ON "room_entitlements" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "room_entitlements_creator_idx" ON "room_entitlements" USING btree ("creator_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sponsor_grants_order_uq" ON "sponsor_grants" USING btree ("order_id") WHERE order_id is not null;--> statement-breakpoint
CREATE INDEX "sponsor_grants_user_idx" ON "sponsor_grants" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sponsor_ledger_idempotency_uq" ON "sponsor_ledger" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "sponsor_ledger_user_idx" ON "sponsor_ledger" USING btree ("user_id");