-- 赞助码通道（零实名收款）：微信/支付宝商户资质未开通时，运营方用个人收款码收款后发码，
-- 用户在站内兑换，服务端核销并发放与微信支付完全相同的赞助授权。
--
-- 一码一权：code 唯一索引防重复；核销时对行加锁并把 status 从 unused 改为 used。
-- 订单通道新增 redeem_code，与 wechat_native / test 并列。
-- 详见 packages/database/src/schema/billing.ts redeemCodes 定义。

ALTER TYPE "order_channel" ADD VALUE IF NOT EXISTS 'redeem_code';

CREATE TYPE "redeem_code_status" AS ENUM ('unused', 'used', 'revoked');

CREATE TABLE "redeem_codes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "code" text NOT NULL,
  "code_key" text NOT NULL,
  "product_version_id" uuid NOT NULL REFERENCES "product_versions"("id"),
  "status" "redeem_code_status" DEFAULT 'unused' NOT NULL,
  "batch_id" text NOT NULL,
  "note" text,
  "created_by" text REFERENCES "user"("id"),
  "used_by" text REFERENCES "user"("id"),
  "used_at" timestamp with time zone,
  "order_id" uuid REFERENCES "orders"("id"),
  "expires_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "redeem_codes_code_uq" UNIQUE ("code"),
  CONSTRAINT "redeem_codes_code_key_uq" UNIQUE ("code_key")
);

CREATE INDEX "redeem_codes_batch_idx" ON "redeem_codes" ("batch_id");
CREATE INDEX "redeem_codes_status_idx" ON "redeem_codes" ("status");
