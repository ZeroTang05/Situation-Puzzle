-- 用户界面语言：服务端据此发中文或英文的事务邮件（验证码 / 重置密码）
--
-- 目标：去掉全局 JEV_LANGUAGE 环境变量，语言改为实时取用户设置。
--   profiles.language  用户的界面语言（zh / en），前端切换语言时上报
--   请求头 X-Jev-Language  当前请求的实时语言（未登录也可用），服务端优先取它
--
-- 判题语言与之无关：判题按题目/本局/投稿自身的语言走，同一部署可同时判中英文题。
-- 存量账号全部落在默认 'zh'，无需回填。

ALTER TABLE "profiles"
  ADD COLUMN IF NOT EXISTS "language" text NOT NULL DEFAULT 'zh';

-- 只允许 zh / en：接口层已用 zod 校验，库里再加一道约束防脏数据
ALTER TABLE "profiles"
  DROP CONSTRAINT IF EXISTS "profiles_language_check";
ALTER TABLE "profiles"
  ADD CONSTRAINT "profiles_language_check" CHECK ("language" IN ('zh', 'en'));
