import { adminChallenge, isAdminAuthorized } from '../../../lib/admin-auth';
import { apiBaseUrl } from '../../../lib/api-url';

/** 同源转发审核请求，管理员密码只由 Next.js 服务端发送给 Worker。 */
export async function adminWorkerRequest(request: Request, path: string): Promise<Response> {
  if (!isAdminAuthorized(request)) return adminChallenge();
  const base = apiBaseUrl(process.env.NEXT_PUBLIC_API_URL);
  const secret = process.env.ADMIN_TOKEN;
  if (!base || !secret) throw new Error('管理员后台缺少 Worker 地址或 ADMIN_TOKEN');
  const source = new URL(request.url);
  const target = new URL(`/api/admin/${path}${source.search}`, base);
  const response = await fetch(target, {
    method: request.method,
    headers: {
      Authorization: `Basic ${Buffer.from(`admin:${secret}`).toString('base64')}`,
      ...(request.method === 'PATCH' ? { 'Content-Type': 'application/json' } : {}),
    },
    body: request.method === 'PATCH' ? await request.text() : undefined,
    cache: 'no-store',
  });
  return new Response(response.body, {
    status: response.status,
    headers: { 'Content-Type': response.headers.get('Content-Type') ?? 'application/json', 'Cache-Control': 'no-store' },
  });
}
