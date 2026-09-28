/** 登录/注册页：共用入口；模式切换只通过底部超链接。
 *  (docs/rebuild/05-OPERATIONS.md §2)
 *  - 登录：默认密码 tab；可选「邮箱验证码」tab。
 *  - 注册：固定流程——昵称（可选）→ 邮箱 → 发验证码 → 验证 → 密码 → 提交。
 *    任一环节失败都不会建立账号；邮箱先验证能确保 mailer 出错时立即可见。
 *  - Admin 通过 next=/admin 反代由 web 端 login 走完登录回到后台，保持单一口令 + cookie。
 */
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { authClient } from '../api/auth-client.js';
import { useLanguage } from '../state/language.js';

type Mode = 'signin' | 'signup';
type Method = 'password' | 'otp';
type Stage = 'email' | 'code';

export function LoginPage() {
  const { copy } = useLanguage();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get('next') ?? '/';

  const [mode, setMode] = useState<Mode>('signin');
  const [method, setMethod] = useState<Method>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  // 登录 OTP / 注册 OTP 共用一个 stage。
  const [stage, setStage] = useState<Stage>('email');
  // 注册专用：是否已通过 OTP；提交注册前必须 true。
  const [signupOtpVerified, setSignupOtpVerified] = useState(false);
  const [busy, setBusy] = useState(false);
  // 从重置页跳回时提示用新密码登录（/login?reset=1）
  const [notice, setNotice] = useState<string | null>(params.get('reset') ? '密码已重置，请用新密码登录' : null);
  const [error, setError] = useState<string | null>(null);

  // ---------- 验证码发送 ----------
  const sendCode = async (type: 'sign-in' | 'email-verification') => {
    setBusy(true);
    setError(null);
    const { error: sendError } = await authClient.emailOtp.sendVerificationOtp({ email, type });
    setBusy(false);
    if (sendError) {
      setError(sendError.message ?? '验证码发送失败，请稍后再试');
      return;
    }
    setStage('code');
    setNotice(type === 'sign-in' ? copy.codeSent : '验证码已发送（请查收用于注册）');
  };

  // 登录 OTP：单一提交即可登录
  const verifyOtpForSignIn = async () => {
    setBusy(true);
    setError(null);
    const { error: verifyError } = await authClient.signIn.emailOtp({ email, otp: code });
    setBusy(false);
    if (verifyError) {
      setError(verifyError.message ?? '验证码不正确');
      return;
    }
    navigate(next, { replace: true });
  };

  // 注册 OTP：仅校验 OTP 本身是否正确，不直接登录。
  // Better-Auth 没有 public 的 "校验 OTP 不登录" 接口；通过调用 signIn.emailOtp
  // 让他帮我们测一致性，对于未注册邮箱（预期）会返回 USER_NOT_FOUND，此时视为
  // 「OTP 已验证」，让用户继续填密码完成注册。
  const verifyOtpForSignup = async () => {
    setBusy(true);
    setError(null);
    const { error: verifyError } = await authClient.signIn.emailOtp({ email, otp: code });
    setBusy(false);
    if (verifyError) {
      const status = (verifyError as { status?: number }).status;
      const msg = verifyError.message ?? '';
      const looksLikeUserMissing = status === 404 || msg.toLowerCase().includes('not found') || msg.includes('不存在');
      if (looksLikeUserMissing) {
        // 邮箱尚未注册 → OTP 视为有效（这一步只能确认 OTP 一致性；最终注册由 sign-up 写库）
        setSignupOtpVerified(true);
        setNotice('邮箱已验证，请设置密码完成注册');
        return;
      }
      setError(msg || '验证码不正确');
      return;
    }
    // 走到了：邮箱其实已注册，提示用户去登录
    setError('该邮箱已注册，请改用「去登录」');
  };

  // ---------- 密码登录 ----------
  const passwordSignIn = async () => {
    setBusy(true);
    setError(null);
    const { error: pwError } = await authClient.signIn.email({ email, password });
    setBusy(false);
    if (pwError) {
      setError(pwError.message ?? '邮箱或密码不正确；首次登录请使用验证码。');
      return;
    }
    navigate(next, { replace: true });
  };

  // ---------- 注册：必须在 OTP 通过后才能提交 ----------
  const signupWithPassword = async () => {
    if (!signupOtpVerified) {
      setError('请先完成邮箱验证码验证');
      return;
    }
    setBusy(true);
    setError(null);
    const fallbackName = name.trim().length > 0 ? name : email.split('@')[0] ?? email;
    const { error: signErr } = await authClient.signUp.email({
      email,
      password,
      name: fallbackName,
    });
    setBusy(false);
    if (signErr) {
      setError(signErr.message ?? '注册失败，请稍后再试');
      return;
    }
    // 注册完成 → 自动登录
    setBusy(true);
    const { error: signInErr } = await authClient.signIn.email({ email, password });
    setBusy(false);
    if (signInErr) {
      setMode('signin');
      setMethod('password');
      setNotice('注册成功，请使用刚设置的密码登录');
      return;
    }
    navigate(next, { replace: true });
  };

  // ---------- 第三方 OAuth（Google / LINUX DO） ----------
  const oauthSignIn = async (provider: 'google' | 'linuxdo') => {
    setBusy(true);
    setError(null);
    const { data, error: oauthError } = await authClient.signIn.social({
      provider,
      callbackURL: next,
    });
    setBusy(false);
    if (oauthError) {
      setError(oauthError.message ?? '无法启动第三方登录');
      return;
    }
    if (data?.url) {
      window.location.href = data.url;
    }
  };

  // 模式切换：清空所有 UI 状态
  const switchMode = (target: Mode) => {
    setMode(target);
    setError(null);
    setNotice(null);
    setCode('');
    setPassword('');
    setStage('email');
    setSignupOtpVerified(false);
    setMethod('password');
  };

  const headingTitle = mode === 'signin' ? copy.login : '注册新账号';

  return (
    <main className="shell narrow">
      <header className="topbar">
        <h1 className="brand">{copy.brand}</h1>
      </header>
      <section className="panel stack">
        <h2>{headingTitle}</h2>

        {/* ===== 登录：密码 / 验证码 双 tab ===== */}
        {mode === 'signin' && (
          <>
            <nav className="mode-tabs" aria-label="登录方式">
              <button
                type="button"
                className={'mode-tab' + (method === 'password' ? ' active' : '')}
                onClick={() => { setMethod('password'); setError(null); setStage('email'); }}
              >
                密码
              </button>
              <button
                type="button"
                className={'mode-tab' + (method === 'otp' ? ' active' : '')}
                onClick={() => { setMethod('otp'); setError(null); setStage('email'); }}
              >
                邮箱验证码
              </button>
            </nav>

            {method === 'password' && (
              <div className="stack">
                <label className="field-label" htmlFor="email-pw">
                  Email
                  <input
                    id="email-pw"
                    className="field"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                  />
                </label>
                <label className="field-label" htmlFor="password">
                  Password
                  <input
                    id="password"
                    className="field"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="至少 8 位"
                  />
                </label>
                <button
                  className="btn btn-primary"
                  disabled={busy || !email.includes('@') || password.length < 8}
                  onClick={() => void passwordSignIn()}
                >
                  {copy.login}
                </button>
                <p className="muted" style={{ textAlign: 'center' }}>
                  忘记密码？<a href="/forgot-password">找回密码</a>
                </p>
              </div>
            )}

            {method === 'otp' && stage === 'email' && (
              <div className="stack">
                <label className="field-label" htmlFor="email-otp">
                  Email
                  <input
                    id="email-otp"
                    className="field"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                  />
                </label>
                <button
                  className="btn btn-primary"
                  disabled={busy || !email.includes('@')}
                  onClick={() => void sendCode('sign-in')}
                >
                  发送验证码
                </button>
              </div>
            )}

            {method === 'otp' && stage === 'code' && (
              <div className="stack">
                <p className="muted">{notice ?? '验证码已发送'}</p>
                <label className="field-label" htmlFor="code-otp">
                  验证码
                  <input
                    id="code-otp"
                    className="field"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="000000"
                  />
                </label>
                <button
                  className="btn btn-primary"
                  disabled={busy || code.length < 4}
                  onClick={() => void verifyOtpForSignIn()}
                >
                  登录
                </button>
                <button className="btn" disabled={busy} onClick={() => setStage('email')}>
                  换邮箱
                </button>
              </div>
            )}
          </>
        )}

        {/* ===== 注册：固定四步流程 ===== */}
        {mode === 'signup' && (
          <div className="stack">
            <label className="field-label" htmlFor="name-su">
              昵称
              <input
                id="name-su"
                className="field"
                type="text"
                autoComplete="nickname"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="选填，登录后可在「我的」里改"
              />
            </label>

            <label className="field-label" htmlFor="email-su">
              Email
              <input
                id="email-su"
                className="field"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  // 修改邮箱后必须重新走 OTP
                  if (signupOtpVerified) {
                    setSignupOtpVerified(false);
                  }
                }}
                placeholder="you@example.com"
              />
            </label>

            {!signupOtpVerified && (
              <button
                type="button"
                className="btn"
                disabled={busy || !email.includes('@')}
                onClick={() => void sendCode('email-verification')}
              >
                {stage === 'code' ? '重新发送验证码' : '发送验证码'}
              </button>
            )}

            {!signupOtpVerified && stage === 'code' && (
              <>
                <label className="field-label" htmlFor="code-su">
                  验证码
                  <input
                    id="code-su"
                    className="field"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="000000"
                  />
                </label>
                <button
                  className="btn"
                  disabled={busy || code.length < 4}
                  onClick={() => void verifyOtpForSignup()}
                >
                  验证邮箱
                </button>
              </>
            )}

            {signupOtpVerified && (
              <>
                <p className="ok-text">✓ 邮箱已验证</p>
                <label className="field-label" htmlFor="password-su">
                  Password
                  <input
                    id="password-su"
                    className="field"
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="至少 8 位"
                  />
                </label>
                <button
                  className="btn btn-primary"
                  disabled={busy || password.length < 8}
                  onClick={() => void signupWithPassword()}
                >
                  注册并登录
                </button>
              </>
            )}
          </div>
        )}

        {error && <p className="error-text" role="alert">{error}</p>}
        {notice && method === 'password' && mode === 'signin' && (
          <p className="muted" role="status">{notice}</p>
        )}

        <div className="divider">
          <span className="muted">或</span>
        </div>
        <button className="btn" onClick={() => void oauthSignIn('google')} disabled={busy}>
          {copy.googleLogin}
        </button>
        <button className="btn" onClick={() => void oauthSignIn('linuxdo')} disabled={busy}>
          使用 LINUX DO 登录
        </button>

        {/* 模式切换：底部超链接 */}
        <p className="muted" style={{ textAlign: 'center', marginTop: 12 }}>
          {mode === 'signin' ? (
            <>还没有账号？<a href="#" onClick={(e) => { e.preventDefault(); switchMode('signup'); }}>去注册</a></>
          ) : (
            <>已经有账号？<a href="#" onClick={(e) => { e.preventDefault(); switchMode('signin'); }}>去登录</a></>
          )}
        </p>
      </section>
    </main>
  );
}
