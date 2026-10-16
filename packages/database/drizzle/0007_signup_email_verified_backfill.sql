-- 存量密码注册用户补记邮箱已验证：这些账号都经过了注册验证码闸门，
-- 只是 Better Auth 的 /sign-up/email 默认不写 email_verified。
-- 必须补齐：email_verified=false 的用户一旦走验证码登录，Better Auth 的
-- revokeUnprovenAccountAccess 会删除其密码凭证（视为无主账号接管保护）。
UPDATE "user" u SET "email_verified" = true
WHERE "email_verified" = false
  AND EXISTS (SELECT 1 FROM "account" a WHERE a."user_id" = u."id" AND a."provider_id" = 'credential');
