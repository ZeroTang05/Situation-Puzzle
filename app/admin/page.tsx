'use client';

import { FormEvent, useState } from 'react';

type ModerationSoup = { id: string; title: string; story: string; answer: string; hints: string[]; author_name: string; created_at: string };
const api = process.env.NEXT_PUBLIC_API_URL;

/** 运营后台：管理员输入只保存在当前标签页内的 Worker 管理令牌。 */
export default function AdminPage() {
  const [token, setToken] = useState(''); const [soups, setSoups] = useState<ModerationSoup[]>([]); const [message, setMessage] = useState('');
  async function load(event: FormEvent) { event.preventDefault(); if (!api) throw new Error('缺少 NEXT_PUBLIC_API_URL'); const response = await fetch(`${api}/api/admin/soups?status=pending`, { headers: { Authorization: `Bearer ${token}` } }); if (!response.ok) throw new Error('令牌无效或 Worker 未响应'); const body = await response.json() as { soups: ModerationSoup[] }; setSoups(body.soups); setMessage(`共有 ${body.soups.length} 道待审核题目`); }
  async function moderate(soup: ModerationSoup, status: 'published' | 'rejected' | 'deleted') { if (!api) throw new Error('缺少 NEXT_PUBLIC_API_URL'); const response = await fetch(`${api}/api/admin/soups/${soup.id}`, { method: status === 'deleted' ? 'DELETE' : 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: status === 'deleted' ? undefined : JSON.stringify({ status }) }); if (!response.ok) throw new Error('审核操作失败'); setSoups((items) => items.filter((item) => item.id !== soup.id)); setMessage(status === 'published' ? '已公开，题目会进入推荐题库。' : '已从待审核列表移除。'); }
  return <main className="admin"><h1>Jev 海龟汤 · 审核后台</h1><p>在这里审核玩家投稿，发布后题目才会进入公开推荐。</p><form onSubmit={load}><input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="管理员令牌" required /><button>查看待审核题目</button></form>{message && <p className="admin-message">{message}</p>}<section>{soups.map((soup) => <article key={soup.id}><header><strong>{soup.title}</strong><span>投稿人：{soup.author_name}</span></header><h2>汤面</h2><p>{soup.story}</p><h2>汤底（仅管理员可见）</h2><p>{soup.answer}</p><h2>提示</h2>{soup.hints.map((hint, index) => <p key={index}>{index + 1}. {hint}</p>)}<footer><button onClick={() => moderate(soup, 'published')}>发布到公开题库</button><button className="reject" onClick={() => moderate(soup, 'rejected')}>驳回</button><button className="delete" onClick={() => moderate(soup, 'deleted')}>删除</button></footer></article>)}</section></main>;
}
