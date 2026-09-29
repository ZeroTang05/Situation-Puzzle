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
    <header className="topbar"><Link className="btn btn-ghost btn-sm" to="/">{copy.back}</Link><h1 className="brand brand-sm">{text.center}</h1><Link className="btn btn-primary btn-sm" to="/creations/new">{text.create}</Link></header>
    <h2>{text.works}</h2>
    {query.isPending && <p role="status">{text.loading}</p>}
    {query.error && <p className="error-text" role="alert">{query.error.message}</p>}
    {query.data?.items.length === 0 && <section className="creation-empty"><p>{text.empty}</p><Link className="btn btn-primary" to="/creations/new">{text.create}</Link></section>}
    <div className="creation-list">{query.data?.items.map((work) => <article key={work.puzzleId} className="creation-row">
      <div><span className={`creation-status status-${work.status}`}>{creationStatusLabel(work.status, language)}</span><span className="muted">{text.version} {work.versionNo} · {work.language === 'en' ? copy.languageEn : copy.languageZh}</span></div>
      <Link to={`/creations/${work.puzzleId}`}><h3>{work.title}</h3></Link>
      <p className="muted">👍 {work.upCount}　👎 {work.downCount}　{text.feedback} {work.popularityScore}</p>
      {work.pendingName && <p className="muted">{text.pendingName}：{work.pendingName}</p>}
      <div className="hint-row"><Link className="btn btn-sm" to={`/creations/${work.puzzleId}`}>{text.edit}</Link>{work.published && <Link className="btn btn-sm btn-ghost" to={`/solo/${work.puzzleId}?lang=${work.publishedLanguage}`}>{text.public}</Link>}</div>
    </article>)}</div>
  </main>;
}