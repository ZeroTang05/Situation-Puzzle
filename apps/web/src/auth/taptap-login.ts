/**
 * TapTap H5 登录：容器注入的 window.tap 桥获取 code，交服务端 code2Session 换本站会话。
 *
 * - 只在 TapTap H5 构建里使用；普通浏览器没有 tap 桥，调用会得到明确错误
 * - better-auth 端点不走业务接口的 {data,error} 信封：成功裸 JSON {token}，失败 {code,message}
 * - 防沉迷由 TapTap 平台统一实名系统在登录链路执行，未实名用户会被平台拒绝，这里只做错误翻译
 */
import { apiUrl, languageHeader, storeBearerToken } from '../app-runtime.js';

/** TapTap 容器注入的登录桥；只声明用到的接口（回调风格，不支持 Promise） */
interface TapLoginBridge {
  login(options: {
    timeout?: number;
    success?(res: { code: string }): void;
    fail?(err: { errMsg: string; errno?: number }): void;
  }): void;
}

/** 登录失败：code 为稳定错误码（TAPTAP_LOGIN_*），页面据此翻译文案 */
export class TapLoginError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'TapLoginError';
  }
}

function tapBridge(): TapLoginBridge | undefined {
  return (window as { tap?: TapLoginBridge }).tap;
}

/** 容器内才有 tap 桥；开发预览/外部分享打开的浏览器里不存在 */
export function isTapContainer(): boolean {
  return typeof window !== 'undefined' && tapBridge() !== undefined;
}

/** 取平台临时登录凭证 code（五分钟有效、单次使用） */
function tapLoginCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    const bridge = tapBridge();
    if (!bridge) {
      reject(new TapLoginError('TAPTAP_LOGIN_UNAVAILABLE', 'TapTap bridge unavailable'));
      return;
    }
    bridge.login({
      timeout: 10_000,
      success: (res) => resolve(res.code),
      fail: (err) => reject(new TapLoginError('TAPTAP_LOGIN_FAILED', err.errMsg)),
    });
  });
}

/** TapTap 一键登录：code 换 openid 建号建会话，令牌存本来源后由整页跳转带上 */
export async function loginWithTapTap(): Promise<void> {
  const code = await tapLoginCode();
  const response = await fetch(apiUrl('/auth/taptap-mini/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...languageHeader() },
    body: JSON.stringify({ code }),
  });
  const payload = (await response.json().catch(() => null)) as { token?: string; code?: string; message?: string } | null;
  if (!response.ok || !payload?.token) {
    throw new TapLoginError(payload?.code ?? 'TAPTAP_LOGIN_BUSY', payload?.message ?? 'TapTap sign-in failed');
  }
  storeBearerToken(payload.token);
}
