/**
 * OAuth 出站中继（docs/rebuild/05-OPERATIONS.md §2）。
 *
 * 服务器在境内时无法直连 Google 的 *.googleapis.com；connect.linux.do 的
 * token 兑换与 userinfo 也按同一中继约定转发（参考 GoWith 的对接）。
 * 这些请求都发生在服务端，配置 GOOGLE_OAUTH_PROXY_BASE_URL + 共享密钥后，
 * 本模块在启动时包一层全局 fetch，按下面的白名单改写到内部 oauth-relay
 * （Deno Deploy，源码仓库 oauth-relay/）：
 *
 * - POST https://oauth2.googleapis.com/token              → <中继>/oauth/google/token
 * - GET  https://openidconnect.googleapis.com/v1/userinfo → <中继>/oauth/google/userinfo
 * - POST https://connect.linux.do/oauth2/token            → <中继>/oauth/linuxdo/token
 * - GET  https://connect.linux.do/api/user                → <中继>/oauth/linuxdo/userinfo
 *
 * LINUX DO 的 authorize 在同一 host 上，但它发生在用户浏览器侧，不匹配
 * 白名单路径、不经中继。每个改写后的请求带 `X-Relay-Token: <共享密钥>`
 * （中继端常数时间比对，缺失或不匹配返回 401）。表单 body 与 Authorization
 * 头（LINUX DO 的 Basic 凭据）由中继原样透传。
 *
 * 注意：中继按路径白名单转发，没有 JWKS 路由。当前登录流程用授权码模式，
 * better-auth 本地解码 idToken 不验签，因此不拉 JWKS；若将来启用 one-tap
 * id-token 登录，需先给中继增加 JWKS 路由。
 */

/** 原始端点 host → 中继路径（oauth-relay 的 UPSTREAM_TABLE 白名单形状） */
const HOST_RELAY_PATHS: ReadonlyMap<string, string> = new Map([
  ['oauth2.googleapis.com', '/oauth/google/token'],
  ['openidconnect.googleapis.com', '/oauth/google/userinfo'],
]);

/**
 * LINUX DO 的 authorize 与 token/userinfo 同在 connect.linux.do，
 * 只按路径改写服务端发起的 token 兑换与 userinfo，authorize 保持直连
 */
const LINUXDO_HOST = 'connect.linux.do';
const LINUXDO_PATH_RELAY_PATHS: ReadonlyMap<string, string> = new Map([
  ['/oauth2/token', '/oauth/linuxdo/token'],
  ['/api/user', '/oauth/linuxdo/userinfo'],
]);

const RELAY_TOKEN_HEADER = 'X-Relay-Token';

/** 首次安装时捕获的原始实现；重复安装总是从原始引用重新包裹，避免链式叠加 */
let originalFetch: typeof fetch | null = null;

export function installOAuthRelay(baseUrl: string, sharedSecret: string): void {
  // 立即解析一次：非法地址在启动时崩溃，而不是等到第一次 OAuth 请求
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' && base.protocol !== 'http:') {
    throw new Error(`GOOGLE_OAUTH_PROXY_BASE_URL 协议非法：${base.protocol}`);
  }
  if (!sharedSecret) {
    throw new Error('GOOGLE_OAUTH_PROXY_SHARED_SECRET 缺失（中继要求 X-Relay-Token）');
  }
  originalFetch ??= globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input));
    const relayPath =
      HOST_RELAY_PATHS.get(url.hostname) ??
      (url.hostname === LINUXDO_HOST ? LINUXDO_PATH_RELAY_PATHS.get(url.pathname) : undefined);
    if (!relayPath) {
      return originalFetch!(input, init);
    }
    const headers = new Headers(init?.headers);
    headers.set(RELAY_TOKEN_HEADER, sharedSecret);
    return originalFetch!(`${base.origin}${relayPath}${url.search}`, { ...init, headers });
  }) as typeof fetch;
}
