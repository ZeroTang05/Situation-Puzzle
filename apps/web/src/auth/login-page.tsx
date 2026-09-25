/** 登录页：邮箱验证码为主入口，Google 为第二入口（docs/rebuild/05-OPERATIONS.md §2）。 */
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { authClient } from '../api/auth-client.js';
import { useLanguage } from '../state/language.js';

export function LoginPage() {
  const { copy } = useLanguage();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get('next') ?? '/';

  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'email' | 'code'>('email');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sendCode = async () => {
    setBusy(true);
    setError(null);
    const { error: sendError } = await authClient.emailOtp.sendVerificationOtp({ email, type: 'sign-in' });
    setBusy(false);
    if (sendError) {
      setError(sendError.message ?? '验证码发送失败，请稍后再试');
      return;
    }
    setStage('code');
    setNotice(copy.codeSent);
  };

  const verify = async () => {
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

  const google = () => {
    // 回调后回到原页面
    window.location.href = `/api/v1/auth/signin/social?provider=google&callbackURL=${encodeURIComponent(next)}`;
  };

  return (
    <main className="shell narrow">
      <header className="topbar">
        <h1 className="brand">{copy.brand}</h1>
      </header>
      <section className="panel stack">
        <h2>{copy.login}</h2>
        {stage === 'email' ? (
          <div className="stack">
            <label className="field-label" htmlFor="email">
              Email
              <input
                id="email"
                className="field"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </label>
            <button className="btn btn-primary" disabled={busy || !email.includes('@')} onClick={() => void sendCode()}>
              {copy.sendCode}
            </button>
          </div>
        ) : (
          <div className="stack">
            <p className="muted">{notice}</p>
            <label className="field-label" htmlFor="code">
              Code
              <input
                id="code"
                className="field"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="000000"
              />
            </label>
            <button className="btn btn-primary" disabled={busy || code.length < 4} onClick={() => void verify()}>
              {copy.login}
            </button>
          </div>
        )}
        {error && <p className="error-text" role="alert">{error}</p>}
        <div className="divider">
          <span className="muted">或</span>
        </div>
        <button className="btn" onClick={google} disabled={busy}>
          {copy.googleLogin}
        </button>
      </section>
    </main>
  );
}
