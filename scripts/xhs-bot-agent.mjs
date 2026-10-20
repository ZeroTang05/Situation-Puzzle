/**
 * 小红书评论区机器人 · 判断与回复
 *
 * 三步：
 *  1. 分类（MiniMax，Anthropic 兼容接口）：这条评论是提问 / 闲聊 / 剧透 / 该忽略
 *  2. 提问 → 调自家判题接口 POST /api/v1/solo/judge（是 / 否 / 无关 / 不确定）
 *  3. 按类别从话术池随机挑一条回复（话术池要够大：小红书会判"连续相同话术"为机器行为）
 */
import fs from 'node:fs';
import path from 'node:path';

/* ------------------------------------------------------------------ 环境变量 */

/** 读仓库根 .env.local（本地常驻服务不经过 shell 注入环境变量） */
export function loadEnvFile(root, file = '.env.local') {
  const p = path.resolve(root, file);
  if (!fs.existsSync(p)) return {};
  const out = {};
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/* ------------------------------------------------------------------ 分类 */

const CLASSIFY_SYSTEM = `你是海龟汤账号的评论区助手，负责判断一条读者评论的性质。

你会看到这道题的【汤面】和【真相】（真相仅供你判断剧透，读者看不到）。

只输出一个 JSON 对象，不要任何解释文字：
{"kind":"question|chitchat|spoiler|ignore","question":"当 kind=question 时，提取出读者真正要问的那句话；其余情况填空字符串"}

判定标准：
- question：向这道题提问的句子。包含是/否疑问、询问设定细节（"他是不是凶手""尸体在房间吗"）、提出假设求证（"如果是他会怎样"）。question 字段要保留原意，但去掉寒暄和 @。
- spoiler：对照【真相】判断——评论直接说出了答案里的关键真相（人物身份、死因、关键物、关键动机）。只是猜某个方向、且不一定是真相的，算 chitchat。
- chitchat：夸赞、打招呼、闲聊、发表猜测（"我猜是凶手"）、表情、感谢作者。哪怕猜得很准，只要不是复述真相，就归这里。
- ignore：广告引流、加微信、辱骂、与这道题完全无关的内容。

注意：中文口语里"他是不是凶手啊？"是 question；"肯定是凶手！"若与真相一致则是 spoiler，否则是 chitchat。`;

function extractJson(text) {
  const cleaned = String(text ?? '')
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(`分类响应不是 JSON：${cleaned.slice(0, 200)}`);
  return JSON.parse(cleaned.slice(start, end + 1));
}

/** 调 MiniMax 做一次分类（Anthropic 兼容 messages 接口） */
export async function classifyComment({ comment, puzzle, apiKey, baseUrl, model, timeoutMs = 40_000, retries = 1 }) {
  if (!apiKey) throw new Error('缺少 MINIMAX_API_KEY（.env.local 或环境变量）');
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/messages`;
  const user = [
    `【题目】${puzzle.title}`,
    `【汤面】${puzzle.story}`,
    `【真相】${puzzle.answer ?? '（无）'}`,
    `【评论】${comment.content}`,
  ].join('\n');
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          // 模型会先输出 thinking 块，额度太小正文会被截掉（表现为空响应）
          max_tokens: 4096,
          system: CLASSIFY_SYSTEM,
          messages: [{ role: 'user', content: user }],
        }),
        signal: ac.signal,
      });
      if (!res.ok) throw new Error(`分类接口 HTTP ${res.status}：${(await res.text()).slice(0, 200)}`);
      const data = await res.json();
      const text = (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      if (!text.trim()) {
        throw new Error(`分类响应为空（stop_reason=${data.stop_reason ?? '?'}，可能 max_tokens 不足）`);
      }
      const parsed = extractJson(text);
      const kind = ['question', 'chitchat', 'spoiler', 'ignore'].includes(parsed.kind) ? parsed.kind : 'ignore';
      return { kind, question: String(parsed.question ?? '').trim() };
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 800));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/* ------------------------------------------------------------------ 判题 */

/** 换取绑定该题目的匿名凭证（服务端 24h 过期，store 里缓存） */
export async function createSession({ apiBase, puzzleId, language = 'zh' }) {
  const res = await fetch(`${apiBase}/solo/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ puzzleId, language }),
  });
  if (!res.ok) throw new Error(`创建判题会话失败 HTTP ${res.status}：${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  // 响应形如 { data: { token, ... }, requestId }
  const data = body?.data ?? body;
  if (!data?.token) throw new Error(`判题会话响应里没有 token：${JSON.stringify(body).slice(0, 200)}`);
  return data.token;
}

/** 调自家判题接口 */
export async function judge({ apiBase, token, question, recentQas = [] }) {
  const res = await fetch(`${apiBase}/solo/judge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      token,
      question,
      ...(recentQas.length ? { recentQas: recentQas.slice(-10) } : {}),
    }),
  });
  if (!res.ok) throw new Error(`判题失败 HTTP ${res.status}：${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  // 响应形如 { data: { result, confidence }, requestId }
  const data = body?.data ?? body;
  if (!data?.result) throw new Error(`判题响应里没有 result：${JSON.stringify(body).slice(0, 200)}`);
  return { result: data.result, confidence: data.confidence };
}

/** 题库 legacyId → 数据库 puzzle UUID（分页拉全量后按 legacyId 建索引） */
export async function buildPuzzleIdMap({ apiBase, language = 'zh' }) {
  const map = new Map();
  let cursor = '';
  for (let page = 0; page < 100; page++) {
    const url = new URL(`${apiBase}/puzzles`);
    url.searchParams.set('language', language);
    if (cursor) url.searchParams.set('cursor', cursor);
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`拉取题目列表失败 HTTP ${res.status}`);
    const body = await res.json();
    // 响应形如 { data: { items, nextCursor }, requestId }
    const data = body?.data ?? body;
    const items = data?.items ?? [];
    for (const it of items) {
      if (it?.legacyId) map.set(it.legacyId, it.id);
    }
    const next = data?.nextCursor ?? null;
    if (!next || next === cursor || items.length === 0) break;
    cursor = next;
  }
  return map;
}

/* ------------------------------------------------------------------ 话术池 */

const TAILS = ['', '', '', '～', ' 👀', ' 🫠', ' 🙂'];

const TEMPLATES = {
  yes: ['是', '是 ✅', '是的', '嗯嗯，是', '是哦', '没错，是的', '对，是', '是的呀', '是～', '确认，是'],
  no: ['否', '不是 ❌', '不是哦', '不是呢', '不对', '否否', '这个不是', '不是啦', '不哦', '错，是不对'],
  irrelevant: ['无关', '不相关 👀', '这个跟答案无关哦', '问偏了～', '无关无关', '这道题不管这个', '跟答案没关系哦', '这个问的不是答案'],
  uncertain: ['这个我也拿不准 🤔', '先记下，明天回你～', '让我想想…明天给准话', '唔，这题有点难住我了'],
  chitchat: [
    '谢谢捧场～',
    '收到你的掌声 👏',
    '哈哈哈明天见',
    '厉害！明天上新汤',
    '你猜得比我快',
    '收藏了没？明天还有',
    '嘿嘿，谢谢支持～',
    '今天也是猜谜的一天',
    '好说好说，明天继续',
    '感恩！评论区见',
  ],
  spoiler: [
    '答案在下一篇笔记，别剧透啦～',
    '剧透警告！先自己猜 🤔',
    '憋住，答案下一条揭晓',
    '这波剧透要扣分哦～',
    '嘘——答案在下一篇',
    '别剧透，给别人留点悬念～',
  ],
  ignore: [],
};

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

/**
 * 生成回复文本。
 * @param kind classify 的类别；verdict 判题结果（yes/no/irrelevant/uncertain）
 */
export function buildReply({ kind, verdict, puzzle }) {
  if (kind === 'question') {
    const pool = TEMPLATES[verdict] ?? TEMPLATES.uncertain;
    return `${pick(pool)}${pick(TAILS)}`;
  }
  if (kind === 'chitchat') return `${pick(TEMPLATES.chitchat)}${pick(TAILS)}`;
  if (kind === 'spoiler') return `${pick(TEMPLATES.spoiler)}${pick(TAILS)}`;
  return '';
}

/** 话术池规模自检：连续 3 条相同话术会被小红书判成机器行为 */
export function templatePoolSizes() {
  return Object.fromEntries(Object.entries(TEMPLATES).map(([k, v]) => [k, v.length]));
}
