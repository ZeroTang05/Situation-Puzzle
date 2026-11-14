/**
 * 网页、App 壳（Capacitor）和 TapTap H5 的接口、路由及会话适配。
 *
 * - 基址来自构建期 VITE_API_BASE_URL（App 壳构建写入生产域名，见 apps/web/.env.app）；
 *   网页构建不设置 → 相对路径 + Cookie，行为与无壳时完全一致
 * - App 壳和 H5 跨来源请求使用 Bearer，令牌保存在各自来源的 localStorage；
 *   普通网页使用同源 Cookie，账号数据仍由同一服务端提供。
 * - Capacitor 原生桥会在 WebView 里注入 window.Capacitor，据此区分壳与浏览器
 */
export const apiBase = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '');
export const isTapH5 = import.meta.env.VITE_TAPTAP_H5 === 'true';

/** 壳内为原生平台（window.Capacitor 由 Capacitor 运行时注入） */
export const isAppShell = typeof window !== 'undefined' && Boolean((window as { Capacitor?: unknown }).Capacitor);
const usesBearer = isAppShell || isTapH5;

/** 接口地址：App 壳指向生产域名，网页保持相对路径（当前站点同源代理） */
export function apiUrl(path: string): string {
  return `${apiBase}/api/v1${path}`;
}

/** WS 地址：App 壳按接口基址推导（http→ws / https→wss），网页按当前页面位置推导 */
export function wsUrl(): string {
  if (apiBase) return `${apiBase.replace(/^http/, 'ws')}/ws`;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}

const TOKEN_KEY = isTapH5 ? 'jev.taptap-h5-session-token' : 'jev.app-session-token';

/** App 壳与 H5 的业务和认证请求携带本站会话令牌。 */
export function authorizationHeader(): Record<string, string> {
  if (!usesBearer) return {};
  const token = localStorage.getItem(TOKEN_KEY);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * 语言请求头：把用户当前界面语言带给服务端（事务邮件按它发中/英文）。
 * 每次请求实时读取 localStorage，取最新选择；语言状态本身在 state/language.tsx。
 */
export function languageHeader(): Record<string, string> {
  const stored = typeof localStorage === 'undefined' ? null : localStorage.getItem('jev.language');
  return { 'X-Jev-Language': stored === 'en' ? 'en' : 'zh' };
}

/** 登录与会话刷新经 set-auth-token 头下发令牌，App 壳与 H5 存到本来源。 */
export function captureBearerToken(response: Response): void {
  if (!usesBearer) return;
  const token = response.headers.get('set-auth-token');
  if (token) localStorage.setItem(TOKEN_KEY, token);
}

export function clearBearerToken(): void {
  if (usesBearer) localStorage.removeItem(TOKEN_KEY);
}

/** OAuth 回流交接直接写入令牌（不走响应头），同样只对壳生效 */
export function storeBearerToken(token: string): void {
  if (usesBearer) localStorage.setItem(TOKEN_KEY, token);
}

/** H5 部署在平台子目录，站内整页跳转要保留实际入口和 HashRouter 路径。 */
export function appHref(path: string): string {
  if (!isTapH5) return path;
  const destination = new URL(path, location.origin);
  if (destination.origin !== location.origin) throw new Error('站内链接必须属于当前来源');
  return `${location.pathname}${location.search}#${destination.pathname}${destination.search}${destination.hash}`;
}

/** 静态资源跟随构建入口，适用于站点根目录和平台游戏子目录。 */
export function assetUrl(name: string): string {
  return `${import.meta.env.BASE_URL}${name}`;
}

// ---------- 原生桥（经 window.Capacitor.Plugins 动态调用，不引入 Capacitor 依赖） ----------

interface BrowserPlugin {
  open(options: { url: string }): Promise<void>;
  close(): Promise<void>;
}
/** 监听句柄：Android 桥同步返回 { remove }，web 代理返回 Promise<{ remove }>，两种形状都收 */
type ListenerHandle = { remove(): Promise<void> } | Promise<{ remove(): Promise<void> }>;
/** 原生事件数据：appUrlOpen 带 url，backButton 带 canGoBack，只声明用到的字段 */
interface NativeEventData {
  url?: string;
  canGoBack?: boolean;
}
interface AppPlugin {
  addListener(eventName: 'appUrlOpen' | 'resume' | 'backButton', callback: (data: NativeEventData) => void): ListenerHandle;
  exitApp(): void;
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
function bindNativeListener(event: 'appUrlOpen' | 'resume' | 'backButton', callback: (data: NativeEventData) => void): () => void {
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
  return bindNativeListener('appUrlOpen', (data) => callback(data.url ?? ''));
}

/** App 回到前台（含启动），剪贴板邀请检测用 */
export function onAppResume(callback: () => void): () => void {
  return bindNativeListener('resume', () => callback());
}

/**
 * Android 侧键（返回键/手势）按下。App 插件接管了返回键且默认行为没有「退出」
 * 兜底（WebView 历史回退到头时什么都不发生），必须在 web 层监听并自己收尾。
 */
export function onAppBackButton(callback: () => void): () => void {
  return bindNativeListener('backButton', () => callback());
}

/** 结束 App（侧键在历史栈底时的退出动作） */
export function exitApp(): void {
  nativePlugins()?.App?.exitApp();
}

export async function readClipboardText(): Promise<string | null> {
  const result = await nativePlugins()?.Clipboard?.read();
  return result?.value ?? null;
}
