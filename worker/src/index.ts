import library from '../../data/library.json';
import { judgeQuestionWithJev, reviewSoupWithJev, solveWithJev } from '../../lib/jev';

interface Env {
  DB: D1Database;
  AI_GATEWAY_API_KEY: string;
  ADMIN_TOKEN: string;
  BILIBILI_APP_ID: string;
  BILIBILI_APP_SECRET: string;
  XHS_APP_ID: string;
  XHS_APP_SECRET: string;
  ALLOWED_ORIGIN: string;
  JEV_CONFIDENCE_THRESHOLD: string;
}

type SoupStatus = 'pending' | 'published' | 'rejected' | 'deleted';
type Soup = { id: string; title: string; story: string; answer: string; hints: string[]; author_name: string; status: SoupStatus; created_at: string; published_at: string | null; reviewed_at: string | null; moderation_note: string | null; creator_token: string };
/** 数据库里 hints 以 JSON 文本存储，读出后需要解析成数组 */
type SoupRow = Omit<Soup, 'hints'> & { hints: string };
const parseHints = (rows: SoupRow[]) => rows.map(({ hints, ...rest }) => ({ ...rest, hints: JSON.parse(hints) as string[] }));

/** 初始题库（data/library.json）：worker 每个实例启动后首次请求时整体覆盖 seed- 开头的行 */
type SeedSoup = { id: string; title: string; story: string; answer: string; hints: string[] };
const seedLibrary = library as SeedSoup[];
let seedPromise: Promise<void> | null = null;
function ensureSeeded(env: Env): Promise<void> {
  if (!seedPromise) {
    seedPromise = (async () => {
      const now = new Date().toISOString();
      const statements = [env.DB.prepare("DELETE FROM soups WHERE id LIKE 'seed-%' OR creator_token = 'seed'")];
      for (const soup of seedLibrary) {
        statements.push(env.DB.prepare('INSERT INTO soups (id,title,story,answer,hints,author_name,status,created_at,published_at,creator_token) VALUES (?,?,?,?,?,?,?,?,?,?)')
          .bind(soup.id, soup.title, soup.story, soup.answer, JSON.stringify(soup.hints), 'Jev 题库', 'published', now, now, 'seed'));
      }
      await env.DB.batch(statements);
    })().catch((error) => { seedPromise = null; throw error; });
  }
  return seedPromise;
}
type User = { id: string; status: 'active' | 'banned'; first_seen_at: string; last_seen_at: string };
type SessionUser = User & { is_identified: number };

const json = (value: unknown, status = 200, origin = '*') => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=UTF-8', 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin', ...(origin !== '*' && { 'Access-Control-Allow-Credentials': 'true' }) } });
const id = () => crypto.randomUUID();

/**
 * 计算本次请求应回写的 CORS 来源：与 ALLOWED_ORIGIN 完全一致时原样返回；
 * 本地开发时前端可能用 localhost、127.0.0.1 或局域网 IP 打开（端口也会变），这些来源一并放行。
 * 其余来源返回 ALLOWED_ORIGIN，浏览器会因不匹配而拒绝读取响应。
 */
function corsOrigin(request: Request, env: Env): string {
  const origin = request.headers.get('Origin');
  if (origin === env.ALLOWED_ORIGIN) return origin;
  try {
    const { hostname } = new URL(origin ?? '');
    const isLocalHost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
    const isPrivateNetwork = hostname.startsWith('192.168.') || hostname.startsWith('10.') || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname);
    if ((isLocalHost || isPrivateNetwork) && origin) return origin;
  } catch { /* Origin 不是合法 URL 时按未匹配处理 */ }
  return env.ALLOWED_ORIGIN;
}

/** Worker API：公开题库、UGC 投稿、Jev 判题与后台审核都在一个边缘服务中完成。 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = corsOrigin(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { headers: { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization', ...(origin !== '*' && { 'Access-Control-Allow-Credentials': 'true' }) } });
    await ensureSeeded(env);
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);
    try {
      if (request.method === 'GET' && url.pathname === '/health') return json({ ok: true }, 200, origin);
      if (request.method === 'GET' && url.pathname === '/api/soups') return publicSoups(env, origin);
      if (request.method === 'GET' && parts.length === 3 && parts[0] === 'api' && parts[1] === 'soups') return publicSoup(parts[2], env, origin);
      if (request.method === 'POST' && url.pathname === '/api/auth/anonymous') return anonymousAuth(request, env, origin);
      if (request.method === 'POST' && url.pathname === '/api/auth/bilibili') return bilibiliAuth(request, env, origin);
      if (request.method === 'POST' && url.pathname === '/api/auth/xiaohongshu') return xiaohongshuAuth(request, env, origin);
      if (request.method === 'GET' && url.pathname === '/api/me/progress') return myProgress(request, env, origin);
      if (request.method === 'POST' && url.pathname === '/api/soups') return createSoup(request, env, origin);
      if (request.method === 'GET' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'soups' && parts[3] === 'answer') return revealAnswer(parts[2], env, origin);
      if (request.method === 'POST' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'soups' && parts[3] === 'judge') return judgeSoup(parts[2], request, env, origin);
      if (request.method === 'POST' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'soups' && parts[3] === 'solve') return solveSoup(parts[2], request, env, origin);
      if (parts[0] === 'api' && parts[1] === 'admin') return admin(request, parts, env, origin);
      return json({ error: '路由不存在' }, 404, origin);
    } catch (error) {
      console.error(error);
      return json({ error: error instanceof Error ? error.message : '服务器错误' }, 500, origin);
    }
  },
};

async function publicSoups(env: Env, origin: string) {
  const { results } = await env.DB.prepare("SELECT id, title, story, hints, author_name, created_at, published_at FROM soups WHERE status = ? ORDER BY CASE WHEN creator_token = 'seed' THEN 0 ELSE 1 END, published_at ASC, id ASC").bind('published').all<SoupRow>();
  return json({ soups: parseHints(results) }, 200, origin);
}

/** 分享链接按稳定题目 ID 读取公开汤面，绝不返回汤底或创建者令牌。 */
async function publicSoup(soupId: string, env: Env, origin: string) {
  const row = await env.DB.prepare('SELECT id, title, story, hints, author_name, created_at, published_at FROM soups WHERE id = ? AND status = ?').bind(soupId, 'published').first<SoupRow>();
  if (!row) return json({ error: '题目不存在或已下架' }, 404, origin);
  return json({ soup: parseHints([row])[0] }, 200, origin);
}

/** 公布答案：玩家明确选择看汤底时才单独下发，题库列表接口永远不包含 answer。 */
async function revealAnswer(soupId: string, env: Env, origin: string) {
  const soup = await env.DB.prepare('SELECT answer FROM soups WHERE id = ? AND status = ?').bind(soupId, 'published').first<{ answer: string }>();
  if (!soup) return json({ error: '题目不存在或尚未公开' }, 404, origin);
  return json({ answer: soup.answer }, 200, origin);
}

async function createSoup(request: Request, env: Env, origin: string) {
  const input = await request.json() as Partial<Pick<Soup, 'title' | 'story' | 'answer' | 'author_name'>> & { hints?: string[] };
  for (const key of ['title', 'story', 'answer'] as const) if (!input[key]?.trim()) return json({ error: `${key} 不能为空` }, 400, origin);
  const hints = (input.hints ?? []).map((hint) => hint.trim().slice(0, 100)).filter(Boolean);
  if (!hints[0]) return json({ error: '至少填写一条提示' }, 400, origin);
  const user = await currentUser(request, env);
  if (request.headers.has('Authorization') && !user) return json({ error: '身份无效' }, 401, origin);
  if (user?.status === 'banned') return json({ error: '该账户已被限制投稿' }, 403, origin);
  const title = input.title!.trim().slice(0, 30);
  const story = input.story!.trim().slice(0, 500);
  const answer = input.answer!.trim().slice(0, 1500);
  const approved = await reviewSoupWithJev(env.AI_GATEWAY_API_KEY, { title, story, answer, hints });
  const now = new Date().toISOString();
  const soup: Soup = { id: id(), title, story, answer, hints, author_name: input.author_name?.trim().slice(0, 20) || '匿名玩家', status: approved ? 'published' : 'rejected', created_at: now, published_at: approved ? now : null, reviewed_at: approved ? null : now, moderation_note: approved ? null : 'Jev 审核未通过：色情或政治内容', creator_token: id() };
  await env.DB.prepare('INSERT INTO soups (id,title,story,answer,hints,author_name,status,created_at,published_at,reviewed_at,moderation_note,creator_token,author_user_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(soup.id, soup.title, soup.story, soup.answer, JSON.stringify(soup.hints), soup.author_name, soup.status, soup.created_at, soup.published_at, soup.reviewed_at, soup.moderation_note, soup.creator_token, user?.id ?? null).run();
  if (!approved) return json({ status: 'rejected', message: '审核未通过：题目涉及色情或政治内容，未公开。' }, 200, origin);
  return json({ status: 'published', soup: { ...soup, answer: undefined, creator_token: undefined }, creator_token: soup.creator_token, message: '审核通过，题目已公开，可以分享给朋友。' }, 201, origin);
}

/** 直接访问网页的玩家共用访客 ID；个人答题记录只归属经平台验证的用户。 */
async function anonymousAuth(_request: Request, env: Env, origin: string) {
  return issueIdentity(env, 'anonymous', 'shared-web', origin);
}

/** B 站小程序将 bl.login() 获得的一次性 code 交给 Worker；AppSecret 永远不会进入客户端。 */
async function bilibiliAuth(request: Request, env: Env, origin: string) {
  const { code } = await request.json() as { code?: string }; if (!code) return json({ error: '缺少 B 站登录凭证' }, 400, origin);
  const query = new URLSearchParams({ appid: env.BILIBILI_APP_ID, secret: env.BILIBILI_APP_SECRET, js_code: code, grant_type: 'authorization_code' });
  const response = await fetch(`https://miniapp.bilibili.com/api/sns/jscode2session?${query}`); if (!response.ok) throw new Error(`B 站登录校验失败：${response.status}`);
  const data = await response.json() as { openId?: string; errcode?: number }; if (!data.openId) return json({ error: `B 站登录校验失败：${data.errcode ?? '未知错误'}` }, 401, origin);
  return issueIdentity(env, 'bilibili', data.openId, origin);
}

/** 小红书小程序 code 只能在服务端换 open_id，密钥和 session_key 都不下发。 */
async function xiaohongshuAuth(request: Request, env: Env, origin: string) {
  const { code } = await request.json() as { code?: string };
  if (!code) return json({ error: '缺少小红书登录凭证' }, 400, origin);
  if (!env.XHS_APP_ID || !env.XHS_APP_SECRET) throw new Error('缺少小红书小程序配置');
  const tokenQuery = new URLSearchParams({ app_id: env.XHS_APP_ID, app_secret: env.XHS_APP_SECRET });
  const tokenResponse = await fetch(`https://miniapp.xiaohongshu.com/api/rmp/token?${tokenQuery}`);
  if (!tokenResponse.ok) throw new Error(`小红书应用凭证获取失败：${tokenResponse.status}`);
  const tokenData = await tokenResponse.json() as { success?: boolean; code?: number; data?: { access_token?: string } };
  const accessToken = tokenData.data?.access_token;
  if (tokenData.success !== true || !accessToken) throw new Error(`小红书应用凭证获取失败：${tokenData.code ?? '未知错误'}`);
  const sessionQuery = new URLSearchParams({ appid: env.XHS_APP_ID, access_token: accessToken, code });
  const sessionResponse = await fetch(`https://miniapp.xiaohongshu.com/api/rmp/session?${sessionQuery}`);
  if (!sessionResponse.ok) throw new Error(`小红书登录校验失败：${sessionResponse.status}`);
  const sessionData = await sessionResponse.json() as { success?: boolean; code?: number; data?: { open_id?: string } };
  const openId = sessionData.data?.open_id;
  if (sessionData.success !== true || !openId) return json({ error: `小红书登录校验失败：${sessionData.code ?? '未知错误'}` }, 401, origin);
  return issueIdentity(env, 'xiaohongshu', openId, origin);
}

async function issueIdentity(env: Env, platform: 'anonymous' | 'bilibili' | 'xiaohongshu', platformOpenId: string, origin: string) {
  const now = new Date().toISOString();
  let identity = await env.DB.prepare('SELECT user_id FROM user_identities WHERE platform=? AND platform_open_id=?').bind(platform, platformOpenId).first<{ user_id: string }>();
  if (!identity) {
    const candidateId = platform === 'anonymous' ? 'web-shared' : id();
    await env.DB.batch([
      env.DB.prepare('INSERT OR IGNORE INTO users (id,first_seen_at,last_seen_at) VALUES (?,?,?)').bind(candidateId, now, now),
      env.DB.prepare('INSERT OR IGNORE INTO user_identities (id,user_id,platform,platform_open_id,created_at) VALUES (?,?,?,?,?)').bind(id(), candidateId, platform, platformOpenId, now),
    ]);
    identity = await env.DB.prepare('SELECT user_id FROM user_identities WHERE platform=? AND platform_open_id=?').bind(platform, platformOpenId).first<{ user_id: string }>();
  }
  if (!identity) throw new Error('用户身份保存失败');
  const userId = identity.user_id;
  await env.DB.prepare('UPDATE users SET last_seen_at=? WHERE id=?').bind(now, userId).run(); const token = id(); await env.DB.prepare('INSERT INTO user_sessions (token,user_id,created_at,last_seen_at) VALUES (?,?,?,?)').bind(token, userId, now, now).run();
  return json({ token, user_id: userId, platform }, 200, origin);
}

async function currentUser(request: Request, env: Env) {
  const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/, ''); if (!token) return null;
  const result = await env.DB.prepare("SELECT users.*, EXISTS(SELECT 1 FROM user_identities i WHERE i.user_id=users.id AND i.platform IN ('bilibili','xiaohongshu')) AS is_identified FROM user_sessions JOIN users ON users.id=user_sessions.user_id WHERE user_sessions.token=?").bind(token).first<SessionUser>(); if (result) await env.DB.prepare('UPDATE user_sessions SET last_seen_at=? WHERE token=?').bind(new Date().toISOString(), token).run(); return result;
}

/** 仅返回当前用户自己的已玩题目；总题量与公开题库使用相同的 published 范围。 */
async function myProgress(request: Request, env: Env, origin: string) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: '身份无效' }, 401, origin);
  const total = await env.DB.prepare("SELECT COUNT(*) AS count FROM soups WHERE status='published'").first<{ count: number }>();
  if (!user.is_identified) return json({ personal: false, total: total?.count ?? 0, attempted: 0, solved: 0, soups: [] }, 200, origin);
  const { results } = await env.DB.prepare("SELECT p.soup_id, s.title, p.question_count, p.last_outcome, p.solved_at, p.last_played_at FROM soup_progress p JOIN soups s ON s.id=p.soup_id WHERE p.user_id=? AND s.status='published' ORDER BY p.last_played_at DESC").bind(user.id).all<{ soup_id: string; title: string; question_count: number; last_outcome: string | null; solved_at: string | null; last_played_at: string }>();
  return json({ personal: true, total: total?.count ?? 0, attempted: results.length, solved: results.filter((item) => item.solved_at).length, soups: results }, 200, origin);
}

/** 一次有效提问才计数；无法确定也算玩家尝试，Jev 请求失败不计数。 */
async function recordQuestion(env: Env, user: SessionUser | null, soupId: string) {
  if (!user?.is_identified) return;
  const now = new Date().toISOString();
  await env.DB.prepare('INSERT INTO soup_progress (user_id,soup_id,first_played_at,last_played_at,question_count) VALUES (?,?,?,?,1) ON CONFLICT(user_id,soup_id) DO UPDATE SET last_played_at=excluded.last_played_at,question_count=soup_progress.question_count+1').bind(user.id, soupId, now, now).run();
}

/** 只有 Jev 判为“破解成功”才记完成；之后再试题不会抹掉已完成状态。 */
async function recordSolution(env: Env, user: SessionUser | null, soupId: string, outcome: string) {
  if (!user?.is_identified) return;
  const now = new Date().toISOString(); const solvedAt = outcome === '破解成功' ? now : null;
  await env.DB.prepare('INSERT INTO soup_progress (user_id,soup_id,first_played_at,last_played_at,last_outcome,solved_at) VALUES (?,?,?,?,?,?) ON CONFLICT(user_id,soup_id) DO UPDATE SET last_played_at=excluded.last_played_at,last_outcome=excluded.last_outcome,solved_at=COALESCE(soup_progress.solved_at,excluded.solved_at)').bind(user.id, soupId, now, now, outcome, solvedAt).run();
}

async function judgeSoup(soupId: string, request: Request, env: Env, origin: string) {
  const input = await request.json() as { question?: string };
  if (!input.question?.trim()) return json({ error: '问题不能为空' }, 400, origin);
  const soup = await env.DB.prepare('SELECT * FROM soups WHERE id = ?').bind(soupId).first<Soup>();
  if (!soup) return json({ error: '题目不存在或尚未公开' }, 404, origin);
  if (soup.status !== 'published' && request.headers.get('X-Creator-Token') !== soup.creator_token) return json({ error: '题目尚未公开' }, 403, origin);
  const result = await judgeQuestionWithJev(env.AI_GATEWAY_API_KEY, soup.story, soup.answer, input.question.trim().slice(0, 500), Number(env.JEV_CONFIDENCE_THRESHOLD));
  await recordQuestion(env, await currentUser(request, env), soupId);
  return json(result, 200, origin);
}

/** 结局判断：玩家写出完整推理，Jev 对照汤底判断核心因果是否已被还原。 */
async function solveSoup(soupId: string, request: Request, env: Env, origin: string) {
  const input = await request.json() as { solution?: string };
  if (!input.solution?.trim()) return json({ error: '请先写出你的推理' }, 400, origin);
  const soup = await env.DB.prepare('SELECT * FROM soups WHERE id = ? AND status = ?').bind(soupId, 'published').first<Soup>();
  if (!soup) return json({ error: '题目不存在或尚未公开' }, 404, origin);
  const result = await solveWithJev(env.AI_GATEWAY_API_KEY, soup.story, soup.answer, input.solution.trim().slice(0, 1500), Number(env.JEV_CONFIDENCE_THRESHOLD));
  await recordSolution(env, await currentUser(request, env), soupId, result.outcome);
  // 破解成功后才在这次回复中下发汤底，供还原真相对话直接展示。
  return json({ ...result, ...(result.outcome === '破解成功' ? { answer: soup.answer } : {}) }, 200, origin);
}

/**
 * HTTP Basic 校验：浏览器接到 401 + WWW-Authenticate 会弹出原生的顶部登录框，
 * 用户输入后会展示在 Authorization: Basic base64(user:password) 头里。
 * 用户名为 admin，密码为 ADMIN_TOKEN；不匹配继续返 401。
 */
function requireAdminBasic(request: Request, env: Env, origin: string): Response | null {
  const auth = request.headers.get('Authorization');
  const headers = {
    'Content-Type': 'application/json; charset=UTF-8',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Vary': 'Origin',
    'WWW-Authenticate': 'Basic realm="Jev 海龟汤 · 审核后台", charset="UTF-8"',
  };
  if (!auth?.startsWith('Basic ')) {
    return new Response(JSON.stringify({ error: '需要管理员登录' }), { status: 401, headers });
  }
  try {
    const decoded = atob(auth.slice(6));
    const colon = decoded.indexOf(':');
    if (colon < 0) throw new Error('格式错误');
    const username = decoded.slice(0, colon);
    const password = decoded.slice(colon + 1);
    if (username !== 'admin' || password !== env.ADMIN_TOKEN) {
      return new Response(JSON.stringify({ error: '管理员密码错误' }), { status: 401, headers });
    }
  } catch {
    return new Response(JSON.stringify({ error: '管理员认证格式错误' }), { status: 401, headers });
  }
  return null;
}

async function admin(request: Request, parts: string[], env: Env, origin: string) {
  const authFailure = requireAdminBasic(request, env, origin);
  if (authFailure) return authFailure;
  if (request.method === 'GET' && parts.length === 3 && parts[2] === 'soups') {
    const view = new URL(request.url).searchParams.get('status') || 'unreviewed';
    if (!['unreviewed', 'pending', 'published', 'rejected', 'deleted'].includes(view)) return json({ error: '无效审核列表' }, 400, origin);
    const statement = view === 'unreviewed'
      ? env.DB.prepare("SELECT * FROM soups WHERE status='published' AND reviewed_at IS NULL AND creator_token <> 'seed' ORDER BY created_at ASC LIMIT 100")
      : env.DB.prepare("SELECT * FROM soups WHERE status=? AND creator_token <> 'seed' ORDER BY created_at DESC LIMIT 100").bind(view);
    const { results } = await statement.all<SoupRow>();
    return json({ soups: parseHints(results) }, 200, origin);
  }
  if ((request.method === 'PATCH' || request.method === 'DELETE') && parts.length === 4 && parts[2] === 'soups') {
    const soupId = parts[3]; const body = request.method === 'PATCH' ? await request.json() as { status?: SoupStatus; note?: string } : { status: 'deleted' as SoupStatus };
    if (!['published', 'rejected', 'deleted'].includes(body.status ?? '')) return json({ error: '无效审核状态' }, 400, origin);
    const now = new Date().toISOString();
    await env.DB.batch([env.DB.prepare("UPDATE soups SET status=?, published_at=CASE WHEN ?='published' AND published_at IS NULL THEN ? ELSE published_at END, reviewed_at=?, moderation_note=? WHERE id=?").bind(body.status, body.status, now, now, body.note ?? null, soupId), env.DB.prepare('INSERT INTO moderation_logs (id,soup_id,action,note,created_at) VALUES (?,?,?,?,?)').bind(id(), soupId, body.status, body.note ?? null, now)]);
    return json({ ok: true }, 200, origin);
  }
  return json({ error: '后台路由不存在' }, 404, origin);
}
