-- 支付宝通道：与微信支付 v3 并列的第二条在线收款通道。
--
-- 通道值 alipay 覆盖支付宝开放平台两种产品（由 ALIPAY_PRODUCT 决定）：
--   - precreate：当面付（扫码，前端渲染二维码）
--   - page：电脑网站支付（跳转 alipay.trade.page.pay）
-- 两者都用同一套商户凭据与同一套异步通知验签逻辑。
--
-- order_channel 是 pgEnum，新增值需要 ALTER TYPE ... ADD VALUE（PostgreSQL 要求
-- 新枚举值在事务提交后才能被使用，本迁移在提交后即可正常使用）。
-- 详见 packages/database/src/schema/billing.ts orderChannelEnum 定义。

ALTER TYPE "order_channel" ADD VALUE IF NOT EXISTS 'alipay';
