/** 需要登录的路由统一记住当前地址，认证结束后恢复原入口。 */
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import type { Session } from '../session.js';
import { loginHref } from './login-navigation.js';

export function RequireSession({ session, children }: { session: Session | null; children: ReactNode }) {
  const location = useLocation();
  return session ? children : <Navigate to={loginHref(location)} replace />;
}
