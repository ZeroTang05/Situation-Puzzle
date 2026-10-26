/**
 * 邀请链接自动领取：`/?ref=CODE` 进站时把邀请码存本地，登录后静默领取。
 *
 * 奖励发给邀请人（+5 次开房次数），被邀请人没有直接所得，所以领取结果
 * 不弹提示、不打扰；成功与失败都清掉本地值，避免每次进站反复请求。
 * 服务端幂等键 invite-claim:<userId> 保证重复调用不会多发。
 */
import { useEffect } from 'react';
import { api } from '../api/client.js';
import type { Session } from '../session.js';

const REF_KEY = 'jev.inviteRef';
/** 与 @jev/domain INVITE_CODE_PATTERN 同步：8 位、去易混字符的大写表 */
const REF_PATTERN = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/;

export function useInviteRefClaim(session: Session | null): void {
  // 任何页面带 ?ref= 进站：存下邀请码并从 URL 清掉（不污染刷新与分享）
  useEffect(() => {
    const url = new URL(window.location.href);
    const ref = url.searchParams.get('ref');
    if (!ref || !REF_PATTERN.test(ref)) return;
    localStorage.setItem(REF_KEY, ref);
    url.searchParams.delete('ref');
    window.history.replaceState(null, '', url.toString());
  }, []);

  // 登录后领取一次；登出再登进另一个号时，另一个号没有存值不会误领
  useEffect(() => {
    if (!session) return;
    const ref = localStorage.getItem(REF_KEY);
    if (!ref) return;
    localStorage.removeItem(REF_KEY);
    void api('/invites/claim', { method: 'POST', body: { code: ref } }).catch((err: unknown) => {
      console.warn('[invite] 领取邀请奖励失败', err);
    });
  }, [session]);
}
