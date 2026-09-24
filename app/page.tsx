'use client';

import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import library from '../data/library.json';

type Verdict = '是' | '否' | '无关' | '无法确定';
type Outcome = '破解成功' | '接近真相' | '还没猜对' | '无法确定';
type Soup = { id: string; title: string; story: string; answer?: string; hints: string[]; author_name?: string; remote?: boolean; creatorToken?: string };
type Message = { role: 'user' | 'jev'; text: string; verdict?: Verdict; confidence?: number };
/** 还原真相模式的临时对话：玩家提交 + Jev 的结局判定（判断失败时只有 text） */
type SolveEntry = { role: 'user' | 'jev'; text?: string; outcome?: Outcome; confidence?: number };
type ProgressItem = { soup_id: string; title: string; question_count: number; last_outcome: Outcome | null; solved_at: string | null; last_played_at: string };
type Progress = { personal: boolean; total: number; attempted: number; solved: number; soups: ProgressItem[] };

// 内置题库与 worker 种子共用 data/library.json；离线模式（未配置 NEXT_PUBLIC_API_URL）完全靠它运行
const SOUPS: Soup[] = library.map((soup) => ({ ...soup }));
const PUBLIC_API = process.env.NEXT_PUBLIC_API_URL;
const PLATFORM_SESSION_KEY = 'jev-platform-session';

function encodeSoup(soup: Soup) { return btoa(unescape(encodeURIComponent(JSON.stringify(soup)))); }
function decodeSoup(value: string): Soup | null { try { return JSON.parse(decodeURIComponent(escape(atob(value)))) as Soup; } catch { return null; } }

export default function Home() {
  const [soups, setSoups] = useState(SOUPS);
  const [currentId, setCurrentId] = useState(SOUPS[0].id);
  const [messages, setMessages] = useState<Message[]>([]);
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [showAnswer, setShowAnswer] = useState(false);
  const [revealedAnswer, setRevealedAnswer] = useState<string | null>(null);
  const [confirmingAnswer, setConfirmingAnswer] = useState(false);
  const [revealedHints, setRevealedHints] = useState(0);
  const [hintView, setHintView] = useState(0);
  const [view, setView] = useState<'play' | 'library' | 'create' | 'progress'>('play');
  const [notice, setNotice] = useState('');
  const [userToken, setUserToken] = useState<string | null>(null);
  const [authReady, setAuthReady] = useState(!PUBLIC_API);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [solveOpen, setSolveOpen] = useState(false);
  const [solveThread, setSolveThread] = useState<SolveEntry[]>([]);
  const chatRef = useRef<HTMLDivElement>(null);
  const solveRef = useRef<HTMLDivElement>(null);
  const identityStarted = useRef(false);
  const soup = useMemo(() => soups.find((item) => item.id === currentId) ?? soups[0], [soups, currentId]);

  useEffect(() => { chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight }); }, [messages, loading, showAnswer]);
  useEffect(() => { solveRef.current?.scrollTo({ top: solveRef.current.scrollHeight }); }, [solveThread, loading]);

  useEffect(() => {
    if (!confirmingAnswer) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setConfirmingAnswer(false); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [confirmingAnswer]);

  useEffect(() => {
    const shared = new URLSearchParams(window.location.search).get('soup');
    if (!shared) return;
    const imported = decodeSoup(shared);
    if (imported) { setSoups((items) => [imported, ...items.filter((item) => item.id !== imported.id)]); setCurrentId(imported.id); setNotice('已打开朋友分享的海龟汤'); }
  }, []);

  useEffect(() => {
    if (!PUBLIC_API || identityStarted.current) return;
    identityStarted.current = true;
    fetch(`${PUBLIC_API}/api/soups`).then(async (response) => {
      if (!response.ok) throw new Error('公开题库加载失败');
      const data = await response.json() as { soups: Soup[] };
      setSoups((items) => {
        const remote = data.soups.map((item) => ({ ...item, remote: true }));
        // 同名题目只保留线上版本：汤底不进浏览器，判题走服务端
        const remoteTitles = new Set(remote.map((item) => item.title.trim()));
        return [...remote, ...items.filter((item) => !remoteTitles.has(item.title.trim()))];
      });
    }).catch((error) => { console.error(error); setNotice('公开题库加载失败，请刷新页面重试。'); });
    // 小程序壳把一次性 code 放进 WebView URL；读取后立即从地址栏移除。
    const url = new URL(window.location.href);
    const platform = url.searchParams.get('platform');
    const code = url.searchParams.get('login_code');
    if (platform || code) { url.searchParams.delete('platform'); url.searchParams.delete('login_code'); window.history.replaceState(null, '', url); }
    const endpoint = platform === 'bilibili' || platform === 'xiaohongshu' ? platform : 'anonymous';
    if (platform && endpoint === 'anonymous') { setNotice('平台身份类型无效，请重新打开小程序。'); return; }
    if (endpoint !== 'anonymous' && !code) { setNotice('平台身份初始化失败，请重新打开小程序。'); return; }
    const stored = !platform && !code ? window.sessionStorage.getItem(PLATFORM_SESSION_KEY) : null;
    if (stored) {
      const session = JSON.parse(stored) as { platform: string; token: string };
      if (session.platform === 'bilibili' || session.platform === 'xiaohongshu') {
        setUserToken(session.token);
        void refreshProgress(session.token).then(() => setAuthReady(true)).catch((error) => {
          console.error(error);
          window.sessionStorage.removeItem(PLATFORM_SESSION_KEY);
          setNotice('平台身份已失效，请重新打开小程序。');
        });
      }
    } else {
      fetch(`${PUBLIC_API}/api/auth/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(endpoint === 'anonymous' ? {} : { code }) }).then(async (response) => {
        if (!response.ok) throw new Error(`身份初始化失败：${response.status}`);
        const data = await response.json() as { token: string };
        if (endpoint !== 'anonymous') window.sessionStorage.setItem(PLATFORM_SESSION_KEY, JSON.stringify({ platform: endpoint, token: data.token }));
        setUserToken(data.token);
        setAuthReady(true);
        await refreshProgress(data.token);
      }).catch((error) => { console.error(error); setNotice('身份初始化失败，请刷新页面重试。'); });
    }
  }, []);

  /** 数据库按当前会话返回个人进度；网页共享访客只返回公开题目总数。 */
  async function refreshProgress(token: string) {
    if (!PUBLIC_API) return;
    const response = await fetch(`${PUBLIC_API}/api/me/progress`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`答题记录加载失败：${response.status}`);
    setProgress(await response.json() as Progress);
  }

  function choose(next: Soup) { setCurrentId(next.id); setMessages([]); setShowAnswer(false); setRevealedAnswer(null); setRevealedHints(0); setHintView(0); setSolveThread([]); setSolveOpen(false); setView('play'); }
  function nextSoup() { const index = soups.findIndex((item) => item.id === currentId); choose(soups[(index + 1) % soups.length]); }
  async function ask(event: FormEvent) {
    event.preventDefault();
    const text = question.trim();
    if (!text || loading) return;
    if (PUBLIC_API && soup.remote && !authReady) { setNotice('身份正在初始化，请稍后再试。'); return; }
    if (solveOpen) { await submitSolveAttempt(text); return; }
    setQuestion(''); setLoading(true); setMessages((items) => [...items, { role: 'user', text }]);
    try {
      const endpoint = PUBLIC_API && soup.remote ? `${PUBLIC_API}/api/soups/${soup.id}/judge` : '/api/judge';
      const payload = PUBLIC_API && soup.remote ? { question: text } : { story: soup.story, answer: soup.answer, question: text };
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(userToken ? { Authorization: `Bearer ${userToken}` } : {}), ...(soup.creatorToken ? { 'X-Creator-Token': soup.creatorToken } : {}) }, body: JSON.stringify(payload) });
      if (!response.ok) throw new Error(`Jev 判断请求失败：${response.status}`);
      const data = await response.json() as { verdict: Verdict; confidence: number };
      setMessages((items) => [...items, { role: 'jev', text: data.verdict === '无法确定' ? '这题我拿不准，换个问法试试。' : '', verdict: data.verdict, confidence: data.confidence }]);
      if (PUBLIC_API && soup.remote && userToken) void refreshProgress(userToken).catch(console.error);
    } catch (error) {
      // 判断失败必须立刻结束本轮，loading 卡住会堵死后续提问
      console.error(error);
      setMessages((items) => [...items, { role: 'jev', text: '判断失败，稍后再试。' }]);
    } finally {
      setLoading(false);
    }
  }
  function share() {
    const url = `${window.location.origin}${window.location.pathname}?soup=${encodeURIComponent(encodeSoup(soup))}`;
    navigator.clipboard.writeText(url).then(() => setNotice('分享链接已复制，发给朋友即可开局。'));
  }
  /** 公布答案：线上题目的汤底不进浏览器，确认后才向 worker 单独取一次 */
  async function revealAnswer() {
    if (!soup.answer) {
      try {
        const response = await fetch(`${PUBLIC_API}/api/soups/${soup.id}/answer`);
        if (!response.ok) throw new Error(`汤底获取失败：${response.status}`);
        const data = await response.json() as { answer: string };
        setRevealedAnswer(data.answer);
      } catch (error) {
        console.error(error);
        setNotice('汤底获取失败，稍后再试。');
        return;
      }
    }
    setShowAnswer(true);
    setConfirmingAnswer(false);
  }
  /** 还原真相模式的一次提交：走 solve 接口，结果留在临时线程里，不混进主对话 */
  async function submitSolveAttempt(text: string) {
    setQuestion(''); setLoading(true); setSolveThread((items) => [...items, { role: 'user', text }]);
    try {
      const endpoint = PUBLIC_API && soup.remote ? `${PUBLIC_API}/api/soups/${soup.id}/solve` : '/api/solve';
      const payload = PUBLIC_API && soup.remote ? { solution: text } : { story: soup.story, answer: soup.answer, solution: text };
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(userToken ? { Authorization: `Bearer ${userToken}` } : {}) }, body: JSON.stringify(payload) });
      if (!response.ok) throw new Error(`真相还原判断失败：${response.status}`);
      const data = await response.json() as { outcome: Outcome; confidence: number };
      setSolveThread((items) => [...items, { role: 'jev', outcome: data.outcome, confidence: data.confidence }]);
      if (PUBLIC_API && soup.remote && userToken) void refreshProgress(userToken).catch(console.error);
    } catch (error) {
      console.error(error);
      setSolveThread((items) => [...items, { role: 'jev', text: '判断失败，稍后再试。' }]);
    } finally {
      setLoading(false);
    }
  }
  async function createSoup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const hints = ['hint1', 'hint2', 'hint3'].map((name) => String(form.get(name) ?? '').trim()).filter(Boolean);
    const created: Soup = { id: crypto.randomUUID(), title: String(form.get('title')), story: String(form.get('story')), answer: String(form.get('answer')), hints };
    try {
      if (PUBLIC_API) {
        if (!userToken) throw new Error('身份正在初始化，请稍后再试');
        const response = await fetch(`${PUBLIC_API}/api/soups`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userToken}` }, body: JSON.stringify(created) });
        if (!response.ok) throw new Error(`投稿保存失败：${response.status}`);
        const data = await response.json() as { soup: Soup; creator_token: string; message: string };
        created.id = data.soup.id;
        created.remote = true;
        created.creatorToken = data.creator_token;
        setNotice(data.message);
      }
      setSoups((items) => [created, ...items]); choose(created); if (!PUBLIC_API) setNotice('新海龟汤已创建，可以直接分享。');
    } catch (error) {
      console.error(error);
      setNotice('创建失败，稍后再试。');
    }
  }

  return <main className="app-shell">
    <header><button className="brand" onClick={() => setView('play')}>Jev <span>海龟汤</span></button><div className="header-actions"><button className="next" onClick={nextSoup}>下一题</button><button className="share" onClick={share}>分享给朋友</button></div></header>
    {notice && <div className="notice" role="status">{notice}<button onClick={() => setNotice('')}>×</button></div>}
    {view === 'play' && <section className="play"><div className="hero"><p>一问一答，接近真相</p><h1>{soup.title}</h1><div className="story">{soup.story}</div></div>
      {solveOpen ? <div className="solve-panel"><div className="solve-top"><b>还原真相</b><button onClick={() => setSolveOpen(false)}>退出还原</button></div><div className="solve-thread" ref={solveRef}>{solveThread.length === 0 && <p className="solve-intro">写下你认为完整的故事，Jev 会对照汤底校验。可以多次提交，每次都会给出判断。</p>}{solveThread.map((entry, index) => entry.role === 'user' ? <div key={index} className="bubble user">{entry.text}</div> : entry.outcome ? <div key={index} className={`outcome ${entry.outcome}`}><b>{entry.outcome}</b><span>置信度 {Math.round((entry.confidence ?? 0) * 100)}%</span>{entry.outcome === '破解成功' && <p>恭喜，你已经抓住这碗汤的核心真相。</p>}{entry.outcome === '接近真相' && <p>方向对了，再补齐关键原因。</p>}{entry.outcome === '还没猜对' && <p>漏了关键事实，换个思路再提交一次。</p>}{entry.outcome === '无法确定' && <p>Jev 对这次判断没有足够把握，请换一种说法。</p>}</div> : <div key={index} className="solve-failed">{entry.text}</div>)}{loading && <em className="solve-judging">Jev 正在校验…</em>}</div></div> : <div className="chat" ref={chatRef} aria-live="polite">{messages.length === 0 && <div className="host-intro"><span className="avatar">🐢</span><p>我是 Jev，这碗汤的主持人。大胆提问，我只回答「是、否、无关」。</p></div>}{messages.map((message, index) => message.role === 'user' ? <div key={index} className="bubble user">{message.text}</div> : <div key={index} className="jev-reply"><span className="avatar">🐢</span><div className="reply-body"><div className="reply-head"><b>Jev</b>{message.verdict && <span className={`verdict ${message.verdict}`}>{message.verdict}</span>}{message.verdict && <small>置信度 {Math.round((message.confidence ?? 0) * 100)}%</small>}</div>{message.text ? <p>{message.text}</p> : null}</div></div>)}{loading && <div className="jev-reply"><span className="avatar">🐢</span><em>Jev 正在判断…</em></div>}{showAnswer && <div className="answer"><b>汤底</b><p>{soup.answer ?? revealedAnswer}</p></div>}</div>}
      {!solveOpen && revealedHints > 0 && <div className="hint-float"><div className="hint-float-head"><b>提示 {hintView + 1}/{soup.hints.length}</b><div className="hint-arrows"><button type="button" aria-label="上一条提示" disabled={hintView === 0} onClick={() => setHintView(hintView - 1)}>←</button><button type="button" aria-label="下一条提示" disabled={hintView >= revealedHints - 1} onClick={() => setHintView(hintView + 1)}>→</button></div></div><p>{soup.hints[hintView]}</p></div>}
      {!solveOpen && <div className="actions"><button disabled={revealedHints >= soup.hints.length} onClick={() => { setHintView(revealedHints); setRevealedHints((count) => count + 1); }}>{revealedHints === 0 ? '提示' : `提示 ${Math.min(revealedHints, soup.hints.length)}/${soup.hints.length}`}</button><button onClick={() => setConfirmingAnswer(true)}>公布答案</button><button onClick={() => setSolveOpen(true)}>还原真相</button></div>}
      <form className="ask" onSubmit={ask}><input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder={solveOpen ? '写下你还原的真相…' : '问问 Jev…'} maxLength={solveOpen ? 1500 : 500} required /><button disabled={loading || (!!PUBLIC_API && !!soup.remote && !authReady)}>发送</button></form></section>}
    {confirmingAnswer && <div className="modal" role="dialog" aria-modal="true" onClick={() => setConfirmingAnswer(false)}><div className="modal-card" onClick={(event) => event.stopPropagation()}><p>看到汤底这局就没悬念了，确定公布吗？</p><div className="modal-actions"><button onClick={() => setConfirmingAnswer(false)}>取消</button><button className="confirm" onClick={revealAnswer}>公布答案</button></div></div></div>}
    {view === 'library' && <section className="library"><h1>题库</h1><p>选一题，和朋友一起慢慢推理。</p>{soups.map((item) => { const record = progress?.personal ? progress.soups.find((entry) => entry.soup_id === item.id) : null; return <button className="soup-row" onClick={() => choose(item)} key={item.id}><span>{item.title}{record && <em className={record.solved_at ? 'soup-state solved' : 'soup-state'}>{record.solved_at ? '已解出' : '已玩'}</em>}</span><small>{item.story}</small></button>; })}</section>}
    {view === 'progress' && <section className="progress-page"><h1>我的答题记录</h1>{!PUBLIC_API ? <p className="progress-empty">连接正式题库后，这里会显示答题统计。</p> : !progress ? <p className="progress-empty">正在读取答题记录…</p> : <><div className="progress-numbers"><div><strong>{progress.solved}</strong><span>已解出</span></div><div><strong>{progress.attempted}</strong><span>已尝试</span></div><div><strong>{progress.total}</strong><span>公开题目</span></div></div>{progress.personal ? <><p className="progress-caption">解出一道题，以 Jev 判定“破解成功”为准。</p><div className="progress-list">{progress.soups.length === 0 ? <p className="progress-empty">还没有答题记录，去题库挑一碗汤吧。</p> : progress.soups.map((entry) => <button key={entry.soup_id} className="soup-row" onClick={() => { const item = soups.find((candidate) => candidate.id === entry.soup_id); if (item) choose(item); }}><span>{entry.title}<em className={entry.solved_at ? 'soup-state solved' : 'soup-state'}>{entry.solved_at ? '已解出' : '已玩'}</em></span><small>提问 {entry.question_count} 次{entry.last_outcome ? ` · 最近判定：${entry.last_outcome}` : ''}</small></button>)}</div></> : <p className="progress-empty">网页访客共用身份。通过小红书或 B 站小程序打开后，会自动保存你的个人答题记录。</p>}</>}</section>}
    {view === 'create' && <section className="creator"><h1>出一道海龟汤</h1><p>把汤面、汤底和提示写好，创建后就能分享。</p><form onSubmit={createSoup}><label>题目名称<input name="title" required maxLength={30} placeholder="例如：消失的钥匙" /></label><label>汤面<textarea name="story" required maxLength={500} placeholder="玩家最先看到的故事" /></label><label>汤底<textarea name="answer" required maxLength={1500} placeholder="完整真相，只给 Jev 和公布答案时看" /></label><label>提示一<input name="hint1" required maxLength={100} placeholder="给卡住的玩家一点方向" /></label><label>提示二（选填）<input name="hint2" maxLength={100} placeholder="换个角度再给一条" /></label><label>提示三（选填）<input name="hint3" maxLength={100} placeholder="最后一条提示" /></label><button>创建并开始</button></form></section>}
    <nav><button className={view === 'library' ? 'active' : ''} onClick={() => setView('library')}>题库</button><button className={view === 'play' ? 'active' : ''} onClick={() => setView('play')}>开局</button><button className={view === 'progress' ? 'active' : ''} onClick={() => { setView('progress'); if (userToken) void refreshProgress(userToken).catch(console.error); }}>记录</button><button className={view === 'create' ? 'active' : ''} onClick={() => setView('create')}>出题</button></nav>
  </main>;
}
