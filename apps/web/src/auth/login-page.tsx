/** 登录/注册页：共用入口；模式切换只通过底部超链接。
 *  (docs/rebuild/05-OPERATIONS.md §2)
 *  - 登录：默认密码 tab；可选「邮箱验证码」tab。
 *  - 注册：固定流程——昵称（可选）→ 邮箱 → 发验证码 → 验证 → 密码 → 提交。
 *    任一环节失败都不会建立账号；邮箱先验证能确保 mailer 出错时立即可见。
 *  - Admin 通过 next=/admin 反代由 web 端 login 走完登录回到后台，保持单一口令 + cookie。
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { authClient } from '../api/auth-client.js';
import { translateApiError } from '../api/client.js';
import { useLanguage } from '../state/language.js';
import { useBack } from '../back.js';
import { format } from '@jev/i18n';
import { otpCooldownKey, readOtpDeadline, remainingOtpSeconds, sendOtpCode, OtpSendError } from './otp-cooldown.js';

type Mode = 'signin' | 'signup';
type Method = 'password' | 'otp';
type Stage = 'email' | 'code';

export function LoginPage() {
  const { copy, language, setLanguage } = useLanguage();
  const navigate = useNavigate();
  const back = useBack('/');
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
  const [notice, setNotice] = useState<string | null>(params.get('reset') ? copy.passwordResetSuccess : null);
  const [error, setError] = useState<string | null>(null);
  const sendingCode = useRef(false);
  const [sendUntil, setSendUntil] = useState(() => readOtpDeadline(localStorage));
  const [now, setNow] = useState(Date.now);
  const sendWait = remainingOtpSeconds(sendUntil, now);
  const sendLabel = sendWait
    ? (language === 'en' ? format(copy.retryIn, { n: sendWait }) : format(copy.resendIn, { n: sendWait }))
    : (language === 'en' ? copy.sendCodeAlt : stage === 'code' ? copy.resendCode : copy.sendCode);
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    const sync = (event: StorageEvent) => { if (event.key === otpCooldownKey) setSendUntil(readOtpDeadline(localStorage)); };
    window.addEventListener('storage', sync);
    return () => { window.clearInterval(interval); window.removeEventListener('storage', sync); };
  }, []);
  const rememberWait = (seconds: number) => {
    if (!seconds) return;
    const deadline = Date.now() + seconds * 1000;
    localStorage.setItem(otpCooldownKey, String(deadline));
    setSendUntil(deadline); setNow(Date.now());
  };

  // ---------- 验证码发送 ----------
  const sendCode = async (type: 'sign-in' | 'email-verification') => {
    if (sendingCode.current || busy || remainingOtpSeconds(sendUntil, Date.now()) > 0) return;
    sendingCode.current = true;
    setBusy(true);
    setError(null);
    try {
      // sign-in 用途支持尚未注册的邮箱；注册只检查验证码，之后再建账号。
      const seconds = await sendOtpCode(email.trim().toLowerCase(), 'sign-in');
      rememberWait(seconds);
      setStage('code');
      setNotice(type === 'sign-in' ? copy.codeSent : copy.codeSentSignup);
    } catch (error) {
      if (error instanceof OtpSendError) rememberWait(error.retryAfterSeconds);
      else rememberWait(60); // 网络中断时发送结果未知，等待期间仍可验证已有验证码。
      setError(translateApiError(error, language, copy.sendCodeFail));
    } finally {
      sendingCode.current = false;
      setBusy(false);
    }
  };

  // 登录 OTP：单一提交即可登录
  const verifyOtpForSignIn = async () => {
    setBusy(true);
    setError(null);
    const { error: verifyError } = await authClient.signIn.emailOtp({ email: email.trim().toLowerCase(), otp: code });
    setBusy(false);
    if (verifyError) {
      setError(verifyError.message ?? copy.otpInvalid);
      return;
    }
    navigate(next, { replace: true });
  };

  // 注册只检查 OTP，验证通过后不存在的账号返回稳定 USER_NOT_FOUND 错误码。
  const verifyOtpForSignup = async () => {
    setBusy(true);
    setError(null);
    const { error: verifyError } = await authClient.emailOtp.checkVerificationOtp({ email: email.trim().toLowerCase(), otp: code, type: 'sign-in' });
    setBusy(false);
    if (verifyError) {
      const msg = verifyError.message ?? '';
      if (verifyError.code === 'USER_NOT_FOUND') {
        // 邮箱尚未注册 → OTP 视为有效（这一步只能确认 OTP 一致性；最终注册由 sign-up 写库）
        setSignupOtpVerified(true);
        setNotice(copy.emailVerified);
        return;
      }
      setError(msg || copy.otpInvalid);
      return;
    }
    // 走到了：邮箱其实已注册，提示用户去登录
    setError(copy.emailRegisteredGoSignin);
  };

  // ---------- 密码登录 ----------
  const passwordSignIn = async () => {
    setBusy(true);
    setError(null);
    const { error: pwError } = await authClient.signIn.email({ email: email.trim().toLowerCase(), password });
    setBusy(false);
    if (pwError) {
      setError(pwError.message ?? copy.signinFail);
      return;
    }
    navigate(next, { replace: true });
  };

  // ---------- 注册：必须在 OTP 通过后才能提交 ----------
  const signupWithPassword = async () => {
    if (!signupOtpVerified) {
      setError(copy.signupVerifyEmailFirst);
      return;
    }
    setBusy(true);
    setError(null);
    // 昵称留空就直接注册：服务端会给「用户+随机编号」的默认昵称（不回退邮箱前缀）
    const { error: signErr } = await authClient.signUp.email({
      email: email.trim().toLowerCase(),
      password,
      name: name.trim(),
    });
    setBusy(false);
    if (signErr) {
      setError(signErr.message ?? copy.signupFail);
      return;
    }
    // 注册完成 → 自动登录
    setBusy(true);
    const { error: signInErr } = await authClient.signIn.email({ email: email.trim().toLowerCase(), password });
    setBusy(false);
    if (signInErr) {
      setMode('signin');
      setMethod('password');
      setNotice(copy.signupSuccessSignin);
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
      setError(oauthError.message ?? copy.oauthFail);
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

  const headingTitle = mode === 'signin' ? copy.signin : copy.signup;

  return (
    <main className="shell narrow">
      <header className="topbar">
        <button type="button" className="btn btn-ghost btn-sm" onClick={back}>{copy.back}</button>
        <h1 className="brand">{copy.brand}</h1>
        <button
          type="button"
          className="btn btn-sm btn-ghost lang-switch"
          aria-label={copy.langSwitchAria}
          onClick={() => setLanguage(language === 'zh' ? 'en' : 'zh')}
        >
          {language === 'zh' ? copy.languageSwitchToEn : copy.languageSwitchToZh}
        </button>
      </header>
      <section className="panel stack">
        <h2>{headingTitle}</h2>

        {/* ===== 登录：密码 / 验证码 双 tab ===== */}
        {mode === 'signin' && (
          <>
            <nav className="mode-tabs" aria-label={copy.signin}>
              <button
                type="button"
                className={'mode-tab' + (method === 'password' ? ' active' : '')}
                onClick={() => { setMethod('password'); setError(null); setStage('email'); }}
              >
                {copy.password}
              </button>
              <button
                type="button"
                className={'mode-tab' + (method === 'otp' ? ' active' : '')}
                onClick={() => { setMethod('otp'); setError(null); setStage('email'); }}
              >
                {copy.emailCode}
              </button>
            </nav>

            {method === 'password' && (
              <div className="stack">
                <label className="field-label" htmlFor="email-pw">
                  {copy.emailField}
                  <input
                    id="email-pw"
                    className="field"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </label>
                <label className="field-label" htmlFor="password">
                  {copy.password}
                  <input
                    id="password"
                    className="field"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
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
                  {copy.forgotPassword}？ <a href="/forgot-password">{copy.forgotPasswordLink}</a>
                </p>
              </div>
            )}

            {method === 'otp' && (
              <div className="stack">
                <label className="field-label" htmlFor="email-otp">
                  {copy.emailField}
                  <input
                    id="email-otp"
                    className="field"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </label>
                <button
                  className="btn btn-primary"
                  disabled={busy || sendWait > 0 || !email.includes('@')}
                  onClick={() => void sendCode('sign-in')}
                >
                  {sendLabel}
                </button>
              </div>
            )}

            {method === 'otp' && (
              <div className="stack">
                {notice && <p className="muted">{notice}</p>}
                <label className="field-label" htmlFor="code-otp">
                  {copy.emailCode}
                  <input
                    id="code-otp"
                    className="field"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                  />
                </label>
                <button
                  className="btn btn-primary"
                  disabled={busy || code.length < 4}
                  onClick={() => void verifyOtpForSignIn()}
                >
                  {copy.signIn}
                </button>
              </div>
            )}
          </>
        )}

        {/* ===== 注册：固定四步流程 ===== */}
        {mode === 'signup' && (
          <div className="stack">
            <label className="field-label" htmlFor="name-su">
              {copy.nickname}
              <input
                id="name-su"
                className="field"
                type="text"
                autoComplete="nickname"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>

            <label className="field-label" htmlFor="email-su">
              {copy.emailField}
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
              />
            </label>

            {!signupOtpVerified && (
              <button
                type="button"
                className="btn"
                disabled={busy || sendWait > 0 || !email.includes('@')}
                onClick={() => void sendCode('email-verification')}
              >
                {sendLabel}
              </button>
            )}

            {!signupOtpVerified && (
              <>
                <label className="field-label" htmlFor="code-su">
                  {copy.emailCode}
                  <input
                    id="code-su"
                    className="field"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                  />
                </label>
                <button
                  className="btn"
                  disabled={busy || code.length < 4}
                  onClick={() => void verifyOtpForSignup()}
                >
                  {copy.verifyEmail}
                </button>
              </>
            )}

            {signupOtpVerified && (
              <>
                <p className="ok-text">{copy.emailVerified}</p>
                <label className="field-label" htmlFor="password-su">
                  {copy.password}
                  <input
                    id="password-su"
                    className="field"
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </label>
                <button
                  className="btn btn-primary"
                  disabled={busy || password.length < 8}
                  onClick={() => void signupWithPassword()}
                >
                  {copy.signupAndLogin}
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
          <span className="muted">{copy.or}</span>
        </div>
        <button className="btn" onClick={() => void oauthSignIn('google')} disabled={busy}>
          {copy.googleLogin}
        </button>
        <button className="btn" onClick={() => void oauthSignIn('linuxdo')} disabled={busy}>
          {copy.linuxdoLogin}
        </button>

        {/* 模式切换：底部超链接 */}
        <p className="muted" style={{ textAlign: 'center', marginTop: 12 }}>
          {mode === 'signin' ? (
            <>{copy.noAccount} <a href="#" onClick={(e) => { e.preventDefault(); switchMode('signup'); }}>{copy.goSignup}</a></>
          ) : (
            <>{copy.haveAccount} <a href="#" onClick={(e) => { e.preventDefault(); switchMode('signin'); }}>{copy.goLogin}</a></>
          )}
        </p>
      </section>
    </main>
  );
}