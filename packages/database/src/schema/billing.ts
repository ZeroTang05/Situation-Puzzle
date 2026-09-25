/**
 * 赞助与支付域：商品、订单、支付流水、赞助授权、免费开房账本。
 *
 * 一致性规则（docs/rebuild/05-OPERATIONS.md §4）：
 *  - 免费可开房数 = total(10) − consumed − reserved；CHECK 保证非负
 *  - 流水与计数同事务提交；(room_id, action) 唯一保证每个动作每房只发生一次
 *  - 赞助授权与开房统一锁 sponsor_accounts；行锁内先查赞助再扣免费次数
 *  - 财务数据禁止级联删除（全部 references 不带 onDelete: cascade）
 */
import { sql } from 'drizzle-orm';
import {
  check,
  pgEnum,
  pgTable,
  text,
  uuid,
  integer,
  boolean,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { user } from './auth';
import { rooms } from './rooms';

// ---------- 枚举 ----------

export const sponsorProductTypeEnum = pgEnum('sponsor_product_type', ['monthly', 'lifetime']);

export const orderStatusEnum = pgEnum('order_status', [
  'pending',
  'paid',
  'closing',
  'closed',
  'refund_pending',
  'refunded',
]);

export const orderChannelEnum = pgEnum('order_channel', ['wechat_native', 'test']);

export const refundStatusEnum = pgEnum('refund_status', ['pending', 'refunded', 'failed', 'cancelled']);

export const grantTypeEnum = pgEnum('grant_type', ['monthly', 'lifetime', 'test']);

export const grantStatusEnum = pgEnum('grant_status', ['active', 'frozen', 'revoked']);

export const entitlementSourceEnum = pgEnum('entitlement_source', ['free', 'sponsorship', 'test']);

export const entitlementStatusEnum = pgEnum('entitlement_status', [
  'reserved',
  'consumed',
  'released',
  'refunded',
]);

export const creditActionEnum = pgEnum('credit_action', ['reserve', 'consume', 'release', 'refund']);

export const sponsorLedgerActionEnum = pgEnum('sponsor_ledger_action', [
  'grant',
  'freeze',
  'revoke',
  'extend',
  'restore',
]);

// ---------- 商品与订单 ----------

export const sponsorProducts = pgTable('sponsor_products', {
  id: uuid('id').primaryKey().defaultRandom(),
  type: sponsorProductTypeEnum('type').notNull(),
  available: boolean('available').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

/** 商品版本：已售出的版本不可变；改价产生新版本，旧订单不受影响。 */
export const productVersions = pgTable(
  'product_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: uuid('product_id')
      .notNull()
      .references(() => sponsorProducts.id),
    versionNo: integer('version_no').notNull(),
    /** 最小货币单位（分）：首发 600 / 2000 */
    priceMinor: integer('price_minor').notNull(),
    currency: text('currency').notNull().default('CNY'),
    title: text('title').notNull(),
    available: boolean('available').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('product_versions_product_no_uq').on(t.productId, t.versionNo)],
);

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id),
    productVersionId: uuid('product_version_id')
      .notNull()
      .references(() => productVersions.id),
    /** 下单时冻结的商品快照，后台改价不影响旧订单 */
    productSnapshot: jsonb('product_snapshot').$type<Record<string, unknown>>().notNull(),
    amountMinor: integer('amount_minor').notNull(),
    currency: text('currency').notNull(),
    channel: orderChannelEnum('channel').notNull(),
    status: orderStatusEnum('status').notNull().default('pending'),
    /** 渠道商户单号：重试沿用同一单号，避免重复收费 */
    merchantOrderNo: text('merchant_order_no').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    paidAt: timestamp('paid_at', { withTimezone: true, mode: 'date' }),
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('orders_merchant_no_uq').on(t.merchantOrderNo),
    index('orders_user_idx').on(t.userId),
    index('orders_status_idx').on(t.status),
  ],
);

export const paymentTransactions = pgTable(
  'payment_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    channel: orderChannelEnum('channel').notNull(),
    /** 渠道交易号；(channel, transaction_id) 唯一防重复入账 */
    transactionId: text('transaction_id').notNull(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id),
    amountMinor: integer('amount_minor').notNull(),
    currency: text('currency').notNull(),
    success: boolean('success').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('payment_transactions_uq').on(t.channel, t.transactionId)],
);

export const paymentNotifications = pgTable(
  'payment_notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    channel: orderChannelEnum('channel').notNull(),
    notificationId: text('notification_id').notNull(),
    orderId: uuid('order_id').references(() => orders.id),
    /** 只存摘要与验签结果，敏感原文加密限期保存 */
    payloadDigest: text('payload_digest').notNull(),
    verifyResult: text('verify_result').notNull(),
    handleResult: text('handle_result').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('payment_notifications_uq').on(t.channel, t.notificationId)],
);

// ---------- 赞助授权 ----------

/** 赞助账户：所有授权变动与开房检查统一在这行上加锁。 */
export const sponsorAccounts = pgTable('sponsor_accounts', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id),
  /** 月度锚点：首次生效的日/时/分/秒；下月无对应日取月末 */
  monthlyAnchor: timestamp('monthly_anchor', { withTimezone: true, mode: 'date' }),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export const sponsorGrants = pgTable(
  'sponsor_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id),
    /** test 授权无订单；正式授权按订单唯一 */
    orderId: uuid('order_id').references(() => orders.id),
    type: grantTypeEnum('type').notNull(),
    status: grantStatusEnum('status').notNull().default('active'),
    effectiveFrom: timestamp('effective_from', { withTimezone: true, mode: 'date' }).notNull(),
    /** null = 永久 */
    effectiveUntil: timestamp('effective_until', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('sponsor_grants_order_uq')
      .on(t.orderId)
      .where(sql`order_id is not null`),
    index('sponsor_grants_user_idx').on(t.userId),
  ],
);

/** 赞助流水：每笔授权变动一条；业务动作幂等键唯一。 */
export const sponsorLedger = pgTable(
  'sponsor_ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id),
    action: sponsorLedgerActionEnum('action').notNull(),
    grantId: uuid('grant_id').references(() => sponsorGrants.id),
    orderId: uuid('order_id').references(() => orders.id),
    /** 事故/房间补偿引用 */
    incidentId: text('incident_id'),
    roomId: uuid('room_id').references(() => rooms.id),
    detail: jsonb('detail').$type<Record<string, unknown>>(),
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('sponsor_ledger_idempotency_uq').on(t.idempotencyKey),
    index('sponsor_ledger_user_idx').on(t.userId),
  ],
);

// ---------- 免费开房账本 ----------

/** 免费次数账户：total 固定 10；CHECK 保证 consumed/reserved 非负且合计 ≤ total。 */
export const freeRoomAccounts = pgTable(
  'free_room_accounts',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => user.id),
    total: integer('total').notNull().default(10),
    consumed: integer('consumed').notNull().default(0),
    reserved: integer('reserved').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('free_room_accounts_user_uq').on(t.userId),
    // 负余额在数据库层不可能出现
    check('free_room_accounts_non_negative', sql`consumed >= 0 and reserved >= 0 and consumed + reserved <= total`),
  ],
);

// ---------- 开房授权 ----------

/** 房间的开房授权：一个房间一条，记录来源与状态迁移。 */
export const roomEntitlements = pgTable(
  'room_entitlements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id),
    creatorUserId: text('creator_user_id')
      .notNull()
      .references(() => user.id),
    source: entitlementSourceEnum('source').notNull(),
    sponsorGrantId: uuid('sponsor_grant_id').references(() => sponsorGrants.id),
    status: entitlementStatusEnum('status').notNull().default('reserved'),
    /** 房间首次有效判定事务里写入 */
    consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('room_entitlements_room_uq').on(t.roomId),
    index('room_entitlements_creator_idx').on(t.creatorUserId),
  ],
);

/** 免费次数流水：(room_id, action) 唯一——预留/消费/释放/退回每房每动作最多一次。 */
export const roomCreditLedger = pgTable(
  'room_credit_ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id),
    userId: text('user_id')
      .notNull()
      .references(() => user.id),
    action: creditActionEnum('action').notNull(),
    amount: integer('amount').notNull().default(1),
    relatedId: text('related_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('room_credit_ledger_room_action_uq').on(t.roomId, t.action),
    index('room_credit_ledger_user_idx').on(t.userId),
  ],
);

// ---------- 退款 ----------

export const refunds = pgTable(
  'refunds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id),
    refundNo: text('refund_no').notNull(),
    amountMinor: integer('amount_minor').notNull(),
    reason: text('reason').notNull(),
    status: refundStatusEnum('status').notNull().default('pending'),
    /** 权益处理：frozen=冻结中 revoked=已撤销 kept=保留原有效期 */
    entitlementStatus: text('entitlement_status').notNull().default('frozen'),
    requestedBy: text('requested_by').references(() => user.id),
    approvedBy: text('approved_by').references(() => user.id),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('refunds_no_uq').on(t.refundNo),
    index('refunds_order_idx').on(t.orderId),
    index('refunds_status_idx').on(t.status),
  ],
);
