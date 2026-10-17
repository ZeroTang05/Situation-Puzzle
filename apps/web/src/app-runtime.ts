/**
 * App 壳（Capacitor）运行时适配：接口/WS 基址与 Bearer 令牌。
 *
 * - 基址来自构建期 VITE_API_BASE_URL（App 壳构建写入生产域名，见 apps/web/.env.app）；
 *   网页构建不设置 → 相对路径 + Cookie，行为与无壳时完全一致
 * - 令牌只在 App 壳存取（WebView 拒收第三方 Cookie，登录改走 Authorization: Bearer，
 *   见 docs/rebuild/13-APP-VERSION.md §4）；存 localStorage（https://localhost 私有空间），
 *   不给 web 工作区引入 Capacitor 依赖
 * - Capacitor 原生桥会在 WebView 里注入 window.Capacitor，据此区分壳与浏览器
 */
export const apiBase = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '');

/** 壳内为原生平台（window.Capacitor 由 Capacitor 运行时注入） */
export const isAppShell = typeof window !== 'undefined' && Boolean((window as { Capacitor?: unknown }).Capacitor);

/** 接口地址：App 壳指向生产域名，网页保持相对路径（当前站点同源代理） */
export function apiUrl(path: string): string {
  return `${apiBase}/api/v1${path}`;
}

/** WS 地址：App 壳按接口基址推导（http→ws / https→wss），网页按当前页面位置推导 */
export function wsUrl(): string {
  if (apiBase) return `${apiBase.replace(/^http/, 'ws')}/ws`;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}

const TOKEN_KEY = 'jev.app-session-token';

/** 业务与认证请求统一附带的令牌头；网页端恒为空对象（行为不变） */
export function authorizationHeader(): Record<string, string> {
  if (!isAppShell) return {};
  const token = localStorage.getItem(TOKEN_KEY);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** 登录/会话刷新响应经 set-auth-token 头下发令牌；只在 App 壳存储，网页继续用 Cookie */
export function captureBearerToken(response: Response): void {
  if (!isAppShell) return;
  const token = response.headers.get('set-auth-token');
  if (token) localStorage.setItem(TOKEN_KEY, token);
}

export function clearBearerToken(): void {
  if (isAppShell) localStorage.removeItem(TOKEN_KEY);
}
