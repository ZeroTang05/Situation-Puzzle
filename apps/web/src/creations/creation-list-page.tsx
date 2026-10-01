/** 作者作品列表：发布进度与真实反馈，私有接口按当前账号隔离。 */
import { useQuery } from '@tanstack/react-query';
import { Link, Navigate } from 'react-router';
import { type CreationSummary } from '@jev/contracts';
import { api } from '../api/client.js';
import { useLanguage } from '../state/language.js';
import type { Session } from '../session.js';
import { creationCopy, creationStatusLabel } from './copy.js';

export function CreationListPage({ session }: { session: Session | null }) {
  const { language, copy } = useLanguage(); const text = creationCopy(language);
  const query = useQuery({ queryKey: ['creations', session?.user.id], queryFn: () => api<{ items: CreationSummary[] }>('/creations'), enabled: !!session, retry: false });
  if (!session) return <Navigate to="/login?next=%2Fcreations" replace />;
  return <main className="shell creation-shell">
    <header className="topbar">
      <Link className="btn btn-ghost btn-sm" to="/">{copy.back}</Link>
      <h1 className="brand brand-sm creation-title">{text.center}</h1>
      <Link className="btn btn-primary btn-sm" to="/creations/new">{text.create}</Link>
    </header>
    <h2 className="creation-section-title">{text.works}</h2>
    {query.isPending && <p role="status">{text.loading}</p>}
    {query.error && <p className="error-text" role="alert">{query.error.message}</p>}
    {query.data?.items.length === 0 && <section className="creation-empty"><p>{text.empty}</p><Link className="btn btn-primary" to="/creations/new">{text.create}</Link></section>}
    <ul className="creation-list">{query.data?.items.map((work) => <li key={work.puzzleId} className="creation-item">
      <div className="creation-item-main">
        <Link className="creation-item-title" to={`/creations/${work.puzzleId}`}>{work.title}</Link>
        <div className="creation-item-meta">
          <span className={`creation-status-dot status-${work.status}`} aria-label={creationStatusLabel(work.status, language)} />
          <span className="muted">{creationStatusLabel(work.status, language)}</span>
          <span className="dot" aria-hidden>·</span>
          <span className="muted">v{work.versionNo}</span>
          <span className="dot" aria-hidden>·</span>
          <span className="muted">{work.language === 'en' ? copy.languageEn : copy.languageZh}</span>
          <span className="dot" aria-hidden>·</span>
          <span className="muted">👍 {work.upCount}</span>
          <span className="dot" aria-hidden>·</span>
          <span className="muted">👎 {work.downCount}</span>
          <span className="dot" aria-hidden>·</span>
          <span className="muted">{new Date(work.updatedAt).toLocaleDateString(language === 'zh' ? 'zh-CN' : 'en-US')}</span>
        </div>
        {work.pendingName && <div className="creation-item-pending muted">{text.pendingName}：{work.pendingName}</div>}
      </div>
      <div className="creation-item-actions">
        <Link className="creation-item-link" to={`/creations/${work.puzzleId}`}>{text.edit}</Link>
        {work.published && <Link className="creation-item-link" to={`/solo/${work.puzzleId}?lang=${work.publishedLanguage}`}>{text.public}</Link>}
      </div>
    </li>)}</ul>
  </main>;
}