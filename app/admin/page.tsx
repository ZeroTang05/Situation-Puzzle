'use client';

import { useCallback, useEffect, useState } from 'react';

type ModerationSoup = { id: string; title: string; story: string; answer: string; hints: string[]; author_name: string; created_at: string; reviewed_at: string | null };
type ModerationView = 'unreviewed' | 'pending' | 'published' | 'rejected' | 'deleted';
const views: { id: ModerationView; label: string }[] = [
  { id: 'unreviewed', label: '待复核' },
  { id: 'pending', label: '历史待审' },
  { id: 'published', label: '公开题目' },
  { id: 'rejected', label: '已驳回' },
  { id: 'deleted', label: '已删除' },
];
/**
 * 审核后台：/admin 在 HTML 下发前完成 HTTP Basic 验证。
 * 页面和审核接口同源，浏览器会自动带上刚输入的管理员凭据。
 */
export default function AdminPage() {
  const [soups, setSoups] = useState<ModerationSoup[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(true);
  const [view, setView] = useState<ModerationView>('unreviewed');

  useEffect(() => {
    let active = true;
    const load = async () => {
      const response = await fetch(`/admin/api/soups?status=${view}`, { credentials: 'same-origin' });
      if (!response.ok) throw new Error(`请求失败：${response.status}`);
      const body = await response.json() as { soups: ModerationSoup[] };
      if (active) {
        setSoups(body.soups);
        setMessage(`当前列表共 ${body.soups.length} 道题目`);
      }
    };
    void load().catch((error) => {
      console.error(error);
      if (active) setMessage('题目加载失败，请刷新页面重试。');
    }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [view]);

  const moderate = useCallback(async (soup: ModerationSoup, status: 'published' | 'rejected' | 'deleted') => {
    const response = await fetch(`/admin/api/soups/${encodeURIComponent(soup.id)}`, {
      method: status === 'deleted' ? 'DELETE' : 'PATCH',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: status === 'deleted' ? undefined : JSON.stringify({ status }),
    });
    if (!response.ok) throw new Error('审核操作失败');
    setSoups((items) => status === 'published' && view === 'published'
      ? items.map((item) => item.id === soup.id ? { ...item, reviewed_at: new Date().toISOString() } : item)
      : items.filter((item) => item.id !== soup.id));
    setMessage(status === 'published' ? '已通过复核。' : '题目已从公开题库下架。');
  }, [view]);

  return (
    <main className="admin">
      <h1>Jev 海龟汤 · 审核后台</h1>
      <p>Jev 初审通过的投稿会公开；在这里复核内容并处理违规题目。</p>
      <div className="admin-tabs">{views.map((item) => <button key={item.id} className={view === item.id ? 'active' : ''} onClick={() => { setView(item.id); setBusy(true); setMessage(''); }}>{item.label}</button>)}</div>
      {busy && <p>正在读取题目…</p>}
      {message && <p className="admin-message">{message}</p>}
      <section>
        {soups.map((soup) => (
          <article key={soup.id}>
            <header><strong>{soup.title}</strong><span>投稿人：{soup.author_name}</span></header>
            <h2>汤面</h2><p>{soup.story}</p>
            <h2>汤底（仅管理员可见）</h2><p>{soup.answer}</p>
            <h2>提示</h2>{soup.hints.map((hint, index) => <p key={index}>{index + 1}. {hint}</p>)}
            {(view === 'unreviewed' || view === 'pending' || view === 'published') && <footer>
              {(view === 'pending' || !soup.reviewed_at) && <button onClick={() => moderate(soup, 'published')}>{view === 'pending' ? '审核并发布' : '通过复核'}</button>}
              <button className="reject" onClick={() => moderate(soup, 'rejected')}>下架</button>
              <button className="delete" onClick={() => moderate(soup, 'deleted')}>删除</button>
            </footer>}
          </article>
        ))}
      </section>
    </main>
  );
}
