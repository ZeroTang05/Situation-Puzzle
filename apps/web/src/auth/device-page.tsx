/** 小游戏设备授权确认页：先登录官网，再核对确认码，明确同意后发放会话。 */
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { deviceVerificationSchema } from '@jev/contracts';
import { displayDeviceAuthError } from '@jev/i18n';
import { authClient } from '../api/auth-client.js';
import { BrandHeading } from '../brand-heading.js';
import { useLanguage } from '../state/language.js';
import type { Session } from '../session.js';

export function DevicePage({ session }: { session: Session }) {
  const { language, copy } = useLanguage();
  const text = (zh: string, en: string) => language === 'zh' ? zh : en;
  const [params] = useSearchParams();
  const userCode = params.get('user_code') ?? '';
  const [actionError, setErrorCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<'approved' | 'denied' | null>(null);

  // 查询库合并重复挂载产生的同一请求，确认码的服务端校验仍由库执行。
  const verification = useQuery({
    queryKey: ['device-authorization', session.user.id, userCode], enabled: Boolean(userCode), retry: false, staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await authClient.device({ query: { user_code: userCode } });
      if (error) throw new Error(error.error ?? 'authorization_failed');
      const verified = deviceVerificationSchema.parse(data);
      if (!verified.client_id) throw new Error('access_denied');
      return verified;
    },
  });
  const request = verification.data;
  const errorCode = actionError || (!userCode ? 'invalid_request' : verification.error?.message ?? '');
  useEffect(() => { setErrorCode(''); setResult(null); }, [userCode]);

  /** 每次点击都由服务器重新检查账号归属、有效期和已处理状态。 */
  const decide = async (approve: boolean) => {
    setBusy(true); setErrorCode('');
    try {
      const response = approve ? await authClient.device.approve({ userCode }) : await authClient.device.deny({ userCode });
      if (response.error) { setErrorCode(response.error.error ?? 'authorization_failed'); return; }
      setResult(approve ? 'approved' : 'denied');
    } catch (error) { console.error('[device:decision]', error); setErrorCode('authorization_failed'); }
    finally { setBusy(false); }
  };

  return <main className="shell narrow">
    <header className="topbar topbar-title"><BrandHeading>{copy.brand}</BrandHeading></header>
    <section className="panel stack">
      <h2>{text('登录 TapTap 小游戏', 'Sign in to the TapTap game')}</h2>
      {result ? <p role="status">{result === 'approved' ? text('已允许登录，请回到小游戏。', 'Sign-in approved. Return to the game.') : text('已拒绝登录，可以关闭此页。', 'Sign-in denied. You can close this page.')}</p> : <>
        <p>{text('当前账号', 'Current account')}：{session.user.name || session.user.email}</p>
        <p>{text('请核对小游戏中的确认码。只有你自己发起的登录才应允许。', 'Check the code shown in your game. Approve only a sign-in you started yourself.')}</p>
        <p><strong>{userCode}</strong></p>
        {!request && !errorCode && <p role="status">{text('正在加载…', 'Loading…')}</p>}
        {request?.status === 'pending' && <>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => { void decide(true); }}>{text('允许登录', 'Approve sign-in')}</button>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => { void decide(false); }}>{text('拒绝', 'Deny')}</button>
        </>}
        {request && request.status !== 'pending' && <p role="status">{text('此请求已处理，请回到小游戏。', 'This request has already been processed. Return to the game.')}</p>}
      </>}
      {errorCode && <p className="error-text" role="alert">{displayDeviceAuthError(errorCode, language)}</p>}
    </section>
  </main>;
}
