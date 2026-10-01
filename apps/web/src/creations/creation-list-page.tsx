/** 作者作品列表：状态筛选、发布进度与真实反馈，私有接口按当前账号隔离。 */
import { useQuery } from '@tanstack/react-query';
import { Link, Navigate } from 'react-router';
import { useState } from 'react';
import { type CreationSummary } from '@jev/contracts';
import { api, translateApiError } from '../api/client.js';
import { useLanguage } from '../state/language.js';
import { useBack } from '../back.js';
import { compactVoteCount } from '../catalog/vote-count.js';
import type { Session } from '../session.js';
import { creationCopy, creationStatusLabel } from './copy.js';

/** 筛选分桶：草稿单独一类；已发布含被下架（卡片上仍有状态标签）；其余都算审核流程中。 */
type WorkFilter = 'all' | 'draft' | 'review' | 'published';

function bucketOf(work: CreationSummary): Exclude<WorkFilter, 'all'> {
  if (work.status === 'draft') return 'draft';
  if (work.status === 'published' || work.status === 'taken_down') return 'published';
  return 'review';
}

export function CreationListPage({ session }: { session: Session | null }) {
  const { language, copy } = useLanguage(); const text = creationCopy(language);
  const back = useBack('/');
  const [filter, setFilter] = useState<WorkFilter>('all');
  const query = useQuery({ queryKey: ['creations', session?.user.id], queryFn: () => api<{ items: CreationSummary[] }>('/creations'), enabled: !!session, retry: false });
  if (!session) return <Navigate to="/login?next=%2Fcreations" replace />;

  const items = query.data?.items ?? [];
  const counts = { all: items.length, draft: 0, review: 0, published: 0 };
  for (const work of items) counts[bucketOf(work)] += 1;
  const visible = filter === 'all' ? items : items.filter((work) => bucketOf(work) === filter);
  // 只有存在两种以上状态时筛选才有意义，单个状态时隐藏避免噪音
  const showFilter = new Set(items.map(bucketOf)).size >= 2;
  const filters: Array<{ key: WorkFilter; label: string }> = [
    { key: 'all', label: text.filterAll },
    { key: 'draft', label: text.filterDrafts },
    { key: 'review', label: text.filterReview },
    { key: 'published', label: text.filterPublished },
  ];

  return <main className="shell creation-shell">
    <header className="topbar">
      <button className="btn btn-ghost btn-sm" onClick={back}>{copy.back}</button>
      <h1 className="brand brand-sm creation-title">{text.center}</h1>
      <Link className="btn btn-primary btn-sm" to="/creations/new">{text.create}</Link>
    </header>

    <h2 className="creation-section-title">{text.works}</h2>
    {showFilter && (
      <div className="mode-tabs" role="tablist" aria-label={text.works}>
        {filters.map(({ key, label }) => (
          <button key={key} className={`mode-tab ${filter === key ? 'active' : ''}`} role="tab" aria-selected={filter === key} onClick={() => setFilter(key)}>
            {label}<span className="mode-tab-count">{counts[key]}</span>
          </button>
        ))}
      </div>
    )}

    {query.isPending && <p className="muted" role="status">{text.loading}</p>}
    {query.isError && (
      <div className="creation-load-error">
        <p className="error-text" role="alert">{translateApiError(query.error, language, text.loadFail)}</p>
        <button className="btn btn-ghost btn-sm" onClick={() => void query.refetch()}>{copy.retry}</button>
      </div>
    )}
    {query.isSuccess && items.length === 0 && (
      <section className="creation-empty">
        <span className="creation-empty-icon" aria-hidden>🐢</span>
        <p>{text.empty}</p>
        <Link className="btn btn-primary" to="/creations/new">{text.create}</Link>
      </section>
    )}
    {showFilter && visible.length === 0 && <p className="muted creation-filter-empty">{text.filterEmpty}</p>}

    {/* 整卡是编辑入口（拉伸链接铺满卡片）；游玩按钮浮在上层，避免 <a> 嵌套 */}
    <ul className="creation-works">{visible.map((work) => <li key={work.puzzleId} className="creation-work">
      <Link className="creation-work-main" to={`/creations/${work.puzzleId}`} aria-label={`${text.edit}：${work.title}`}>
        <h3 className="creation-work-title">{work.title}</h3>
        <div className="creation-item-meta">
          <span className={`creation-status-dot status-${work.status}`} aria-label={creationStatusLabel(work.status, language)} />
          <span className="muted">{creationStatusLabel(work.status, language)}</span>
          <span className="dot" aria-hidden>·</span>
          <span className="muted">v{work.versionNo}</span>
          <span className="dot" aria-hidden>·</span>
          <span className="muted">{work.language === 'en' ? copy.languageEn : copy.languageZh}</span>
          <span className="dot" aria-hidden>·</span>
          <span className="muted" aria-label={`${copy.voteUp} ${work.upCount}`}>👍 {compactVoteCount(work.upCount)}</span>
          <span className="dot" aria-hidden>·</span>
          <span className="muted" aria-label={`${copy.voteDown} ${work.downCount}`}>👎 {compactVoteCount(work.downCount)}</span>
          <span className="dot" aria-hidden>·</span>
          <span className="muted">{new Date(work.updatedAt).toLocaleDateString(language === 'zh' ? 'zh-CN' : 'en-US')}</span>
        </div>
        {work.pendingName && <div className="creation-item-pending">{text.pendingName}{language === 'zh' ? '：' : ': '}{work.pendingName}</div>}
      </Link>
      {work.published && <Link className="btn btn-sm creation-item-btn creation-item-btn-play" to={`/solo/${work.puzzleId}?lang=${work.publishedLanguage}`} title={text.public}>{text.playShort}</Link>}
    </li>)}</ul>
  </main>;
}
