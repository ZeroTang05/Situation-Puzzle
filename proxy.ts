import { NextResponse, type NextRequest } from 'next/server';
import { adminChallenge, isAdminAuthorized } from './lib/admin-auth';

/** 在 /admin 页面和其接口返回内容前完成浏览器原生密码验证。 */
export function proxy(request: NextRequest) {
  if (!isAdminAuthorized(request)) return adminChallenge();
  return NextResponse.next();
}

export const config = { matcher: '/admin/:path*' };
