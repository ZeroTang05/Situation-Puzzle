import library from '../../data/library.json';
import englishLibrary from '../../data/library.en.json';
import { judgeQuestionWithJev, reviewSoupWithJev, solveWithJev, type Language } from '../../lib/jev';

interface Env {
  DB: D1Database;
  AI_GATEWAY_API_KEY: string;
  ADMIN_TOKEN: string;
  ALLOWED_ORIGIN: string;
  JEV_CONFIDENCE_THRESHOLD: string;
}

type SoupStatus = 'pending' | 'published' | 'rejected' | 'deleted';
type Soup = { id: string; title: string; story: string; answer: string; hints: string[]; language: Language; author_name: string; status: SoupStatus; created_at: string; published_at: string | null; reviewed_at: string | null; moderation_note: string | null; creator_token: string };
/** 数据库里 hints 以 JSON 文本存储，读出后需要解析成数组 */
type SoupRow = Omit<Soup, 'hints'> & { hints: string };
const parseHints = (rows: SoupRow[]) => rows.map(({ hints, ...rest }) => ({ ...rest, hints: JSON.parse(hints) as string[] }));

/** 内置题在数据库迁移时一次性种入（0001_initial.sql 末尾种子块，由 pnpm sync:seed 从 data/library.json 生成）；
 *  worker 运行期对种子行零写入，改题库后用 worker/seed-data.sql 重新应用即可。 */
type SeedSoup = { id: string; title: string; story: string; answer: string; hints: string[] };
const seedOrder = new Map((library as SeedSoup[]).map((soup, index) => [soup.id, index]));
const englishSeeds = new Map((englishLibrary as SeedSoup[]).map((soup) => [soup.id, soup]));
const requestLanguage = (request: Request): Language => new URL(request.url).searchParams.get('lang') === 'en' ? 'en' : 'zh';
/** 内置题按请求语言返回相同 ID 的翻译；玩家投稿只展示原文语言。 */
function localizedSoup(soup: Soup, language: Language): Soup {
  const translation = language === 'en' ? englishSeeds.get(soup.id) : undefined;
  return translation ? { ...soup, title: translation.title, story: translation.story, answer: translation.answer, hints: translation.hints, language } : soup;
}
/** 公开接口仅返回可玩的汤面，不下发汤底和创建者令牌。 */
function publicSoupShape(soup: Soup) {
  return { id: soup.id, title: soup.title, story: soup.story, hints: soup.hints, language: soup.language, author_name: soup.author_name, created_at: soup.created_at, published_at: soup.published_at };
}

const json = (value: unknown, status = 200, origin = '*') => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=UTF-8', 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin', ...(origin !== '*' && { 'Access-Control-Allow-Credentials': 'true' }) } });
const id = () => crypto.randomUUID();

/**
 * 计算本次请求应回写的 CORS 来源：Origin 命中 ALLOWED_ORIGIN 列表（逗号分隔，支持多个前端域名）时原样返回；
 * 本地开发时前端可能用 localhost、127.0.0.1 或局域网 IP 打开（端口也会变），这些来源一并放行。
 * 其余来源返回列表第一个，浏览器会因不匹配而拒绝读取响应。
 */
function corsOrigin(request: Request, env: Env): string {
  const allowed = env.ALLOWED_ORIGIN.split(',').map((item) => item.trim()).filter(Boolean);
  const origin = request.headers.get('Origin');
  if (origin && allowed.includes(origin)) return origin;
  try {
    const { hostname } = new URL(origin ?? '');
    const isLocalHost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
    const isPrivateNetwork = hostname.startsWith('192.168.') || hostname.startsWith('10.') || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname);
    if ((isLocalHost || isPrivateNetwork) && origin) return origin;
  } catch { /* Origin 不是合法 URL 时按未匹配处理 */ }
  return allowed[0] ?? '';
}

/** Worker API：公开题库、UGC 投稿、Jev 判题与后台审核都在一个边缘服务中完成。 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = corsOrigin(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { headers: { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,X-Creator-Token', ...(origin !== '*' && { 'Access-Control-Allow-Credentials': 'true' }) } });
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);
    try {
      if (request.method === 'GET' && url.pathname === '/health') return json({ ok: true }, 200, origin);
      if (request.method === 'GET' && url.pathname === '/api/stats') return soupStats(env, origin);
      if (request.method === 'GET' && url.pathname === '/api/soups') return publicSoups(request, env, origin);
      if (request.method === 'GET' && parts.length === 3 && parts[0] === 'api' && parts[1] === 'soups') return publicSoup(parts[2], request, env, origin);
      if (request.method === 'POST' && url.pathname === '/api/soups') return createSoup(request, env, origin);
      if (request.method === 'GET' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'soups' && parts[3] === 'answer') return revealAnswer(parts[2], request, env, origin);
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

/** 汤数量统计：读 stats 计数表（每种语言 1 行）加内置题常量，不为取数量扫描 soups 表。 */
async function soupStats(env: Env, origin: string) {
  const { results } = await env.DB.prepare("SELECT key, value FROM stats WHERE key LIKE 'published:%'").all<{ key: string; value: number }>();
  const published = Object.fromEntries(results.map((row) => [row.key.slice('published:'.length), row.value]));
  const seeds = seedOrder.size;
  return json({ seeds, published, total: { zh: seeds + (published.zh ?? 0), en: seeds + (published.en ?? 0) } }, 200, origin);
}

async function publicSoups(request: Request, env: Env, origin: string) {
  const language = requestLanguage(request);
  const { results } = await env.DB.prepare("SELECT id, title, story, hints, language, author_name, created_at, published_at, creator_token FROM soups WHERE status = ? AND (creator_token = 'seed' OR language = ?) ORDER BY CASE WHEN creator_token = 'seed' THEN 0 ELSE 1 END, published_at ASC, id ASC").bind('published', language).all<SoupRow>();
  const ordered = parseHints(results).sort((a, b) => a.creator_token === 'seed' && b.creator_token === 'seed' ? (seedOrder.get(a.id) ?? 0) - (seedOrder.get(b.id) ?? 0) : 0);
  return json({ soups: ordered.map((soup) => publicSoupShape(localizedSoup(soup, language))) }, 200, origin);
}

/** 分享链接按稳定题目 ID 读取公开汤面，绝不返回汤底或创建者令牌。 */
async function publicSoup(soupId: string, request: Request, env: Env, origin: string) {
  const language = requestLanguage(request);
  const row = await env.DB.prepare("SELECT id, title, story, answer, hints, language, author_name, created_at, published_at, creator_token FROM soups WHERE id = ? AND status = ? AND (creator_token = 'seed' OR language = ?)").bind(soupId, 'published', language).first<SoupRow>();
  if (!row) return json({ error: '题目不存在或已下架' }, 404, origin);
  return json({ soup: publicSoupShape(localizedSoup(parseHints([row])[0], language)) }, 200, origin);
}

/** 公布答案：玩家明确选择看汤底时才单独下发，题库列表接口永远不包含 answer。 */
async function revealAnswer(soupId: string, request: Request, env: Env, origin: string) {
  const language = requestLanguage(request);
  const soup = await env.DB.prepare("SELECT id, answer, language, creator_token FROM soups WHERE id = ? AND status = ? AND (creator_token = 'seed' OR language = ?)").bind(soupId, 'published', language).first<Soup>();
  if (!soup) return json({ error: '题目不存在或尚未公开' }, 404, origin);
  return json({ answer: language === 'en' ? englishSeeds.get(soup.id)?.answer ?? soup.answer : soup.answer }, 200, origin);
}

async function createSoup(request: Request, env: Env, origin: string) {
  const input = await request.json() as Partial<Pick<Soup, 'title' | 'story' | 'answer' | 'author_name' | 'language'>> & { hints?: string[] };
  if (input.language && input.language !== 'zh' && input.language !== 'en') return json({ error: '无效题目语言' }, 400, origin);
  const language = input.language ?? 'zh';
  for (const key of ['title', 'story', 'answer'] as const) if (!input[key]?.trim()) return json({ error: `${key} 不能为空` }, 400, origin);
  const hints = (input.hints ?? []).map((hint) => hint.trim().slice(0, 100)).filter(Boolean);
  if (!hints[0]) return json({ error: '至少填写一条提示' }, 400, origin);
  const title = input.title!.trim().slice(0, 30);
  const story = input.story!.trim().slice(0, 500);
  const answer = input.answer!.trim().slice(0, 1500);
  const approved = await reviewSoupWithJev(env.AI_GATEWAY_API_KEY, { title, story, answer, hints }, language);
  const now = new Date().toISOString();
  const soup: Soup = { id: id(), title, story, answer, hints, language, author_name: input.author_name?.trim().slice(0, 20) || (language === 'en' ? 'Anonymous player' : '匿名玩家'), status: approved ? 'published' : 'rejected', created_at: now, published_at: approved ? now : null, reviewed_at: approved ? null : now, moderation_note: approved ? null : 'Jev 审核未通过：色情或政治内容', creator_token: id() };
  // 审核通过与计数 +1 放在同一个 batch 里原子生效，避免计数与题目行脱节。
  const statements = [env.DB.prepare('INSERT INTO soups (id,title,story,answer,hints,language,author_name,status,created_at,published_at,reviewed_at,moderation_note,creator_token) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(soup.id, soup.title, soup.story, soup.answer, JSON.stringify(soup.hints), soup.language, soup.author_name, soup.status, soup.created_at, soup.published_at, soup.reviewed_at, soup.moderation_note, soup.creator_token)];
  if (approved) statements.push(env.DB.prepare("INSERT INTO stats (key, value) VALUES (?, 1) ON CONFLICT(key) DO UPDATE SET value = value + 1").bind(`published:${language}`));
  await env.DB.batch(statements);
  if (!approved) return json({ status: 'rejected', message: language === 'en' ? 'Review failed: this puzzle contains sexual or political content and was not published.' : '审核未通过：题目涉及色情或政治内容，未公开。' }, 200, origin);
  return json({ status: 'published', soup: { ...soup, answer: undefined, creator_token: undefined }, creator_token: soup.creator_token, message: language === 'en' ? 'Approved. Your puzzle is live and ready to share.' : '审核通过，题目已公开，可以分享给朋友。' }, 201, origin);
}

async function judgeSoup(soupId: string, request: Request, env: Env, origin: string) {
  const input = await request.json() as { question?: string };
  if (!input.question?.trim()) return json({ error: '问题不能为空' }, 400, origin);
  const row = await env.DB.prepare('SELECT * FROM soups WHERE id = ?').bind(soupId).first<SoupRow>();
  const language = row?.creator_token === 'seed' ? requestLanguage(request) : row?.language ?? 'zh';
  const soup = row ? localizedSoup(parseHints([row])[0], language) : null;
  if (!soup) return json({ error: '题目不存在或尚未公开' }, 404, origin);
  if (soup.status !== 'published' && request.headers.get('X-Creator-Token') !== soup.creator_token) return json({ error: '题目尚未公开' }, 403, origin);
  const result = await judgeQuestionWithJev(env.AI_GATEWAY_API_KEY, soup.story, soup.answer, input.question.trim().slice(0, 500), Number(env.JEV_CONFIDENCE_THRESHOLD), language);
  return json(result, 200, origin);
}

/** 结局判断：玩家写出完整推理，Jev 对照汤底判断核心因果是否已被还原。 */
async function solveSoup(soupId: string, request: Request, env: Env, origin: string) {
  const input = await request.json() as { solution?: string };
  if (!input.solution?.trim()) return json({ error: '请先写出你的推理' }, 400, origin);
  const row = await env.DB.prepare('SELECT * FROM soups WHERE id = ? AND status = ?').bind(soupId, 'published').first<SoupRow>();
  const language = row?.creator_token === 'seed' ? requestLanguage(request) : row?.language ?? 'zh';
  const soup = row ? localizedSoup(parseHints([row])[0], language) : null;
  if (!soup) return json({ error: '题目不存在或尚未公开' }, 404, origin);
  const result = await solveWithJev(env.AI_GATEWAY_API_KEY, soup.story, soup.answer, input.solution.trim().slice(0, 1500), Number(env.JEV_CONFIDENCE_THRESHOLD), language);
  // 破解成功后才在这次回复中下发汤底，供还原真相对话直接展示。
  return json({ ...result, ...(result.outcome === '破解成功' || result.outcome === 'Solved' ? { answer: soup.answer } : {}) }, 200, origin);
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
    // 计数只跟踪玩家投稿的「已发布」状态（内置题不算）：先读一行旧状态，跨越 published 边界才增减。
    const current = await env.DB.prepare('SELECT status, language, creator_token FROM soups WHERE id = ?').bind(soupId).first<{ status: SoupStatus; language: Language; creator_token: string }>();
    const statements = [env.DB.prepare("UPDATE soups SET status=?, published_at=CASE WHEN ?='published' AND published_at IS NULL THEN ? ELSE published_at END, reviewed_at=?, moderation_note=? WHERE id=?").bind(body.status, body.status, now, now, body.note ?? null, soupId), env.DB.prepare('INSERT INTO moderation_logs (id,soup_id,action,note,created_at) VALUES (?,?,?,?,?)').bind(id(), soupId, body.status, body.note ?? null, now)];
    const wasPublished = current?.status === 'published' && current.creator_token !== 'seed';
    const willPublish = current != null && body.status === 'published' && current.creator_token !== 'seed';
    if (current && wasPublished !== willPublish) statements.push(willPublish
      ? env.DB.prepare("INSERT INTO stats (key, value) VALUES (?, 1) ON CONFLICT(key) DO UPDATE SET value = value + 1").bind(`published:${current.language}`)
      : env.DB.prepare('UPDATE stats SET value = value - 1 WHERE key = ?').bind(`published:${current.language}`));
    await env.DB.batch(statements);
    return json({ ok: true }, 200, origin);
  }
  return json({ error: '后台路由不存在' }, 404, origin);
}
