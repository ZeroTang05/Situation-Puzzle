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

/** OAuth 回流交接直接写入令牌（不走响应头），同样只对壳生效 */
export function storeBearerToken(token: string): void {
  if (isAppShell) localStorage.setItem(TOKEN_KEY, token);
}

// ---------- 原生桥（经 window.Capacitor.Plugins 动态调用，不引入 Capacitor 依赖） ----------

interface BrowserPlugin {
  open(options: { url: string }): Promise<void>;
  close(): Promise<void>;
}
/** 监听句柄：Android 桥同步返回 { remove }，web 代理返回 Promise<{ remove }>，两种形状都收 */
type ListenerHandle = { remove(): Promise<void> } | Promise<{ remove(): Promise<void> }>;
interface AppPlugin {
  addListener(eventName: 'appUrlOpen' | 'resume', callback: (data: { url: string }) => void): ListenerHandle;
}
interface ClipboardPlugin {
  read(): Promise<{ value?: string; type?: string }>;
}
interface PluginRegistry {
  Browser?: BrowserPlugin;
  App?: AppPlugin;
  Clipboard?: ClipboardPlugin;
}

function nativePlugins(): PluginRegistry | undefined {
  if (!isAppShell) return undefined;
  return (window as unknown as { Capacitor?: { Plugins?: PluginRegistry } }).Capacitor?.Plugins;
}

/** 站点绝对来源：App 壳=接口基址（生产域名），网页=当前页面来源（开发期同源代理也成立） */
export function siteOrigin(): string {
  return apiBase || window.location.origin;
}

/** 在系统浏览器（Android Custom Tab）打开 OAuth 授权页：WebView 内会被 Google 拦截 */
export async function openSystemBrowser(url: string): Promise<void> {
  await nativePlugins()?.Browser?.open({ url });
}

export async function closeSystemBrowser(): Promise<void> {
  await nativePlugins()?.Browser?.close();
}

/** 注册原生事件监听：句柄形状归一化后统一管理，返回解绑函数 */
function bindNativeListener(event: 'appUrlOpen' | 'resume', callback: (data: { url: string }) => void): () => void {
  const app = nativePlugins()?.App;
  let handle: { remove(): Promise<void> } | undefined;
  let disposed = false;
  // Promise.resolve 对普通对象和 Promise 都收敛成 thenable，兼容桥的同步句柄
  void Promise.resolve(app?.addListener(event, callback)).then((h) => {
    if (!h) return;
    if (disposed) void h.remove();
    else handle = h;
  });
  return () => {
    disposed = true;
    void handle?.remove();
  };
}

/** 深链进入 App（OAuth 回流 cn.xiaobaozi.sp:/oauth?...）；返回解绑函数 */
export function onAppUrlOpen(callback: (url: string) => void): () => void {
  return bindNativeListener('appUrlOpen', (data) => callback(data.url));
}

/** App 回到前台（含启动），剪贴板邀请检测用 */
export function onAppResume(callback: () => void): () => void {
  return bindNativeListener('resume', () => callback());
}

export async function readClipboardText(): Promise<string | null> {
  const result = await nativePlugins()?.Clipboard?.read();
  return result?.value ?? null;
}
