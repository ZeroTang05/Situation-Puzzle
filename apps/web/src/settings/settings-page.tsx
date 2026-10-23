/**
 * 设置页：个人资料（昵称）、界面语言、退出登录。
 *
 * 语言切换只在这里和登录/注册页开放；改完立刻写进 localStorage，
 * 并由每个请求的 X-Jev-Language 头上报给服务端（服务端据此分流邮件语言）。
 */
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useDialog } from '@jev/ui';
import { api, translateApiError } from '../api/client.js';
import { signOut } from '../api/auth-client.js';
import { useLanguage } from '../state/language.js';
import { clearRoomLocal } from '../rooms/room-local.js';
import { useBack } from '../back.js';
import type { Language } from '@jev/i18n';

interface MeResponse {
  userId: string;
  nickname: string;
  email: string;
}

export function SettingsPage() {
  const { copy, language, setLanguage } = useLanguage();
  const navigate = useNavigate();
  const back = useBack('/me');
  const dialog = useDialog();
  const queryClient = useQueryClient();

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const me = useQuery({ queryKey: ['me'], queryFn: () => api<MeResponse>('/me'), retry: false });

  const startEdit = () => {
    setDraft(me.data?.nickname ?? '');
    setError(null);
    setNotice(null);
    setEditing(true);
  };

  const saveNickname = async () => {
    const nickname = draft.trim();
    if (nickname.length === 0 || saving) return;
    setSaving(true);
    setError(null);
    try {
      await api<{ nickname: string }>('/me/nickname', { method: 'PATCH', body: { nickname } });
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      setEditing(false);
      setNotice(copy.nicknameUpdated);
    } catch (err) {
      setError(translateApiError(err, language, copy.saveFail));
    } finally {
      setSaving(false);
    }
  };

  /** 退出登录走二次确认，避免误触；本地多人草稿一并清掉。 */
  const logout = async () => {
    if (!(await dialog.confirm(copy.logoutConfirm, copy.logout))) return;
    const userId = me.data?.userId;
    if (userId) await clearRoomLocal(userId);
    await signOut();
    queryClient.clear();
    navigate('/');
  };

  const pickLanguage = (next: Language) => {
    if (next === language) return;
    setLanguage(next);
  };

  return (
    <main className="shell narrow">
      <header className="topbar topbar-title">
        <button className="btn btn-ghost btn-sm" onClick={back}>{copy.back}</button>
        <h1 className="brand brand-sm">{copy.settingsTitle}</h1>
      </header>

      {/* 个人资料：昵称可改，邮箱只读 */}
      <section className="panel stack">
        <h3>{copy.settingsProfile}</h3>
        <div className="settings-row">
          <span className="muted">{copy.nickname}</span>
          {!editing ? (
            <span className="settings-value">
              {me.data?.nickname ?? (me.isPending ? '…' : '—')}
              <button className="btn btn-ghost btn-sm" onClick={startEdit}>{copy.modify}</button>
            </span>
          ) : (
            <span className="settings-value" />
          )}
        </div>

        {editing && (
          <form className="me-edit" onSubmit={(e) => { e.preventDefault(); void saveNickname(); }}>
            <label className="field-label" htmlFor="settings-nickname">
              <span className="muted">{copy.nickname}</span>
              <input id="settings-nickname" className="field" type="text" value={draft} maxLength={30} autoFocus onChange={(e) => setDraft(e.target.value)} />
              <span className="field-help muted">{copy.nicknameRule}</span>
            </label>
            <div className="me-edit-actions">
              <button type="submit" className="btn btn-sm btn-primary" disabled={saving || draft.trim().length === 0}>{saving ? copy.submitting : copy.saved}</button>
              <button type="button" className="btn btn-sm" disabled={saving} onClick={() => setEditing(false)}>{copy.cancelEdit}</button>
            </div>
          </form>
        )}

        <div className="settings-row">
          <span className="muted">{copy.emailField}</span>
          <span className="settings-value">{me.data?.email ?? '—'}</span>
        </div>

        {error && <p className="error-text" role="alert">{error}</p>}
        {notice && <p className="ok-text" role="status">{notice}</p>}
        {me.isError && (
          <p className="error-text" role="alert">{translateApiError(me.error, language, copy.accountLoadFail)}</p>
        )}
      </section>

      {/* 界面语言：与登录页并列的两个入口 */}
      <section className="panel stack">
        <h3>{copy.settingsLanguage}</h3>
        <div className="settings-lang" role="group" aria-label={copy.settingsLanguage}>
          <button
            type="button"
            className={`btn btn-sm${language === 'zh' ? ' btn-primary' : ''}`}
            aria-pressed={language === 'zh'}
            onClick={() => pickLanguage('zh')}
          >
            {copy.languageChinese}
          </button>
          <button
            type="button"
            className={`btn btn-sm${language === 'en' ? ' btn-primary' : ''}`}
            aria-pressed={language === 'en'}
            onClick={() => pickLanguage('en')}
          >
            {copy.languageEnglish}
          </button>
        </div>
      </section>

      {/* 账号：退出登录 */}
      <section className="panel stack">
        <h3>{copy.settingsAccount}</h3>
        <button className="btn me-logout" onClick={() => void logout()}>{copy.logout}</button>
      </section>
    </main>
  );
}
