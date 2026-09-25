/**
 * 内容域：用户档案、题库作品与版本、商业授权、投稿审核、举报与评价。
 *
 * 题目内容发布后不可变（puzzle_versions 提交后不再修改）；修改产生新版本，
 * 进行中的游戏固定使用开局时的版本。未通过权利审核的内容不得进入公开题库。
 */
import {
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
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { user } from './auth';

// ---------- 枚举 ----------

export const profileStatusEnum = pgEnum('profile_status', ['active', 'suspended', 'deletion_pending']);

export const staffRoleEnum = pgEnum('staff_role', ['admin', 'moderator', 'support', 'finance']);

export const puzzleSourceEnum = pgEnum('puzzle_source', ['official', 'community', 'imported']);

export const moderationStatusEnum = pgEnum('moderation_status', [
  'draft',
  'submitted',
  'checking',
  'pending_review',
  'published',
  'changes_requested',
  'taken_down',
]);

export const rightsStatusEnum = pgEnum('rights_status', ['pending', 'approved', 'rejected']);

export const reportObjectEnum = pgEnum('report_object', ['turn', 'puzzle', 'room', 'discussion', 'user']);

export const reportStatusEnum = pgEnum('report_status', ['open', 'processing', 'resolved', 'rejected']);

export const ratingValueEnum = pgEnum('rating_value', ['good', 'hard', 'bad']);

// ---------- 身份扩展 ----------

/** 业务档案：与 Better Auth 的 user 一对一；单人游玩完全不经过这里。 */
export const profiles = pgTable('profiles', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  nickname: text('nickname').notNull(),
  status: profileStatusEnum('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

/** 后台角色：普通玩家没有任何行；权限在 API 服务端逐项校验。 */
export const roleAssignments = pgTable(
  'role_assignments',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: staffRoleEnum('role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [index('role_assignments_role_idx').on(t.role)],
);

// ---------- 题库 ----------

/** 作品：逻辑上的「一道题」，当前发布版本指针指到某个已发布版本。 */
export const puzzles = pgTable(
  'puzzles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    authorUserId: text('author_user_id').references(() => user.id),
    /** official=平台内容 community=玩家投稿 imported=旧库迁移 */
    source: puzzleSourceEnum('source').notNull(),
    /** 旧系统/导入来源里的稳定 ID（如 seed-classic-albatross），用于幂等导入与旧分享链接兼容 */
    legacyId: text('legacy_id'),
    currentPublishedVersionId: uuid('current_published_version_id').references(
      (): AnyPgColumn => puzzleVersions.id,
    ),
    /** 紧急停用： true 时任何接口不得返回内容或开局 */
    unavailable: boolean('unavailable').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('puzzles_source_legacy_uq').on(t.source, t.legacyId),
    index('puzzles_author_idx').on(t.authorUserId),
  ],
);

/** 版本：不可变的内容单元；同一作品的中文/英文是不同语言行。 */
export const puzzleVersions = pgTable(
  'puzzle_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    puzzleId: uuid('puzzle_id')
      .notNull()
      .references(() => puzzles.id, { onDelete: 'cascade' }),
    versionNo: integer('version_no').notNull(),
    language: text('language').notNull(),
    title: text('title').notNull(),
    /** 汤面（公开） */
    surface: text('surface').notNull(),
    /** 汤底：只有揭晓/破解/作者/审核权限可读 */
    answer: text('answer').notNull(),
    /** 三条递进提示 */
    hints: jsonb('hints').$type<string[]>().notNull(),
    /** 核心事实清单（评测与审核共用） */
    coreFacts: jsonb('core_facts').$type<string[]>().notNull().default([]),
    /** 因果链描述 */
    causalChain: text('causal_chain'),
    difficulty: text('difficulty'),
    durationMinutes: integer('duration_minutes'),
    contentWarnings: jsonb('content_warnings').$type<string[]>().notNull().default([]),
    moderationStatus: moderationStatusEnum('moderation_status').notNull().default('draft'),
    /** 导入内容散列：幂等键的一部分，内容变了视为新版本 */
    sourceHash: text('source_hash'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('puzzle_versions_uq').on(t.puzzleId, t.versionNo, t.language),
    index('puzzle_versions_status_idx').on(t.moderationStatus),
  ],
);

/** 商业授权：pending 的内容不能发布为可收费题库（首发全部人工批准）。 */
export const puzzleRights = pgTable(
  'puzzle_rights',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    puzzleId: uuid('puzzle_id')
      .notNull()
      .references(() => puzzles.id, { onDelete: 'cascade' }),
    status: rightsStatusEnum('status').notNull().default('pending'),
    sourceUrl: text('source_url'),
    /** 授权依据说明（原创声明 / 授权链接 / 平台自有） */
    licenseBasis: text('license_basis').notNull(),
    /** 作者同意的授权文本版本与时间 */
    agreementVersion: text('agreement_version').notNull(),
    agreedAt: timestamp('agreed_at', { withTimezone: true, mode: 'date' }),
    confirmedBy: text('confirmed_by').references(() => user.id),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [index('puzzle_rights_puzzle_idx').on(t.puzzleId)],
);

/** 标准测试用例：Jev 评测与人工审核共用同一批预期。 */
export const puzzleTestCases = pgTable(
  'puzzle_test_cases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    versionId: uuid('version_id')
      .notNull()
      .references(() => puzzleVersions.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    input: text('input').notNull(),
    expected: text('expected').notNull(),
    reason: text('reason'),
    /** critical=明确事实用例，参与 ≥95% 准确率门槛 */
    criticality: text('criticality').notNull().default('normal'),
    confirmedBy: text('confirmed_by').references(() => user.id),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [index('puzzle_test_cases_version_idx').on(t.versionId)],
);

/** 审核记录：机器与人工每一步结论都留痕，迟到审核不能发布新内容。 */
export const moderationReviews = pgTable(
  'moderation_reviews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    versionId: uuid('version_id')
      .notNull()
      .references(() => puzzleVersions.id, { onDelete: 'cascade' }),
    stage: text('stage').notNull(),
    conclusion: text('conclusion').notNull(),
    reason: text('reason'),
    operatorUserId: text('operator_user_id').references(() => user.id),
    modelVersion: text('model_version'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [index('moderation_reviews_version_idx').on(t.versionId)],
);

// ---------- 治理 ----------

/** 举报：对象类型 + ID，处理状态留痕。 */
export const reports = pgTable(
  'reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reporterUserId: text('reporter_user_id')
      .notNull()
      .references(() => user.id),
    objectType: reportObjectEnum('object_type').notNull(),
    objectId: uuid('object_id').notNull(),
    reason: text('reason').notNull(),
    detail: text('detail'),
    status: reportStatusEnum('status').notNull().default('open'),
    resolution: text('resolution'),
    handledBy: text('handled_by').references(() => user.id),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [index('reports_object_idx').on(t.objectType, t.objectId), index('reports_status_idx').on(t.status)],
);

/** 题目评价：每用户每题一条，可修改；需满足参与条件（服务端校验）。 */
export const ratings = pgTable(
  'ratings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id),
    puzzleId: uuid('puzzle_id')
      .notNull()
      .references(() => puzzles.id, { onDelete: 'cascade' }),
    value: ratingValueEnum('value').notNull(),
    review: text('review'),
    /** 关联的参与局：证明评价资格 */
    roundId: uuid('round_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('ratings_user_puzzle_uq').on(t.userId, t.puzzleId)],
);

/** 审计日志：追加写，任何后台操作都留痕，禁止级联删除。 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    operatorUserId: text('operator_user_id').references(() => user.id),
    action: text('action').notNull(),
    objectType: text('object_type').notNull(),
    objectId: text('object_id'),
    reason: text('reason'),
    beforeSummary: jsonb('before_summary').$type<Record<string, unknown>>(),
    afterSummary: jsonb('after_summary').$type<Record<string, unknown>>(),
    relatedRequestId: text('related_request_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_logs_object_idx').on(t.objectType, t.objectId),
    index('audit_logs_created_idx').on(t.createdAt),
  ],
);

/** 导入幂等性校验用的常量（避免循环依赖 domain）：source 标记 */
/** 旧库导入内容的来源标记（与 puzzleSourceEnum.imported 一致） */
export const IMPORT_SOURCE = 'imported' as const;
