/**
 * App 壳深链与剪贴板邀请检测（网页端为空操作，见 docs/rebuild/13-APP-VERSION.md §5）。
 *
 * - OAuth 回流：系统浏览器完成授权后经服务端 handoff 302 到
 *   cn.xiaobaozi.sp:/oauth?code=..&next=..，这里换回 Bearer 令牌后整页加载到 next
 *   （整页加载让会话查询带新令牌重新发起，避免各处手动作废缓存）
 * - 邀请链接过渡（App Links 要到 M3 拿到签名才能启用）：App 回到前台时读剪贴板，
 *   发现本站邀请链接则询问是否加入；同一条链接本次运行内只问一次
 */
import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { useDialog } from '@jev/ui';
import { api, translateApiError } from './api/client.js';
import { useLanguage } from './state/language.js';
import {
  apiBase,
  closeSystemBrowser,
  isAppShell,
  onAppResume,
  onAppUrlOpen,
  readClipboardText,
  storeBearerToken,
} from './app-runtime.js';

/** 上一条已提示过的剪贴板邀请路径：同一页面运行期不重复打扰 */
let lastPromptedInvite: string | null = null;

/** 深链 next 只接受站内相对路径，防借深链参数跳到外部地址 */
function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '/';
  return raw;
}

export function useAppShellLinks(): void {
  const navigate = useNavigate();
  const dialog = useDialog();
  const { copy, language } = useLanguage();

  useEffect(() => {
    if (!isAppShell) return;

    const unbindUrl = onAppUrlOpen((url) => {
      void (async () => {
        const parsed = new URL(url);
        const code = parsed.searchParams.get('code');
        const next = safeNext(parsed.searchParams.get('next'));
        await closeSystemBrowser();
        if (code) {
          try {
            const { token } = await api<{ token: string }>('/app-session/exchange', { method: 'POST', body: { code } });
            storeBearerToken(token);
            window.location.assign(next);
            return;
          } catch (err) {
            await dialog.confirm(translateApiError(err, language, copy.oauthHandoffExpired));
          }
        }
        window.location.assign('/login');
      })();
    });

    const unbindResume = onAppResume(() => {
      void (async () => {
        const text = await readClipboardText().catch(() => null);
        if (!text) return;
        // 只认本站（接口基址或当前页面主机）的邀请链接，不碰其他剪贴板内容
        const hosts = new Set([location.hostname.toLowerCase(), ...(apiBase ? [new URL(apiBase).hostname.toLowerCase()] : [])]);
        const match = /^https?:\/\/([^/\s]+)\/(lobby|room)\/invite\/([0-9a-f]+)\/?\s*$/i.exec(text);
        if (!match || !hosts.has(match[1]!.toLowerCase())) return;
        const path = `/${match[2]!}/invite/${match[3]!}`;
        if (path === lastPromptedInvite) return;
        lastPromptedInvite = path;
        if (await dialog.confirm(copy.clipboardInvitePrompt)) navigate(path);
      })();
    });

    return () => {
      unbindUrl();
      unbindResume();
    };
  }, [dialog, navigate, copy, language]);
}
