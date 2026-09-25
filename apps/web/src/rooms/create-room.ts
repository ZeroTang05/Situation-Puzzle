/** 开房动作：创建房间并把邀请令牌存本地（邀请令牌明文只返回一次）。 */
import { api } from '../api/client.js';

export async function createRoom(): Promise<{ roomId: string; inviteToken: string | null; existing: boolean }> {
  const result = await api<{ roomId: string; inviteToken: string | null; existing: boolean }>('/rooms', {
    method: 'POST',
    body: { capacity: 8 },
  });
  if (result.inviteToken) {
    localStorage.setItem(`jev.invite.${result.roomId}`, result.inviteToken);
  }
  return result;
}
