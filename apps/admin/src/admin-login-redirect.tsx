/** admin 默认 LoginPage 替换：直接跳到 web 端共用登录入口。
 *  不显示任何 React-Admin 默认的 Username/Password 输入框——admin 复用
 *  玩家端的 EmailOTP / Password / Google 三种登录入口，登录后由 next=/admin
 *  回到本页。
 */
import { useEffect } from 'react';

export function AdminLoginRedirect() {
  useEffect(() => {
    // 直接读 ?next= 参数，无 next 则默认回到 /admin
    const search = typeof window !== 'undefined' ? window.location.search : '';
    const params = new URLSearchParams(search);
    const next = params.get('next') ?? '/admin';
    window.location.href = `/login?next=${encodeURIComponent(next)}`;
  }, []);
  return null;
}
