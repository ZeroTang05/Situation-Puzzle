-- 作品通过人工审核的作者奖励：一次 +10 次开房额度（docs/rebuild/21-MONETIZATION-REVISION.md）。
-- 与广告（ad_bonus）/邀请（invite_bonus）共用 room_bonus_ledger 流水表，幂等键
-- creation-bonus:<puzzleId>（一道作品终身只发一次，修订版再次发布不重发）。
ALTER TYPE "room_bonus_kind" ADD VALUE IF NOT EXISTS 'creation_bonus';
