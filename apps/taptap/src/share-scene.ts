/** 分享场景的真实载荷：房间邀请、会客厅邀请和好友奖励共用冷 / 热启动解析。 */
import { z } from 'zod';
import { inviteClaimRequestSchema, inviteClaimResponseSchema } from '@jev/contracts';
import type { api } from './api.js';

export const shareSceneSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.enum(['room', 'lobby']), token: z.string().regex(/^[a-f0-9]{8,}$/i) }),
  z.object({ kind: z.literal('referral'), code: inviteClaimRequestSchema.shape.code }),
]);
export type ShareScene = z.infer<typeof shareSceneSchema>;

export function parseShareScene(options: { query?: Record<string, string> }): ShareScene | null {
  const raw = options.query?.sceneParam;
  return raw ? shareSceneSchema.parse(JSON.parse(raw)) : null;
}

/** 客户端只提交邀请码；奖励归属、次数和重复领取全部由现有服务端判定。 */
export function claimReferral(send: typeof api, code: string) {
  return send('/invites/claim', { body: inviteClaimRequestSchema.parse({ code }) }, inviteClaimResponseSchema);
}
