import { timingSafeEqual } from 'node:crypto';

/** 管理员账号固定为 admin，密码由服务端 ADMIN_TOKEN 提供。 */
export function isAdminAuthorized(request: Request): boolean {
  const secret = process.env.ADMIN_TOKEN;
  if (!secret) throw new Error('缺少 ADMIN_TOKEN，管理员后台已停止提供服务');
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Basic ')) return false;

  const credentials = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
  const separator = credentials.indexOf(':');
  if (separator < 0 || credentials.slice(0, separator) !== 'admin') return false;
  const password = Buffer.from(credentials.slice(separator + 1));
  const expected = Buffer.from(secret);
  return password.length === expected.length && timingSafeEqual(password, expected);
}

/** 401 和 WWW-Authenticate 会让浏览器在页面加载前显示原生账号密码框。 */
export function adminChallenge(): Response {
  return new Response('需要管理员账号和密码', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Jev Admin", charset="UTF-8"',
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=UTF-8',
    },
  });
}
