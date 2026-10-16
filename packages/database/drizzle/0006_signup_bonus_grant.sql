-- 新用户注册礼：一个月赞助（README 宣传口径「新用户免费领一个月会员」）。
-- 独立 grant 类型，与付费月度（monthly）、后台测试赞助（test）区分：
-- planMonthlyGrant 只衔接 monthly 授权并要求月度锚点，赠送不参与续期计算。
ALTER TYPE "grant_type" ADD VALUE IF NOT EXISTS 'signup_bonus';
