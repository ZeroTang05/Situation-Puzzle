'use client';

import { useCallback, useEffect, useState } from 'react';

type ModerationSoup = { id: string; title: string; story: string; answer: string; hints: string[]; author_name: string; created_at: string; reviewed_at: string | null };
type ModerationView = 'unreviewed' | 'pending' | 'published' | 'rejected' | 'deleted';
const labels = {
  zh: { title: 'Jev 海龟汤 · 审核后台', intro: 'Jev 初审通过的投稿会公开；在这里复核内容并处理违规题目。', views: { unreviewed: '待复核', pending: '历史待审', published: '公开题目', rejected: '已驳回', deleted: '已删除' }, count: '当前列表共', items: '道题目', loadFailed: '题目加载失败，请刷新页面重试。', actionFailed: '审核操作失败', approved: '已通过复核。', removed: '题目已从公开题库下架。', loading: '正在读取题目…', author: '投稿人', story: '汤面', answer: '汤底（仅管理员可见）', hints: '提示', publish: '审核并发布', approve: '通过复核', reject: '下架', delete: '删除' },
  en: { title: 'Jev Situation Puzzles · Moderation', intro: 'Jev-approved submissions go live. Review them and remove inappropriate puzzles here.', views: { unreviewed: 'Needs review', pending: 'Legacy pending', published: 'Published', rejected: 'Rejected', deleted: 'Deleted' }, count: 'Puzzles in this list:', items: '', loadFailed: 'Could not load puzzles. Please refresh.', actionFailed: 'Moderation failed', approved: 'Review approved.', removed: 'Puzzle removed from the public library.', loading: 'Loading puzzles…', author: 'Author', story: 'Story', answer: 'Answer (admin only)', hints: 'Hints', publish: 'Review and publish', approve: 'Approve review', reject: 'Unpublish', delete: 'Delete' },
} as const;
const views: ModerationView[] = ['unreviewed', 'pending', 'published', 'rejected', 'deleted'];
/**
 * 审核后台：/admin 在 HTML 下发前完成 HTTP Basic 验证。
 * 页面和审核接口同源，浏览器会自动带上刚输入的管理员凭据。
 */
export default function AdminPage() {
  const [language, setLanguage] = useState<'zh' | 'en'>('zh');
  const t = labels[language];
  const [soups, setSoups] = useState<ModerationSoup[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(true);
  const [view, setView] = useState<ModerationView>('unreviewed');

  useEffect(() => {
    const frame = requestAnimationFrame(() => { if (localStorage.getItem('jev-language') === 'en') setLanguage('en'); });
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    let active = true;
    const load = async () => {
      const response = await fetch(`/admin/api/soups?status=${view}`, { credentials: 'same-origin' });
      if (!response.ok) throw new Error(`请求失败：${response.status}`);
      const body = await response.json() as { soups: ModerationSoup[] };
      if (active) {
        setSoups(body.soups);
        setMessage(`${t.count} ${body.soups.length} ${t.items}`);
      }
    };
    void load().catch((error) => {
      console.error(error);
      if (active) setMessage(t.loadFailed);
    }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [view, t.count, t.items, t.loadFailed]);

  const moderate = useCallback(async (soup: ModerationSoup, status: 'published' | 'rejected' | 'deleted') => {
    const response = await fetch(`/admin/api/soups/${encodeURIComponent(soup.id)}`, {
      method: status === 'deleted' ? 'DELETE' : 'PATCH',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: status === 'deleted' ? undefined : JSON.stringify({ status }),
    });
    if (!response.ok) throw new Error(t.actionFailed);
    setSoups((items) => status === 'published' && view === 'published'
      ? items.map((item) => item.id === soup.id ? { ...item, reviewed_at: new Date().toISOString() } : item)
      : items.filter((item) => item.id !== soup.id));
    setMessage(status === 'published' ? t.approved : t.removed);
  }, [view, t.actionFailed, t.approved, t.removed]);

  return (
    <main className="admin">
      <title>{language === 'en' ? 'Jev Moderation' : 'Jev 海龟汤 · 审核后台'}</title>
      <header><h1>{t.title}</h1><button className="language-switch" onClick={() => { const next = language === 'zh' ? 'en' : 'zh'; localStorage.setItem('jev-language', next); document.documentElement.lang = next === 'en' ? 'en' : 'zh-CN'; setLanguage(next); }}>{language === 'zh' ? 'EN' : 'ZH'}</button></header>
      <p>{t.intro}</p>
      <div className="admin-tabs">{views.map((item) => <button key={item} className={view === item ? 'active' : ''} onClick={() => { setView(item); setBusy(true); setMessage(''); }}>{t.views[item]}</button>)}</div>
      {busy && <p>{t.loading}</p>}
      {message && <p className="admin-message">{message}</p>}
      <section>
        {soups.map((soup) => (
          <article key={soup.id}>
            <header><strong>{soup.title}</strong><span>{t.author}: {soup.author_name}</span></header>
            <h2>{t.story}</h2><p>{soup.story}</p>
            <h2>{t.answer}</h2><p>{soup.answer}</p>
            <h2>{t.hints}</h2>{soup.hints.map((hint, index) => <p key={index}>{index + 1}. {hint}</p>)}
            {(view === 'unreviewed' || view === 'pending' || view === 'published') && <footer>
              {(view === 'pending' || !soup.reviewed_at) && <button onClick={() => moderate(soup, 'published')}>{view === 'pending' ? t.publish : t.approve}</button>}
              <button className="reject" onClick={() => moderate(soup, 'rejected')}>{t.reject}</button>
              <button className="delete" onClick={() => moderate(soup, 'deleted')}>{t.delete}</button>
            </footer>}
          </article>
        ))}
      </section>
    </main>
  );
}
