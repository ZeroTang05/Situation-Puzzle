/** 管理端登录态：复用玩家会话，服务端按角色校验（docs/rebuild/05-OPERATIONS.md §8）。 */
import type { AuthProvider } from 'react-admin';

export const authProvider: AuthProvider = {
  async login() {
    // 登录走主站 /login（邮箱验证码 / Google），后台只消费会话
    window.location.href = '/login?next=/admin';
    return undefined;
  },
  async logout() {
    await fetch('/api/v1/auth/sign-out', { method: 'POST', credentials: 'include' });
    return undefined;
  },
  async checkAuth() {
    const response = await fetch('/api/v1/me', { credentials: 'include' });
    if (!response.ok) throw new Error('未登录');
    const payload = (await response.json()) as { data?: { roles?: string[] } };
    const roles = payload.data?.roles ?? [];
    if (roles.length === 0) throw new Error('没有后台权限');
    return undefined;
  },
  async checkError(error) {
    if (error?.message === '未登录') throw error;
    return undefined;
  },
  async getIdentity() {
    const response = await fetch('/api/v1/me', { credentials: 'include' });
    const payload = (await response.json()) as { data?: { nickname?: string; userId?: string } };
    return { id: payload.data?.userId ?? '', fullName: payload.data?.nickname ?? '' };
  },
  async getPermissions() {
    const response = await fetch('/api/v1/me', { credentials: 'include' });
    const payload = (await response.json()) as { data?: { roles?: string[] } };
    return payload.data?.roles ?? [];
  },
};
