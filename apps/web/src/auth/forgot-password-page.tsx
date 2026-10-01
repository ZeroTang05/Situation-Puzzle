/** 忘记密码：输入注册邮箱 → 发送重置邮件；成功后只展示统一提示（防账号枚举）。 */
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { authClient } from '../api/auth-client.js';
import { useLanguage } from '../state/language.js';
import { useBack } from '../back.js';

export function ForgotPasswordPage() {
  const { copy, language, setLanguage } = useLanguage();
  const navigate = useNavigate();
  const back = useBack('/login');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const { error: resetError } = await authClient.requestPasswordReset({
      email,
      // 重置邮件里的链接落回本站的重置页
      redirectTo: `${location.origin}/reset-password`,
    });
    setBusy(false);
    if (resetError) {
      setError(resetError.message ?? copy.sendCodeFail);
      return;
    }
    setSent(true);
  };

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
        <h2>{copy.forgotPasswordTitle}</h2>
        {sent ? (
          <>
            <p className="muted">{copy.resetEmailSent}</p>
            <button className="btn btn-primary" onClick={() => navigate('/login')}>
              {copy.backToLogin}
            </button>
          </>
        ) : (
          <>
            <p className="muted">{copy.forgotPasswordPrompt}</p>
            <label className="field-label" htmlFor="email-fp">
              {copy.emailField}
              <input
                id="email-fp"
                className="field"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <button
              className="btn btn-primary"
              disabled={busy || !email.includes('@')}
              onClick={() => void submit()}
            >
              {copy.sendResetEmail}
            </button>
            <p className="muted" style={{ textAlign: 'center' }}>
              {copy.rememberPassword} <a href="/login">{copy.goLogin}</a>
            </p>
          </>
        )}
        {error && <p className="error-text" role="alert">{error}</p>}
      </section>
    </main>
  );
}