/**
 * Google OAuth 出站代理（docs/rebuild/05-OPERATIONS.md §2）。
 *
 * 服务器在境内时无法直连 Google 的 *.googleapis.com：token 兑换（POST）和
 * JWKS 拉取都在服务端发生。配置 GOOGLE_OAUTH_PROXY_BASE_URL 后，本模块在
 * 启动时包一层全局 fetch，把这些域名的请求改写为
 * `<代理>/<原域名>/<路径>` —— 与内部分发节点（ai-proxy）转发 Groq/OpenAI
 * 的形状完全一致。授权跳转发生在用户浏览器侧，不经过这里。
 */
const GOOGLE_OAUTH_HOSTS = new Set([
  'oauth2.googleapis.com',
  'www.googleapis.com',
  'openidconnect.googleapis.com',
]);

/** 首次安装时捕获的原始实现；重复安装总是从原始引用重新包裹，避免链式叠加 */
let originalFetch: typeof fetch | null = null;

export function installGoogleOAuthProxy(baseUrl: string): void {
  // 立即解析一次：非法地址在启动时崩溃，而不是等到第一次 OAuth 请求
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' && base.protocol !== 'http:') {
    throw new Error(`GOOGLE_OAUTH_PROXY_BASE_URL 协议非法：${base.protocol}`);
  }
  originalFetch ??= globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input));
    if (!GOOGLE_OAUTH_HOSTS.has(url.hostname)) {
      return originalFetch!(input, init);
    }
    const proxied = `${base.origin}/${url.hostname}${url.pathname}${url.search}`;
    return originalFetch!(proxied, init);
  }) as typeof fetch;
}
