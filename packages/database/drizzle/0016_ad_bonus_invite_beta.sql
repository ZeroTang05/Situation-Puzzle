-- 奖励额度与内测畅玩（docs/rebuild/21-MONETIZATION-REVISION.md）：
-- ① room_bonus_ledger：看广告 / 邀请好友注册发的开房额度流水，
--    幂等键唯一（广告=微信回调 trans_id，邀请=被邀请人 userId），发奖与 total 增发同事务；
-- ② profiles.invite_code：每人一个邀请码（注册时生成，存量用户懒生成回填）；
-- ③ 开房授权来源新增 beta：内测期（BETA_OPEN_ROOM=true）所有人畅玩，授权落此来源。

CREATE TYPE "room_bonus_kind" AS ENUM ('ad_bonus', 'invite_bonus');

CREATE TABLE "room_bonus_ledger" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id"),
  "kind" "room_bonus_kind" NOT NULL,
  "amount" integer NOT NULL,
  "detail" jsonb,
  "idempotency_key" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "room_bonus_ledger_idempotency_uq" ON "room_bonus_ledger" ("idempotency_key");
CREATE INDEX "room_bonus_ledger_user_idx" ON "room_bonus_ledger" ("user_id");

ALTER TABLE "profiles" ADD COLUMN "invite_code" text;
CREATE UNIQUE INDEX "profiles_invite_code_uq" ON "profiles" ("invite_code");

--> Note: separate transaction so that the enum value is visible to subsequent statements

ALTER TYPE "entitlement_source" ADD VALUE IF NOT EXISTS 'beta';
