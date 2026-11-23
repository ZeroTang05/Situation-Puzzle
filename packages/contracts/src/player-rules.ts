/** 跨端玩家交互约定：选题与评价时机，保持网页和原生小游戏一致。 */
import type { MeResponse } from './http.js';

/** 资料优先展示平台 OpenID。旧接口没有平台字段时，已有的站内用户 ID 可直接展示。 */
export function profileIdentityRows(profile: MeResponse) {
  const rows: Array<{ label: 'emailField' | 'taptapIdLabel' | 'wechatIdLabel' | 'userIdLabel'; value: string }> = [];
  const email = profile.identity?.email ?? (profile.email.endsWith('.invalid') ? null : profile.email);
  if (email) rows.push({ label: 'emailField', value: email });
  for (const { provider, openId } of profile.identity?.platformAccounts ?? []) {
    rows.push({ label: provider === 'taptap-mini' ? 'taptapIdLabel' : 'wechatIdLabel', value: openId });
  }
  if (!rows.length) {
    if (profile.userId) rows.push({ label: 'userIdLabel', value: profile.userId });
    else if (profile.email) rows.push({ label: 'emailField', value: profile.email });
  }
  return rows;
}

/** 按作品编号排除全部已玩题目，切换语言也不重复抽取同一作品。 */
export function selectUnplayedPuzzle(puzzleIds: readonly string[], playedIds: readonly string[], currentId: string, sample = Math.random()): string | null {
  const excluded = new Set([...playedIds, currentId]);
  const candidates = [...new Set(puzzleIds)].filter((id) => !excluded.has(id));
  if (candidates.length === 0) return null;
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) throw new RangeError('随机数必须位于 [0, 1)');
  return candidates[Math.floor(sample * candidates.length)]!;
}

/** 完成一次有效还原请求或看到汤底后，才能评价单人题目。 */
export function canRateSoloPuzzle(revealedAnswer: string | null, turns: ReadonlyArray<{ kind: string; status: string }>): boolean {
  return Boolean(revealedAnswer) || turns.some((turn) => turn.kind === 'solve' && turn.status === 'succeeded');
}

/** 多人局只在破解或公布答案后展示评价，主动停止的局不开放。 */
export function canRateRoomPuzzle(roundStatus: string): boolean { return roundStatus === 'solved' || roundStatus === 'revealed'; }
