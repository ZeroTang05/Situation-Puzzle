/** 原生创作初审与修订联调：真实 API、邮件、任务进程和 AI，仅允许独立本地环境。 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { authSessionSchema, creationDetailSchema, creationDraftSchema, creationSummarySchema, meResponseSchema, miniLoginResponseSchema } from '@jev/contracts';
import { persistCreation, transitionCreation } from '../src/creation-save.js';
import type { api as NativeApi, RequestOptions } from '../src/api.js';
import { latestOtp } from './smtp-inbox.mjs';

const origin = process.env.TAPTAP_E2E_API_ORIGIN;
const mailbox = process.env.TAPTAP_E2E_MAILBOX;
if (!origin || !mailbox || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname)) throw new Error('请指定独立本地 API 与真实 SMTP 收信文件');
let checks = 0;
function check(value: unknown, name: string): asserts value { assert(value, name); checks++; console.log(`通过：${name}`); }

async function raw(path: string, options: RequestOptions = {}, token = '') {
  const result = await fetch(`${origin}/api/v1${path}`, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers: { 'Content-Type': 'application/json', 'X-Jev-Language': 'zh', ...(token && { Authorization: `Bearer ${token}` }), ...options.headers },
    ...(options.body !== undefined && { body: JSON.stringify(options.body) }), signal: AbortSignal.timeout(60_000),
  });
  return { status: result.status, body: await result.json() as unknown };
}
async function auth<T>(path: string, schema: z.ZodType<T>, body: unknown, headers?: Record<string, string>): Promise<T> {
  const result = await raw(`/auth${path}`, { body, ...(headers && { headers }) });
  assert(result.status >= 200 && result.status < 300, `${path}: HTTP ${result.status}`);
  return schema.parse(result.body);
}
const sendAs = (token: string): typeof NativeApi => async <T,>(path: string, options: RequestOptions = {}, schema?: z.ZodType<T>): Promise<T> => {
  const result = await raw(path, options, token);
  assert(result.status >= 200 && result.status < 300, `${path}: HTTP ${result.status}`);
  return z.object({ data: schema ?? z.unknown() }).parse(result.body).data as T;
};

const email = `taptap-review-${randomUUID()}@e2e.test`; const password = `Review-${randomUUID()}`;
const since = Date.now();
await auth('/email-otp/send-verification-otp', z.unknown(), { email, type: 'sign-in' }, { 'x-jev-otp-purpose': 'signup' });
const otp = await latestOtp(mailbox, email, since); check(otp.length === 6, '实际 SMTP 投递作者注册验证码');
const registered = await auth('/sign-up/email', miniLoginResponseSchema, { email, password, name: '原生审核验收作者' }, { 'x-jev-signup-otp': otp });
const author = sendAs(registered.token);
const sessionResult = await raw('/auth/get-session', {}, registered.token); const session = authSessionSchema.parse(sessionResult.body);
check(session?.user.email === email, '实际注册会话对应本次作者');
const before = await author('/me', {}, meResponseSchema);
const source = z.array(z.object({ title: z.string(), story: z.string(), answer: z.string(), hints: z.array(z.string()), difficulty: z.enum(['easy', 'medium', 'hard']), category: z.enum(['本格', '变格']) })).parse(JSON.parse(await readFile(new URL('../../../data/library.json', import.meta.url), 'utf8')))[0];
if (!source) throw new Error('实际题库为空');
const draft = creationDraftSchema.parse({ title: source.title, surface: source.story, answer: source.answer, hints: source.hints,
  language: 'zh', difficulty: source.difficulty, category: source.category === '本格' ? 'honkaku' : 'henkaku', origin: 'original', sourceUrl: '', authorDisplay: { mode: 'anonymous' },
});
const saved = await persistCreation(author, draft);
check(saved.status === 'draft', '使用原生保存函数建立真实私有草稿');
const privateResult = await raw(`/puzzles/${saved.puzzleId}?language=zh`);
check(privateResult.status === 404, '初审前作品不出现在公开题库');
const submitted = await transitionCreation(author, saved, 'submit');
check(['submitted', 'checking'].includes(submitted.status), '原生提交函数将版本交给实际任务队列');

// 只轮询这次真实提交的版本；不伪造初审状态，失败记录会直接终止检查。
let reviewed = submitted; const deadline = Date.now() + 120_000; let lastStatus = '';
while (true) {
  reviewed = await author(`/creations/${saved.puzzleId}`, {}, creationDetailSchema);
  if (reviewed.status !== lastStatus) { console.log(`实际初审状态：${reviewed.status}`); lastStatus = reviewed.status; }
  const records = reviewed.reviews.filter((review) => review.versionId === saved.versionId && review.stage === 'machine');
  assert(!records.some((review) => review.conclusion === 'check_failed'), '真实 AI 初审调用失败，请检查任务日志');
  if (records.length > 0 && ['published', 'changes_requested', 'pending_review'].includes(reviewed.status)) break;
  assert(Date.now() < deadline, '真实初审两分钟内未完成，请检查任务进程');
  await new Promise((resolve) => setTimeout(resolve, 10_000));
}
check(reviewed.versionId === saved.versionId && reviewed.reviews.some((review) => review.stage === 'machine' && review.conclusion === reviewed.status), '真实 AI 初审结果与当前版本状态一致');
check(reviewed.draft.surface === saved.draft.surface && reviewed.draft.answer === saved.draft.answer, '初审保留提交版本的汤面与汤底');
const afterMachine = await author('/me', {}, meResponseSchema);
check(afterMachine.freeRooms.total === before.freeRooms.total, '机器初审不会发放人工审核的十次作品奖励');

if (reviewed.status === 'pending_review') {
  const adminEmail = process.env.TAPTAP_E2E_ADMIN_EMAIL; const adminPassword = process.env.TAPTAP_E2E_ADMIN_PASSWORD;
  assert(adminEmail && adminPassword, '本次 AI 要求人工复核，请为独立测试服务配置审核员账号');
  const adminLogin = await auth('/sign-in/email', miniLoginResponseSchema, { email: adminEmail, password: adminPassword });
  const admin = sendAs(adminLogin.token);
  const denied = await raw(`/admin/puzzle-versions/${reviewed.versionId}/approve`, { body: { reason: '本地真实审核链路验收', scope: 'language' } }, registered.token);
  check(denied.status === 403, '普通作者不能批准自己的待审作品');
  const approval = await admin(`/admin/puzzle-versions/${reviewed.versionId}/approve`, { body: { reason: '独立本地环境核验发布及修订流程', scope: 'language' } }, z.object({ creationBonus: z.boolean() }));
  check(approval.creationBonus, '实际审核接口完成首次人工发布并发放作品奖励');
  reviewed = await author(`/creations/${saved.puzzleId}`, {}, creationDetailSchema);
  const afterHuman = await author('/me', {}, meResponseSchema);
  check(reviewed.status === 'published' && afterHuman.freeRooms.total === before.freeRooms.total + 10, '人工审核发布与作者十次额度同时到账');
}

const wasPublished = reviewed.status === 'published';
const publicSchema = z.object({ id: z.uuid(), versionId: z.uuid(), title: z.string(), surface: z.string() }).passthrough();
const publicReader = sendAs('');
if (wasPublished) {
  const published = await publicReader(`/puzzles/${saved.puzzleId}?language=zh`, {}, publicSchema);
  check(published.versionId === saved.versionId && published.surface === saved.draft.surface, '实际发布版本可以从公共题库读取');
  check(!Object.hasOwn(published, 'answer') && !Object.hasOwn(published, 'hints'), '公开作品不包含汤底和未解锁提示');
} else {
  const rejected = await raw(`/puzzles/${saved.puzzleId}?language=zh`);
  check(rejected.status === 404 && reviewed.status === 'changes_requested', '真实初审退回的作品继续保持私有');
}
const revision = await transitionCreation(author, reviewed, 'revise');
check(revision.puzzleId === saved.puzzleId && revision.versionNo === reviewed.versionNo + 1 && revision.versionId !== reviewed.versionId && revision.status === 'draft', '原生修订函数在实际允许的状态建立下一版草稿');
check(revision.versions.some((item) => item.versionId === reviewed.versionId && item.status === reviewed.status), '创建修订后原审核版本和记录完整保留');
check(revision.draft.surface === reviewed.draft.surface && revision.draft.answer === reviewed.draft.answer, '修订初始正文完整复制实际审核版本');
const changed = await persistCreation(author, { ...revision.draft, title: `${revision.draft.title}（修订稿）`.slice(0, 60) }, revision);
check(changed.versionId === revision.versionId && changed.draft.title.endsWith('（修订稿）'), '原生保存函数更新新修订稿');
const works = await author('/creations', {}, z.object({ items: z.array(creationSummarySchema) }));
check(works.items.length === 1 && works.items[0]?.versionId === changed.versionId && works.items[0].published === wasPublished, '作品列表同时正确反映最新草稿和实际公开状态');
if (wasPublished) {
  const oldPublic = await publicReader(`/puzzles/${saved.puzzleId}?language=zh`, {}, publicSchema);
  check(oldPublic.versionId === reviewed.versionId && oldPublic.title === reviewed.draft.title, '保存修订稿期间公开题库继续提供已发布原版');
}
await raw('/auth/sign-out', { method: 'POST' }, registered.token);
console.log(`全部 ${checks} 项真实审核与修订检查通过；初审结果为 ${lastStatus}，实际发布状态为 ${wasPublished ? '已发布' : '未发布'}。`);
