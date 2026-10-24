/**
 * App 壳深链与剪贴板邀请检测（网页端为空操作，见 docs/rebuild/13-APP-VERSION.md §5）。
 *
 * - OAuth 回流：系统浏览器完成授权后经服务端 handoff 302 到
 *   cn.xiaobaozi.sp:/oauth?code=..&next=..，这里换回 Bearer 令牌后整页加载到 next
 *   （整页加载让会话查询带新令牌重新发起，避免各处手动作废缓存）
 * - App Links 邀请：点开官网域名的邀请链接时 App 直接进邀请页
 *   （manifest autoVerify + /.well-known/assetlinks.json 认领）
 * - 邀请链接过渡：App 回到前台时读剪贴板，发现本站邀请链接则询问是否加入；
 *   同一条链接本次运行内只问一次
 */
import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { useDialog } from '@jev/ui';
import { api, translateApiError } from './api/client.js';
import { useLanguage } from './state/language.js';
import { consumeAppOAuthCallback } from './auth/app-oauth.js';
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

/** 识别本站（接口基址或当前页面主机）的邀请链接，返回站内路径；其余返回 null */
function matchInvitePath(url: string): string | null {
  const hosts = new Set([location.hostname.toLowerCase(), ...(apiBase ? [new URL(apiBase).hostname.toLowerCase()] : [])]);
  const match = /^https?:\/\/([^/\s]+)\/(lobby|room)\/invite\/([0-9a-f]+)\/?\s*$/i.exec(url);
  if (!match || !hosts.has(match[1]!.toLowerCase())) return null;
  return `/${match[2]!}/invite/${match[3]!}`;
}

export function useAppShellLinks(): void {
  const navigate = useNavigate();
  const dialog = useDialog();
  const { copy, language } = useLanguage();

  useEffect(() => {
    if (!isAppShell) return;

    const unbindUrl = onAppUrlOpen((url) => {
      // App Links：官网域名的邀请链接直达邀请页
      const invitePath = matchInvitePath(url);
      if (invitePath) {
        navigate(invitePath);
        return;
      }
      const callback = consumeAppOAuthCallback(url);
      if (!callback) return;
      const { code, verifier, next } = callback;
      void (async () => {
        await closeSystemBrowser();
        if (code) {
          try {
            const { token } = await api<{ token: string }>('/app-session/exchange', { method: 'POST', body: { code, verifier } });
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
        // 只认本站邀请链接，不碰其他剪贴板内容
        const path = matchInvitePath(text);
        if (!path || path === lastPromptedInvite) return;
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
