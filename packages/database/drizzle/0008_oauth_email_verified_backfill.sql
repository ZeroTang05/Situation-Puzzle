-- OAuth 存量用户补记邮箱已验证：能完成 Google / LINUX DO 登录即已证明身份归属。
-- 与 0007 同理（credential 批），统一 email_verified 语义，后台列表不再出现「未验证」误报。
UPDATE "user" u SET "email_verified" = true
WHERE "email_verified" = false
  AND EXISTS (SELECT 1 FROM "account" a WHERE a."user_id" = u."id" AND a."provider_id" != 'credential');
