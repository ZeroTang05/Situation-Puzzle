/** 忘记密码：输入注册邮箱 → 发送重置邮件；成功后只展示统一提示（防账号枚举）。 */
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { authClient } from '../api/auth-client.js';
import { useLanguage } from '../state/language.js';

export function ForgotPasswordPage() {
  const { copy } = useLanguage();
  const navigate = useNavigate();
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
      setError(resetError.message ?? '重置邮件发送失败，请稍后再试');
      return;
    }
    setSent(true);
  };

  return (
    <main className="shell narrow">
      <header className="topbar">
        <h1 className="brand">{copy.brand}</h1>
      </header>
      <section className="panel stack">
        <h2>找回密码</h2>
        {sent ? (
          <>
            <p className="muted">重置邮件已发送，请到邮箱里点击链接设置新密码（1 小时内有效）。</p>
            <button className="btn btn-primary" onClick={() => navigate('/login')}>
              返回登录
            </button>
          </>
        ) : (
          <>
            <p className="muted">输入注册邮箱，我们会发送重置密码的链接。</p>
            <label className="field-label" htmlFor="email-fp">
              Email
              <input
                id="email-fp"
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
              onClick={() => void submit()}
            >
              发送重置邮件
            </button>
            <p className="muted" style={{ textAlign: 'center' }}>
              想起密码了？<a href="/login">去登录</a>
            </p>
          </>
        )}
        {error && <p className="error-text" role="alert">{error}</p>}
      </section>
    </main>
  );
}
