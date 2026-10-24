/** App OAuth 登录事务：校验值只保留在本机，授权链接携带其 SHA-256 摘要。 */
const PENDING_KEY = 'jev.app-oauth-pending';
interface PendingAppOAuth {
  verifier: string;
  challenge: string;
  next: string;
  expiresAt: number;
}

/** 用标准 Web Crypto 生成 SHA-256 校验摘要，输出无填充的 base64url。 */
async function challengeOf(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** 发起本机登录；保留十分钟，允许系统浏览器授权期间 App 被系统回收。 */
export async function beginAppOAuth(next: string): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  const challenge = await challengeOf(verifier);
  localStorage.setItem(PENDING_KEY, JSON.stringify({ verifier, challenge, next, expiresAt: Date.now() + 600_000 }));
  return challenge;
}

/** 只接收本机发起且绑定匹配的回流；异步兑换前消费，重复事件无法再次安装身份。 */
export function consumeAppOAuthCallback(rawUrl: string): { code: string | null; verifier: string; next: string } | null {
  const url = URL.parse(rawUrl);
  if (!url || url.protocol !== 'cn.xiaobaozi.sp:' || url.host !== '' || url.pathname !== '/oauth') return null;
  const raw = localStorage.getItem(PENDING_KEY);
  if (!raw) return null;
  const pending = JSON.parse(raw) as PendingAppOAuth;
  if (pending.expiresAt <= Date.now()) { localStorage.removeItem(PENDING_KEY); return null; }
  if (url.searchParams.get('state') !== pending.challenge) return null;
  localStorage.removeItem(PENDING_KEY);
  return { code: url.searchParams.get('code'), verifier: pending.verifier, next: pending.next };
}
