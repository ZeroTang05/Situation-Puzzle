-- 「来一局」改成邀请语义：房间成员不再自动拉对方进来，私聊卡片里的
-- 「进入房间」是一个邀请链接，只有对方点了才进房。
-- 房间表只存邀请令牌散列，明文令牌只在创建时返回一次；卡片要长期当链接用，
-- 所以明文随卡片消息落在 dm_messages 上（只有会话双方能读到）。
ALTER TABLE "dm_messages" ADD COLUMN IF NOT EXISTS "invite_token" text;
