'use client';

import { useCallback, useState } from 'react';

type ModerationSoup = { id: string; title: string; story: string; answer: string; hints: string[]; author_name: string; created_at: string };
const api = process.env.NEXT_PUBLIC_API_URL;

/**
 * 审核后台：浏览器原生 HTTP Basic 登录。
 * 点按钮 → 浏览器顶部弹登录框（由 Worker 返回 401 + WWW-Authenticate 触发）→
 * 用户输入 ADMIN_TOKEN → 浏览器缓存凭据到 Worker 来源 → 之后所有 fetch 自动带上。
 * 无 Cookie、无 sessionStorage、刷新仍登录（直到关闭浏览器）。
 */
export default function AdminPage() {
  const [soups, setSoups] = useState<ModerationSoup[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!api) throw new Error('缺少 NEXT_PUBLIC_API_URL');
    setBusy(true);
    try {
      const response = await fetch(`${api}/api/admin/soups?status=pending`, { credentials: 'include' });
      if (response.status === 401) {
        setSoups([]);
        setMessage('未通过认证：请在浏览器顶部的登录框中输入管理员密码。');
        return;
      }
      if (!response.ok) throw new Error(`请求失败：${response.status}`);
      const body = await response.json() as { soups: ModerationSoup[] };
      setSoups(body.soups);
      setMessage(`共有 ${body.soups.length} 道待审核题目`);
    } finally {
      setBusy(false);
    }
  }, []);

  const moderate = useCallback(async (soup: ModerationSoup, status: 'published' | 'rejected' | 'deleted') => {
    if (!api) throw new Error('缺少 NEXT_PUBLIC_API_URL');
    const response = await fetch(`${api}/api/admin/soups/${soup.id}`, {
      method: status === 'deleted' ? 'DELETE' : 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: status === 'deleted' ? undefined : JSON.stringify({ status }),
    });
    if (response.status === 401) {
      setMessage('会话已失效，请在浏览器顶部的登录框中重新输入管理员密码。');
      return;
    }
    if (!response.ok) throw new Error('审核操作失败');
    setSoups((items) => items.filter((item) => item.id !== soup.id));
    setMessage(status === 'published' ? '已公开，题目会进入推荐题库。' : '已从待审核列表移除。');
  }, []);

  return (
    <main className="admin">
      <h1>Jev 海龟汤 · 审核后台</h1>
      <p>在这里审核玩家投稿，发布后题目才会进入公开推荐。</p>
      <p className="admin-hint">
        首次打开会触发浏览器顶部的原生登录框，输入管理员密码即可；
        浏览器会为你缓存，无需再次输入直到关闭浏览器。
      </p>
      <button onClick={load} disabled={busy}>{busy ? '加载中…' : '查看待审核题目'}</button>
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