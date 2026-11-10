/** 原生创作的保存流程：沿用已保存作品编号和版本条件，后续重试更新同一作品。 */
import { creationDetailSchema, creationDraftSchema, type CreationDetail, type CreationDraft } from '@jev/contracts';
import { z } from 'zod';
import type { api } from './api.js';

export type CreationBase = Pick<CreationDetail, 'puzzleId' | 'versionId' | 'updatedAt'>;

/** 本地正文保存时一并记录编辑基线，重进页面仍用原版本条件提交。 */
export const localCreationSchema = z.object({
  draft: creationDraftSchema.extend({ title: z.string(), sourceUrl: z.string(),
    authorDisplay: z.discriminatedUnion('mode', [z.object({ mode: z.literal('anonymous') }), z.object({ mode: z.literal('signature'), name: z.string() })]),
  }),
  base: z.object({ puzzleId: z.uuid(), versionId: z.uuid(), updatedAt: z.iso.datetime() }).optional(),
});

export async function persistCreation(send: typeof api, draft: CreationDraft, previous?: CreationBase): Promise<CreationDetail> {
  const parsed = creationDraftSchema.parse(draft);
  let puzzleId = previous?.puzzleId;
  if (previous) {
    await send(`/creations/${previous.puzzleId}`, { method: 'PATCH', body: { ...parsed, expectedVersionId: previous.versionId, expectedUpdatedAt: previous.updatedAt } });
  } else {
    puzzleId = (await send('/creations', { body: parsed }, z.object({ puzzleId: z.uuid() }))).puzzleId;
  }
  if (!puzzleId) throw new Error('作品保存没有返回编号');
  return send(`/creations/${puzzleId}`, {}, creationDetailSchema);
}

/** 状态变更后立即读取权威详情，后续操作使用新的版本号和更新时间。 */
export async function transitionCreation(send: typeof api, previous: CreationBase, action: 'submit' | 'withdraw' | 'revise'): Promise<CreationDetail> {
  await send(`/creations/${previous.puzzleId}/${action}`, { body: { expectedVersionId: previous.versionId, expectedUpdatedAt: previous.updatedAt } });
  return send(`/creations/${previous.puzzleId}`, {}, creationDetailSchema);
}

/** 署名改动也会改变版本条件；返回详情区分已生效的名字与待审核名字。 */
export async function updateCreationAuthor(send: typeof api, puzzleId: string, display: CreationDraft['authorDisplay']): Promise<CreationDetail> {
  await send(`/creations/${puzzleId}/author-display`, { method: 'PATCH', body: creationDraftSchema.shape.authorDisplay.parse(display) });
  return send(`/creations/${puzzleId}`, {}, creationDetailSchema);
}
