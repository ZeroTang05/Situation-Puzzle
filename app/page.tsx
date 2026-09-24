'use client';

import { FormEvent, Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import library from '../data/library.json';
import englishLibrary from '../data/library.en.json';
import { apiBaseUrl } from '../lib/api-url';
import { loadBrowserProgress, recordBrowserQuestion, recordBrowserSolution, type BrowserProgress } from '../lib/browser-progress';
import { copy, displayOutcome } from '../lib/i18n';
import type { Language } from '../lib/jev';

type Verdict = '是' | '否' | '无关' | '无法确定' | 'Yes' | 'No' | 'Irrelevant' | 'Uncertain';
type Outcome = '破解成功' | '接近真相' | '还没猜对' | '无法确定' | 'Solved' | 'Close' | 'Not yet' | 'Uncertain';
type Soup = { id: string; title: string; story: string; answer?: string; hints: string[]; language?: Language; author_name?: string; remote?: boolean; creatorToken?: string };
type Message = { role: 'user' | 'jev'; text: string; verdict?: Verdict; confidence?: number };
/** 还原真相模式的临时对话：玩家提交 + Jev 的结局判定（判断失败时只有 text） */
type SolveEntry = { role: 'user' | 'jev'; text?: string; outcome?: Outcome; confidence?: number; answer?: string };
type ProgressItem = { soup_id: string; title: string; question_count: number; last_outcome: Outcome | null; solved_at: string | null; last_played_at: string };
type Progress = { personal: boolean; total: number; attempted: number; solved: number; soups: ProgressItem[] };

// 内置题库与 worker 种子共用 data/library.json；离线模式（未配置 NEXT_PUBLIC_API_URL）完全靠它运行
const SOUPS: Soup[] = library.map((soup) => ({ ...soup }));
const ENGLISH_SOUPS: Soup[] = englishLibrary.map((soup) => ({ ...soup, language: 'en' }));
const PUBLIC_API = apiBaseUrl(process.env.NEXT_PUBLIC_API_URL);
const PLATFORM_SESSION_KEY = 'jev-platform-session';

export default function Home() {
  const [language, setLanguage] = useState<Language>('zh');
  const t = copy[language];
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
  const [platformProgress, setPlatformProgress] = useState<Progress | null>(null);
  const [browserProgress, setBrowserProgress] = useState<BrowserProgress | null>(null);
  const [progressSource, setProgressSource] = useState<'browser' | 'platform'>('browser');
  const [solveOpen, setSolveOpen] = useState(false);
  const [solveThread, setSolveThread] = useState<SolveEntry[]>([]);
  const [creating, setCreating] = useState(false);
  const chatRef = useRef<HTMLDivElement>(null);
  const solveRef = useRef<HTMLDivElement>(null);
  const identityStarted = useRef(false);
  const soup = useMemo(() => soups.find((item) => item.id === currentId) ?? soups[0], [soups, currentId]);
  const progress = useMemo<Progress | null>(() => {
    if (progressSource === 'platform') return platformProgress;
    if (!browserProgress) return null;
    const entries = soups.flatMap((item) => {
      const record = browserProgress[item.id];
      return record ? [{ soup_id: item.id, title: item.title, ...record }] : [];
    }).sort((a, b) => b.last_played_at.localeCompare(a.last_played_at));
    return { personal: true, total: soups.length, attempted: entries.length, solved: entries.filter((entry) => entry.solved_at).length, soups: entries };
  }, [progressSource, platformProgress, browserProgress, soups]);

  /** 平台用户从数据库读取当前语言题库中的答题记录。 */
  const refreshProgress = useCallback(async (token: string) => {
    if (!PUBLIC_API) return;
    const response = await fetch(`${PUBLIC_API}/api/me/progress?lang=${language}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`答题记录加载失败：${response.status}`);
    setPlatformProgress(await response.json() as Progress);
  }, [language]);

  useEffect(() => { setBrowserProgress(loadBrowserProgress()); }, []);

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('lang');
    const saved = window.localStorage.getItem('jev-language');
    if (requested === 'en' || requested === 'zh') setLanguage(requested);
    else if (saved === 'en') setLanguage('en');
  }, []);

  /** 语言切换只重新读取题库；用户身份和答题记录继续沿用。 */
  useEffect(() => {
    document.documentElement.lang = language === 'en' ? 'en' : 'zh-CN';
    window.localStorage.setItem('jev-language', language);
    const local = language === 'en' ? ENGLISH_SOUPS : SOUPS;
    setSoups(local);
    setMessages([]); setSolveThread([]); setShowAnswer(false); setRevealedAnswer(null); setRevealedHints(0);
    if (!PUBLIC_API) return;
    let active = true;
    fetch(`${PUBLIC_API}/api/soups?lang=${language}`).then(async (response) => {
      if (!response.ok) throw new Error('公开题库加载失败');
      const data = await response.json() as { soups: Soup[] };
      if (active) setSoups(data.soups.map((item) => ({ ...item, remote: true })));
    }).catch((error) => { console.error(error); if (active) setNotice(copy[language].feedFailed); });
    return () => { active = false; };
  }, [language]);

  useEffect(() => { chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight }); }, [messages, loading, showAnswer]);
  useEffect(() => { solveRef.current?.scrollTo({ top: solveRef.current.scrollHeight }); }, [solveThread, loading]);

  useEffect(() => {
    if (!confirmingAnswer) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setConfirmingAnswer(false); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [confirmingAnswer]);

  useEffect(() => {
    const soupId = new URLSearchParams(window.location.search).get('soup');
    if (!soupId) return;
    const initialLanguage = new URLSearchParams(window.location.search).get('lang') === 'en' || (!new URLSearchParams(window.location.search).has('lang') && window.localStorage.getItem('jev-language') === 'en') ? 'en' : 'zh';
    if (!PUBLIC_API) {
      const found = (initialLanguage === 'en' ? ENGLISH_SOUPS : SOUPS).find((item) => item.id === soupId);
      if (found) choose(found);
      else setNotice(copy[initialLanguage].localMissing);
      return;
    }
    // 分享链接只带题目 ID；公开汤面由后端读取，汤底不会进入地址栏。
    fetch(`${PUBLIC_API}/api/soups/${encodeURIComponent(soupId)}?lang=${initialLanguage}`).then(async (response) => {
      if (!response.ok) throw new Error(`分享题目读取失败：${response.status}`);
      const data = await response.json() as { soup: Soup };
      const shared = { ...data.soup, remote: true };
      setSoups((items) => [...items.filter((item) => item.id !== shared.id), shared]);
      setCurrentId(shared.id);
    }).catch((error) => { console.error(error); setNotice(copy[initialLanguage].sharedMissing); });
  }, []);

  useEffect(() => {
    if (!PUBLIC_API || identityStarted.current) return;
    identityStarted.current = true;
    // 小程序壳把一次性 code 放进 WebView URL；读取后立即从地址栏移除。
    const url = new URL(window.location.href);
    const initialLanguage = url.searchParams.get('lang') === 'en' || (!url.searchParams.has('lang') && window.localStorage.getItem('jev-language') === 'en') ? 'en' : 'zh';
    const platform = url.searchParams.get('platform');
    const code = url.searchParams.get('login_code');
    if (platform || code) { url.searchParams.delete('platform'); url.searchParams.delete('login_code'); window.history.replaceState(null, '', url); }
    const endpoint = platform === 'bilibili' || platform === 'xiaohongshu' ? platform : null;
    if (platform && !endpoint) { setNotice(copy[initialLanguage].invalidPlatform); return; }
    if (endpoint && !code) { setNotice(copy[initialLanguage].platformMissingCode); return; }
    const stored = !platform && !code ? window.sessionStorage.getItem(PLATFORM_SESSION_KEY) : null;
    if (stored) {
      const session = JSON.parse(stored) as { platform: string; token: string };
      if (session.platform === 'bilibili' || session.platform === 'xiaohongshu') {
        setProgressSource('platform');
        setUserToken(session.token);
        void refreshProgress(session.token).then(() => setAuthReady(true)).catch((error) => {
          console.error(error);
          window.sessionStorage.removeItem(PLATFORM_SESSION_KEY);
          setNotice(copy[initialLanguage].sessionExpired);
        });
      }
    } else if (endpoint) {
      setProgressSource('platform');
      fetch(`${PUBLIC_API}/api/auth/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) }).then(async (response) => {
        if (!response.ok) throw new Error(`身份初始化失败：${response.status}`);
        const data = await response.json() as { token: string };
        window.sessionStorage.setItem(PLATFORM_SESSION_KEY, JSON.stringify({ platform: endpoint, token: data.token }));
        setUserToken(data.token);
        setAuthReady(true);
        await refreshProgress(data.token);
      }).catch((error) => { console.error(error); setNotice(copy[initialLanguage].platformFailed); });
    } else {
      // 网页访客只使用本机记录，不向后端申请匿名会话。
      setAuthReady(true);
    }
  }, [refreshProgress]);

  useEffect(() => { if (userToken && progressSource === 'platform') void refreshProgress(userToken).catch(console.error); }, [refreshProgress, userToken, progressSource]);

  function switchLanguage() {
    const next = language === 'zh' ? 'en' : 'zh';
    const url = new URL(window.location.href);
    url.searchParams.set('lang', next);
    window.history.replaceState(null, '', url);
    setNotice('');
    setLanguage(next);
  }

  function choose(next: Soup) { setCurrentId(next.id); setMessages([]); setShowAnswer(false); setRevealedAnswer(null); setRevealedHints(0); setHintView(0); setSolveThread([]); setSolveOpen(false); setView('play'); }
  function nextSoup() { const index = soups.findIndex((item) => item.id === currentId); choose(soups[(index + 1) % soups.length]); }
  async function ask(event: FormEvent) {
    event.preventDefault();
    const text = question.trim();
    if (!text || loading) return;
    if (PUBLIC_API && soup.remote && !authReady) { setNotice(t.authWait); return; }
    if (solveOpen) { await submitSolveAttempt(text); return; }
    setQuestion(''); setLoading(true); setMessages((items) => [...items, { role: 'user', text }]);
    try {
      const endpoint = PUBLIC_API && soup.remote ? `${PUBLIC_API}/api/soups/${soup.id}/judge?lang=${language}` : '/api/judge';
      const payload = PUBLIC_API && soup.remote ? { question: text } : { story: soup.story, answer: soup.answer, question: text, language };
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(userToken ? { Authorization: `Bearer ${userToken}` } : {}), ...(soup.creatorToken ? { 'X-Creator-Token': soup.creatorToken } : {}) }, body: JSON.stringify(payload) });
      if (!response.ok) throw new Error(`Jev 判断请求失败：${response.status}`);
      const data = await response.json() as { verdict: Verdict; confidence: number };
      setMessages((items) => [...items, { role: 'jev', text: data.verdict === '无法确定' || data.verdict === 'Uncertain' ? t.unsureReply : '', verdict: data.verdict, confidence: data.confidence }]);
      if (progressSource === 'browser') setBrowserProgress(recordBrowserQuestion(soup.id));
      else if (PUBLIC_API && soup.remote && userToken) void refreshProgress(userToken).catch(console.error);
    } catch (error) {
      // 判断失败必须立刻结束本轮，loading 卡住会堵死后续提问
      console.error(error);
      setMessages((items) => [...items, { role: 'jev', text: t.questionFailed }]);
    } finally {
      setLoading(false);
    }
  }
  function share() {
    if (!PUBLIC_API && !SOUPS.some((item) => item.id === soup.id)) {
      setNotice(t.shareUnavailable);
      return;
    }
    const url = new URL(window.location.pathname, window.location.origin);
    url.searchParams.set('soup', soup.id);
    url.searchParams.set('lang', language);
    navigator.clipboard.writeText(url.toString()).then(() => setNotice(t.shared));
  }
  /** 公布答案：线上题目的汤底不进浏览器，确认后才向 worker 单独取一次 */
  async function revealAnswer() {
    if (!soup.answer) {
      try {
        const response = await fetch(`${PUBLIC_API}/api/soups/${soup.id}/answer?lang=${language}`);
        if (!response.ok) throw new Error(`汤底获取失败：${response.status}`);
        const data = await response.json() as { answer: string };
        setRevealedAnswer(data.answer);
      } catch (error) {
        console.error(error);
        setNotice(t.answerFailed);
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
      const endpoint = PUBLIC_API && soup.remote ? `${PUBLIC_API}/api/soups/${soup.id}/solve?lang=${language}` : '/api/solve';
      const payload = PUBLIC_API && soup.remote ? { solution: text } : { story: soup.story, answer: soup.answer, solution: text, language };
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(userToken ? { Authorization: `Bearer ${userToken}` } : {}) }, body: JSON.stringify(payload) });
      if (!response.ok) throw new Error(`真相还原判断失败：${response.status}`);
      const data = await response.json() as { outcome: Outcome; confidence: number; answer?: string };
      setSolveThread((items) => [...items, { role: 'jev', outcome: data.outcome, confidence: data.confidence, answer: data.answer }]);
      if (progressSource === 'browser') setBrowserProgress(recordBrowserSolution(soup.id, data.outcome));
      else if (PUBLIC_API && soup.remote && userToken) void refreshProgress(userToken).catch(console.error);
    } catch (error) {
      console.error(error);
      setSolveThread((items) => [...items, { role: 'jev', text: t.questionFailed }]);
    } finally {
      setLoading(false);
    }
  }
  async function createSoup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (creating) return;
    setCreating(true);
    const form = new FormData(event.currentTarget);
    const hints = ['hint1', 'hint2', 'hint3'].map((name) => String(form.get(name) ?? '').trim()).filter(Boolean);
    const created: Soup = { id: crypto.randomUUID(), title: String(form.get('title')), story: String(form.get('story')), answer: String(form.get('answer')), hints, language };
    try {
      if (PUBLIC_API) {
        if (progressSource === 'platform' && !userToken) throw new Error(t.authWait);
        const response = await fetch(`${PUBLIC_API}/api/soups`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(userToken ? { Authorization: `Bearer ${userToken}` } : {}) }, body: JSON.stringify(created) });
        if (!response.ok) throw new Error(`投稿审核失败：${response.status}`);
        const data = await response.json() as { status: 'rejected'; message: string } | { status: 'published'; soup: Soup; creator_token: string; message: string };
        setNotice(data.message);
        if (data.status === 'rejected') return;
        const published = { ...data.soup, answer: created.answer, remote: true, creatorToken: data.creator_token };
        setSoups((items) => [...items.filter((item) => item.id !== published.id), published]);
        choose(published);
        return;
      }
      setSoups((items) => [...items, created]); choose(created); setNotice(t.createLocalNotice);
    } catch (error) {
      console.error(error);
      setNotice(t.reviewFailed);
    } finally {
      setCreating(false);
    }
  }

  return <main className="app-shell">
    <title>{language === 'en' ? 'Jev Situation Puzzles' : 'Jev 海龟汤'}</title>
    <meta name="description" content={language === 'en' ? 'Solve situation puzzles with Jev as your host.' : '让 Jev 当主持人的海龟汤小游戏'} />
    <header><button className="brand" onClick={() => setView('play')}>Jev <span>{t.brand}</span></button><div className="header-actions"><button className="language-switch" onClick={switchLanguage} aria-label={language === 'zh' ? 'Switch to English' : 'Switch to Chinese'}>{language === 'zh' ? 'EN' : 'ZH'}</button><button className="next" onClick={nextSoup}>{t.next}</button><button className="share" onClick={share}>{t.share}</button></div></header>
    {notice && <div className="notice" role="status">{notice}<button onClick={() => setNotice('')}>×</button></div>}
    {view === 'play' && <section className="play"><div className="hero"><p>{t.tagline}</p><h1>{soup.title}</h1><div className="story">{soup.story}</div></div>
      {solveOpen ? <div className="solve-panel"><div className="solve-top"><b>{t.solve}</b><button onClick={() => setSolveOpen(false)}>{t.exitSolve}</button></div><div className="solve-thread" ref={solveRef}>{solveThread.length === 0 && <p className="solve-intro">{t.solveIntro}</p>}{solveThread.map((entry, index) => entry.role === 'user' ? <div key={index} className="bubble user">{entry.text}</div> : entry.outcome ? <Fragment key={index}><div className={`outcome ${entry.outcome.replace(' ', '-')}`}><b>{displayOutcome(entry.outcome, language)}</b><span>{t.confidence} {Math.round((entry.confidence ?? 0) * 100)}%</span>{(entry.outcome === '破解成功' || entry.outcome === 'Solved') && <p>{t.solvedDetail}</p>}{(entry.outcome === '接近真相' || entry.outcome === 'Close') && <p>{t.closeDetail}</p>}{(entry.outcome === '还没猜对' || entry.outcome === 'Not yet') && <p>{t.notYetDetail}</p>}{(entry.outcome === '无法确定' || entry.outcome === 'Uncertain') && <p>{t.uncertainDetail}</p>}</div>{(entry.outcome === '破解成功' || entry.outcome === 'Solved') && entry.answer && <div className="answer"><b>{t.answer}</b><p>{entry.answer}</p></div>}</Fragment> : <div key={index} className="solve-failed">{entry.text}</div>)}{loading && <em className="solve-judging">{t.checking}</em>}</div></div> : <div className="chat" ref={chatRef} aria-live="polite">{messages.length === 0 && <div className="host-intro"><span className="avatar">🐢</span><p>{t.hostIntro}</p></div>}{messages.map((message, index) => message.role === 'user' ? <div key={index} className="bubble user">{message.text}</div> : <div key={index} className="jev-reply"><span className="avatar">🐢</span><div className="reply-body"><div className="reply-head"><b>Jev</b>{message.verdict && <span className={`verdict ${message.verdict}`}>{message.verdict}</span>}{message.verdict && <small>{t.confidence} {Math.round((message.confidence ?? 0) * 100)}%</small>}</div>{message.text ? <p>{message.text}</p> : null}</div></div>)}{loading && <div className="jev-reply"><span className="avatar">🐢</span><em>{t.judging}</em></div>}{showAnswer && <div className="answer"><b>{t.answer}</b><p>{soup.answer ?? revealedAnswer}</p></div>}</div>}
      {!solveOpen && revealedHints > 0 && <div className="hint-float"><div className="hint-float-head"><b>{t.hint} {hintView + 1}/{soup.hints.length}</b><div className="hint-arrows"><button type="button" aria-label={language === 'en' ? 'Previous hint' : '上一条提示'} disabled={hintView === 0} onClick={() => setHintView(hintView - 1)}>←</button><button type="button" aria-label={language === 'en' ? 'Next hint' : '下一条提示'} disabled={hintView >= revealedHints - 1} onClick={() => setHintView(hintView + 1)}>→</button></div></div><p>{soup.hints[hintView]}</p></div>}
      {!solveOpen && <div className="actions"><button disabled={revealedHints >= soup.hints.length} onClick={() => { setHintView(revealedHints); setRevealedHints((count) => count + 1); }}>{revealedHints === 0 ? t.hint : `${t.hint} ${Math.min(revealedHints, soup.hints.length)}/${soup.hints.length}`}</button><button onClick={() => setConfirmingAnswer(true)}>{t.reveal}</button><button onClick={() => setSolveOpen(true)}>{t.solve}</button></div>}
      <form className="ask" onSubmit={ask}><input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder={solveOpen ? t.solvePlaceholder : t.askPlaceholder} maxLength={solveOpen ? 1500 : 500} required /><button disabled={loading || (!!PUBLIC_API && !!soup.remote && !authReady)}>{t.send}</button></form></section>}
    {confirmingAnswer && <div className="modal" role="dialog" aria-modal="true" onClick={() => setConfirmingAnswer(false)}><div className="modal-card" onClick={(event) => event.stopPropagation()}><p>{t.revealConfirm}</p><div className="modal-actions"><button onClick={() => setConfirmingAnswer(false)}>{t.cancel}</button><button className="confirm" onClick={revealAnswer}>{t.reveal}</button></div></div></div>}
    {view === 'library' && <section className="library"><h1>{t.library}</h1><p>{t.libraryIntro}</p>{soups.map((item) => { const record = progress?.personal ? progress.soups.find((entry) => entry.soup_id === item.id) : null; return <button className="soup-row" onClick={() => choose(item)} key={item.id}><span>{item.title}{record && <em className={record.solved_at ? 'soup-state solved' : 'soup-state'}>{record.solved_at ? t.completed : t.played}</em>}</span><small>{item.story}</small></button>; })}</section>}
    {view === 'progress' && <section className="progress-page"><h1>{t.progress}</h1>{!progress ? <p className="progress-empty">{t.progressLoading}</p> : <><div className="progress-numbers"><div><strong>{progress.solved}</strong><span>{t.completed}</span></div><div><strong>{progress.attempted}</strong><span>{t.attempted}</span></div><div><strong>{progress.total}</strong><span>{t.total}</span></div></div><div className="progress-list">{progress.soups.length === 0 ? <p className="progress-empty">{t.progressEmpty}</p> : progress.soups.map((entry) => <button key={entry.soup_id} className="soup-row" onClick={() => { const item = soups.find((candidate) => candidate.id === entry.soup_id); if (item) choose(item); }}><span>{soups.find((item) => item.id === entry.soup_id)?.title ?? entry.title}<em className={entry.solved_at ? 'soup-state solved' : 'soup-state'}>{entry.solved_at ? t.completed : t.played}</em></span><small>{t.questions} {entry.question_count} {t.times}{entry.last_outcome ? ` · ${t.recent}: ${displayOutcome(entry.last_outcome, language)}` : ''}</small></button>)}</div></>}</section>}
    {view === 'create' && <section className="creator"><h1>{t.createTitle}</h1><p>{PUBLIC_API ? t.createRemote : t.createLocal}</p><form onSubmit={createSoup}><label>{t.title}<input name="title" required maxLength={30} placeholder={t.titleExample} /></label><label>{t.story}<textarea name="story" required maxLength={500} placeholder={t.storyPlaceholder} /></label><label>{t.answerField}<textarea name="answer" required maxLength={1500} placeholder={t.answerPlaceholder} /></label><label>{t.hint1}<input name="hint1" required maxLength={100} placeholder={t.hint1Placeholder} /></label><label>{t.hint2}<input name="hint2" maxLength={100} placeholder={t.hint2Placeholder} /></label><label>{t.hint3}<input name="hint3" maxLength={100} placeholder={t.hint3Placeholder} /></label><button disabled={creating}>{creating ? t.reviewing : PUBLIC_API ? t.submitReview : t.createOffline}</button></form></section>}
    <nav><button className={view === 'library' ? 'active' : ''} onClick={() => setView('library')}>{t.library}</button><button className={view === 'play' ? 'active' : ''} onClick={() => setView('play')}>{t.play}</button><button className={view === 'progress' ? 'active' : ''} onClick={() => { setView('progress'); if (progressSource === 'platform' && userToken) void refreshProgress(userToken).catch(console.error); }}>{t.records}</button><button className={view === 'create' ? 'active' : ''} onClick={() => setView('create')}>{t.create}</button></nav>
  </main>;
}
