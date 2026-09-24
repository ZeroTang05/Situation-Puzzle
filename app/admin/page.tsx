'use client';

import { useCallback, useEffect, useState } from 'react';

type ModerationSoup = { id: string; title: string; story: string; answer: string; hints: string[]; author_name: string; created_at: string };
/**
 * 审核后台：/admin 在 HTML 下发前完成 HTTP Basic 验证。
 * 页面和审核接口同源，浏览器会自动带上刚输入的管理员凭据。
 */
export default function AdminPage() {
  const [soups, setSoups] = useState<ModerationSoup[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    let active = true;
    const load = async () => {
      const response = await fetch('/admin/api/soups?status=pending', { credentials: 'same-origin' });
      if (!response.ok) throw new Error(`请求失败：${response.status}`);
      const body = await response.json() as { soups: ModerationSoup[] };
      if (active) {
        setSoups(body.soups);
        setMessage(`共有 ${body.soups.length} 道待审核题目`);
      }
    };
    void load().catch((error) => {
      console.error(error);
      if (active) setMessage('待审核题目加载失败，请刷新页面重试。');
    }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, []);

  const moderate = useCallback(async (soup: ModerationSoup, status: 'published' | 'rejected' | 'deleted') => {
    const response = await fetch(`/admin/api/soups/${encodeURIComponent(soup.id)}`, {
      method: status === 'deleted' ? 'DELETE' : 'PATCH',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: status === 'deleted' ? undefined : JSON.stringify({ status }),
    });
    if (!response.ok) throw new Error('审核操作失败');
    setSoups((items) => items.filter((item) => item.id !== soup.id));
    setMessage(status === 'published' ? '已公开，题目会进入推荐题库。' : '已从待审核列表移除。');
  }, []);

  return (
    <main className="admin">
      <h1>Jev 海龟汤 · 审核后台</h1>
      <p>在这里审核玩家投稿，发布后题目才会进入公开推荐。</p>
      {busy && <p>正在读取待审核题目…</p>}
      {message && <p className="admin-message">{message}</p>}
      <section>
        {soups.map((soup) => (
          <article key={soup.id}>
            <header><strong>{soup.title}</strong><span>投稿人：{soup.author_name}</span></header>
            <h2>汤面</h2><p>{soup.story}</p>
            <h2>汤底（仅管理员可见）</h2><p>{soup.answer}</p>
            <h2>提示</h2>{soup.hints.map((hint, index) => <p key={index}>{index + 1}. {hint}</p>)}
            <footer>
              <button onClick={() => moderate(soup, 'published')}>发布到公开题库</button>
              <button className="reject" onClick={() => moderate(soup, 'rejected')}>驳回</button>
              <button className="delete" onClick={() => moderate(soup, 'deleted')}>删除</button>
            </footer>
          </article>
        ))}
      </section>
    </main>
  );
}
