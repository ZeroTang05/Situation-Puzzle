/** 登录来源地址：保留站内路径、查询参数和页面锚点。 */
export interface LoginSource {
  pathname: string;
  search: string;
  hash: string;
}

/** 将完整来源链接放进 next 参数，避免链接自身的参数被拆开。 */
export function loginHref(source: LoginSource): string {
  const params = new URLSearchParams({ next: source.pathname + source.search + source.hash });
  return `/login?${params}`;
}

/** 登录只返回本站；缺少来源时回首页。 */
export function loginDestination(next: string | null, origin: string): string {
  const destination = new URL(next ?? '/', origin);
  if (destination.origin !== origin) throw new Error('登录返回地址必须属于当前网站');
  return destination.href;
}

/** 找回密码与重置密码继续携带同一份来源地址。 */
export function authStepHref(path: string, next: string | null): string {
  const url = new URL(path, 'https://auth.local');
  if (next !== null) url.searchParams.set('next', next);
  return url.pathname + url.search + url.hash;
}
