ALTER TABLE "session" ADD COLUMN "mini_platform" text;
--> statement-breakpoint
UPDATE "session" s SET "mini_platform" = a."provider_id"
FROM "account" a, "user" u
WHERE s."user_id" = u."id" AND a."user_id" = u."id"
  AND ((a."provider_id" = 'wechat-mini' AND u."email" LIKE '%@wechat.invalid')
    OR (a."provider_id" = 'taptap-mini' AND u."email" LIKE '%@taptap.invalid'));
--> statement-breakpoint
CREATE TABLE "platform_email_bindings" (
  "user_id" text PRIMARY KEY REFERENCES "user" ("id") ON DELETE CASCADE,
  "platform" text NOT NULL,
  "email" text NOT NULL,
  "source_user_id" text REFERENCES "user" ("id") ON DELETE SET NULL,
  "verified_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "platform_email_bindings_platform_email_uq" UNIQUE ("platform", "email")
);
--> statement-breakpoint
ALTER TYPE "entitlement_source" ADD VALUE 'ad';
--> statement-breakpoint
ALTER TABLE "free_room_accounts"
  ADD COLUMN "ad_total" integer NOT NULL DEFAULT 0,
  ADD COLUMN "ad_consumed" integer NOT NULL DEFAULT 0,
  ADD COLUMN "ad_reserved" integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT "free_room_accounts_ad_non_negative" CHECK (ad_consumed >= 0 AND ad_reserved >= 0 AND ad_consumed + ad_reserved <= ad_total);
