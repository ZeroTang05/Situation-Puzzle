/** 作者私有作品契约；这些完整内容仅可经作者或审核员权限接口读取。 */
import { z } from 'zod';
import { difficultySchema, puzzleCategorySchema } from './http.js';

export const creationStatusSchema = z.enum(['draft', 'submitted', 'checking', 'pending_review', 'published', 'changes_requested', 'taken_down']);
export const creationOriginSchema = z.enum(['original', 'repost']);

export const creationTestCaseSchema = z.object({
  kind: z.enum(['ask', 'solve']),
  input: z.string().trim().min(1).max(1500),
  expected: z.enum(['yes', 'no', 'irrelevant', 'uncertain', 'solved', 'close', 'not_yet']),
  reason: z.string().max(500).default(''),
  criticality: z.enum(['normal', 'critical']).default('normal'),
}).superRefine((value, context) => {
  const options = value.kind === 'ask' ? ['yes', 'no', 'irrelevant', 'uncertain'] : ['solved', 'close', 'not_yet', 'uncertain'];
  if (!options.includes(value.expected)) context.addIssue({ code: 'custom', path: ['expected'], message: '预期判定与问题类型不符' });
  if (value.kind === 'ask' && value.input.length > 500) context.addIssue({ code: 'custom', path: ['input'], message: '提问最多 500 字' });
});

/** 草稿可分次填写，正式提交时另行检查完整性。 */
export const creationDraftSchema = z.object({
  title: z.string().trim().min(1).max(60),
  surface: z.string().max(2000),
  answer: z.string().max(4000),
  hints: z.array(z.string().max(500)).max(3),
  language: z.enum(['zh', 'en']),
  difficulty: difficultySchema,
  category: puzzleCategorySchema,
  origin: creationOriginSchema,
  sourceUrl: z.union([z.literal(''), z.url().refine((url) => ['http:', 'https:'].includes(new URL(url).protocol))]),
  authorDisplay: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('anonymous') }),
    z.object({ mode: z.literal('signature'), name: z.string().trim().min(1).max(30) }),
  ]),
});

export const creationCompleteSchema = creationDraftSchema.extend({
  surface: z.string().trim().min(1).max(2000),
  answer: z.string().trim().min(1).max(4000),
  // 提示 1 必须填；2-3 可选；空白条目由前端在保存前过滤，不入库。
  hints: z.array(z.string().max(500)).min(1).max(3).refine((items) => items[0]?.trim().length ?? 0 > 0, { message: '第 1 条提示不能为空' }),
}).superRefine((draft, context) => {
  if (draft.origin === 'repost' && !draft.sourceUrl) context.addIssue({ code: 'custom', path: ['sourceUrl'], message: '转载作品请填写原作者链接' });
});

export const creationVersionConditionSchema = z.object({ expectedVersionId: z.uuid(), expectedUpdatedAt: z.iso.datetime() });
export const creationSaveRequestSchema = creationDraftSchema.extend(creationVersionConditionSchema.shape);
export const creationSubmitRequestSchema = creationVersionConditionSchema;
export const creationRevisionRequestSchema = creationVersionConditionSchema;

export const creationSummarySchema = z.object({
  puzzleId: z.uuid(), versionId: z.uuid(), versionNo: z.number().int(), title: z.string(), language: z.enum(['zh', 'en']),
  status: creationStatusSchema, updatedAt: z.string(), published: z.boolean(), publishedLanguage: z.enum(['zh', 'en']).nullable(),
  upCount: z.number(), downCount: z.number(), popularityScore: z.number(),
  authorDisplay: z.object({ mode: z.enum(['anonymous', 'signature']), name: z.string().nullable() }), pendingName: z.string().nullable(),
});
export const creationDetailSchema = z.object({
  puzzleId: z.uuid(), versionId: z.uuid(), versionNo: z.number().int(), status: creationStatusSchema, updatedAt: z.string(),
  draft: creationDraftSchema,
  authorDisplay: z.object({ mode: z.enum(['anonymous', 'signature']), name: z.string().nullable(), pendingName: z.string().nullable() }),
  reviews: z.array(z.object({ versionId: z.uuid(), stage: z.string(), conclusion: z.string(), reason: z.string().nullable(), createdAt: z.string() })),
  versions: z.array(z.object({ versionId: z.uuid(), versionNo: z.number().int(), language: z.enum(['zh', 'en']), status: creationStatusSchema })),
});
export const creationPreviewSchema = z.object({ token: z.string(), versionId: z.uuid(), language: z.enum(['zh', 'en']), title: z.string(), surface: z.string(), hintsTotal: z.number().int(), configVersion: z.string(), contentHash: z.string() });

export type CreationDraft = z.infer<typeof creationDraftSchema>;
export type CreationDetail = z.infer<typeof creationDetailSchema>;
export type CreationSummary = z.infer<typeof creationSummarySchema>;
export type CreationPreview = z.infer<typeof creationPreviewSchema>;
