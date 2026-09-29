/** 重置密码：从邮件链接进入（?token=…），设置新密码后回登录页；token 一次性、1 小时有效。 */
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { authClient } from '../api/auth-client.js';
import { useLanguage } from '../state/language.js';

export function ResetPasswordPage() {
  const { copy } = useLanguage();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (password !== confirm) {
      setError(copy.passwordMismatch);
      return;
    }
    setBusy(true);
    setError(null);
    const { error: resetError } = await authClient.resetPassword({ newPassword: password, token });
    setBusy(false);
    if (resetError) {
      setError(resetError.message ?? copy.resetFail);
      return;
    }
    navigate('/login?reset=1', { replace: true });
  };

  return (
    <main className="shell narrow">
      <header className="topbar">
        <h1 className="brand">{copy.brand}</h1>
      </header>
      <section className="panel stack">
        <h2>{copy.resetPasswordTitle}</h2>
        {!token ? (
          <>
            <p className="error-text">{copy.resetPasswordInvalid}</p>
            <button className="btn btn-primary" onClick={() => navigate('/forgot-password')}>
              {copy.reapply}
            </button>
          </>
        ) : (
          <>
            <label className="field-label" htmlFor="password-rp">
              {copy.newPassword}
              <input
                id="password-rp"
                className="field"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={copy.minChars}
              />
            </label>
            <label className="field-label" htmlFor="confirm-rp">
              {copy.confirmNewPassword}
              <input
                id="confirm-rp"
                className="field"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder={copy.confirmNewPasswordPlaceholder}
              />
            </label>
            <button
              className="btn btn-primary"
              disabled={busy || password.length < 8 || confirm.length < 8}
              onClick={() => void submit()}
            >
              {copy.resetPassword}
            </button>
          </>
        )}
        {error && <p className="error-text" role="alert">{error}</p>}
      </section>
    </main>
  );
}