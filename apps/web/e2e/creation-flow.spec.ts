/** 真实浏览器、API、任务进程和 Jev 的创作流程；发布测试需真实审核员账号。 */
import { test, expect, type BrowserContext, type APIRequestContext } from '@playwright/test';
import { creationDetailSchema, creationLicenseVersion, type CreationDetail } from '@jev/contracts';

/** 创建独立作者账号，真实登录会话由浏览器上下文保存。 */
async function register(context: BrowserContext) {
  const response = await context.request.post('/api/v1/auth/sign-up/email', { data: { email: `creation-${crypto.randomUUID()}@example.com`, password: 'Jev-E2E-password-2026', name: '创作测试作者' } });
  expect(response.ok(), await response.text()).toBe(true);
}
async function detail(request: APIRequestContext, id: string): Promise<CreationDetail> {
  const response = await request.get(`/api/v1/creations/${id}`);
  expect(response.ok(), await response.text()).toBe(true);
  return creationDetailSchema.parse((await response.json()).data);
}
const condition = (version: CreationDetail) => ({ expectedVersionId: version.versionId, expectedUpdatedAt: version.updatedAt });
const manuscript = { title: '送信的邮差', surface: '邮差经过一间屋子。他没有把信放进信箱，却救下了屋里的老人。发生了什么？', answer: '邮差闻到煤气味，发现屋里老人煤气中毒昏迷，立刻报警，救援人员救出了老人。', hints: ['邮差发现了异常。', '异常是一种气味。', '老人因煤气中毒昏迷。'], coreFacts: ['老人煤气中毒昏迷', '邮差闻到煤气味后报警', '救援人员救出老人'], causalChain: '煤气泄漏→老人中毒昏迷→邮差闻到气味→报警→救援人员救人', language: 'zh', difficulty: 'easy', licenseBasis: '本测试稿件由作者原创，仅用于开发环境流程验收。', sourceUrl: '', authorDisplay: { mode: 'anonymous' }, testCases: [{ kind: 'ask', input: '老人是因为煤气中毒昏迷的吗？', expected: 'yes', reason: '明确的核心事实', criticality: 'critical' }] };

test('作者保存、私密试题、权限隔离、提交撤回与版本保留', async ({ page, context, browser }) => {
  await register(context);
  await page.goto('/creations/new?lang=zh');
  await page.getByLabel('标题', { exact: true }).fill('只写了标题的草稿');
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(page).toHaveURL(/\/creations\/[0-9a-f-]+$/);
  const id = new URL(page.url()).pathname.split('/').at(-1)!;
  const first = await detail(context.request, id);
  expect(first.status).toBe('draft');
  const oldPreview = await context.request.post(`/api/v1/creations/${id}/test-session`);
  expect(oldPreview.status()).toBe(400);
  const saved = await context.request.patch(`/api/v1/creations/${id}`, { data: { ...manuscript, ...condition(first) } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const conflict = await context.request.patch(`/api/v1/creations/${id}`, { data: { ...manuscript, title: '旧页面覆盖', ...condition(first) } });
  expect(conflict.status()).toBe(409);
  const issued = await context.request.post(`/api/v1/creations/${id}/test-session`);
  expect(issued.ok(), await issued.text()).toBe(true);
  const token = (await issued.json()).data.token;
  const beforeEdit = await detail(context.request, id);
  expect((await context.request.patch(`/api/v1/creations/${id}`, { data: { ...manuscript, title: '新版送信的邮差', ...condition(beforeEdit) } })).ok()).toBe(true);
  expect((await context.request.post('/api/v1/solo/reveal', { data: { token, confirmed: true } })).status()).toBe(409);
  const baseURL = test.info().project.use.baseURL;
  if (!baseURL) throw new Error('端到端测试缺少网页地址');
  const guest = await browser.newContext({ baseURL });
  try {
    await register(guest);
    expect((await guest.request.get(`/api/v1/creations/${id}`)).status()).toBe(404);
    expect((await guest.request.post(`/api/v1/creations/${id}/test-session`)).status()).toBe(404);
    expect((await guest.request.get(`/api/v1/puzzles/${id}?language=zh`)).status()).toBe(404);
    await page.reload();
    await page.getByRole('button', { name: '私人试题', exact: true }).click();
    await expect(page).toHaveURL(`/creations/${id}/preview`);
    await page.getByLabel('问题或还原', { exact: true }).fill(manuscript.testCases[0]!.input);
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.locator('.confidence').last()).toContainText(/置信度 \d+%/, { timeout: 70_000 });
    await page.reload();
    await expect(page.locator('.confidence').last()).toContainText(/置信度 \d+%/);
    await page.getByRole('link', { name: '回到编辑' }).click();
    await page.getByRole('checkbox', { name: /^我确认拥有原创/ }).check();
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: '提交审核', exact: true }).click();
    await expect.poll(async () => (await detail(context.request, id)).status).not.toBe('draft');
    const submitted = await detail(context.request, id);
    expect((await context.request.patch(`/api/v1/creations/${id}`, { data: { ...manuscript, ...condition(submitted) } })).status()).toBe(409);
    const withdrawn = await context.request.post(`/api/v1/creations/${id}/withdraw`, { data: condition(submitted) });
    expect(withdrawn.ok(), await withdrawn.text()).toBe(true);
    const next = await detail(context.request, id);
    expect(next.status).toBe('draft'); expect(next.versionNo).toBe(2);
    expect(next.versions.find((version) => version.versionId === submitted.versionId)?.status).toBe('changes_requested');
    expect(next.draft.answer).toBe(manuscript.answer);
  } finally { await guest.close(); }
});

test('授权与内容分别批准后公开，修改新稿保留线上版本', async ({ context, browser }) => {
  test.setTimeout(600_000);
  const email = process.env.E2E_ADMIN_EMAIL; const password = process.env.E2E_ADMIN_PASSWORD;
  if (!email || !password) throw new Error('发布验收需要 E2E_ADMIN_EMAIL 和 E2E_ADMIN_PASSWORD，账号必须已有审核员角色');
  await register(context);
  const baseURL = test.info().project.use.baseURL;
  if (!baseURL) throw new Error('端到端测试缺少网页地址');
  const admin = await browser.newContext({ baseURL });
  let id: string | undefined;
  try {
    const login = await admin.request.post('/api/v1/auth/sign-in/email', { data: { email, password } });
    expect(login.ok(), await login.text()).toBe(true);
    const created = await context.request.post('/api/v1/creations', { data: manuscript });
    expect(created.ok(), await created.text()).toBe(true);
    id = (await created.json()).data.puzzleId;
    if (!id) throw new Error('创建响应缺少作品编号');
    const draft = await detail(context.request, id);
    const submitted = await context.request.post(`/api/v1/creations/${id}/submit`, { data: { ...condition(draft), agreementAccepted: true, agreementVersion: creationLicenseVersion } });
    expect(submitted.ok(), await submitted.text()).toBe(true);
    await expect.poll(async () => (await detail(context.request, id!)).status, { timeout: 500_000, intervals: [1000, 3000, 5000] }).toBe('pending_review');
    const version = await detail(context.request, id);
    expect((await context.request.post(`/api/v1/admin/puzzle-versions/${version.versionId}/approve`, { data: { reason: '作者尝试自发' } })).status()).toBe(403);
    expect((await admin.request.post(`/api/v1/admin/puzzle-versions/${version.versionId}/approve`, { data: { reason: '检查授权门槛' } })).status()).toBe(409);
    const rights = await admin.request.post(`/api/v1/admin/puzzles/${id}/rights/approve`, { data: { reason: '开发环境原创授权核验', expectedVersionId: version.versionId } });
    expect(rights.ok(), await rights.text()).toBe(true);
    const approved = await admin.request.post(`/api/v1/admin/puzzle-versions/${version.versionId}/approve`, { data: { reason: '开发环境内容质量核验' } });
    expect(approved.ok(), await approved.text()).toBe(true);
    const publicResponse = await context.request.get(`/api/v1/puzzles/${id}?language=zh`);
    expect(publicResponse.ok(), await publicResponse.text()).toBe(true);
    const published = (await publicResponse.json()).data;
    expect(published.title).toBe(manuscript.title); expect(published).not.toHaveProperty('answer'); expect(published).not.toHaveProperty('authorUserId');
    const live = await detail(context.request, id);
    const revised = await context.request.post(`/api/v1/creations/${id}/revise`, { data: condition(live) });
    expect(revised.ok(), await revised.text()).toBe(true);
    expect((await admin.request.post(`/api/v1/admin/puzzle-versions/${version.versionId}/approve`, { data: { reason: '核对旧审核结果不可再次发布' } })).status()).toBe(409);
    const next = await detail(context.request, id);
    expect(next.status).toBe('draft'); expect(next.versionNo).toBe(2);
    const edit = await context.request.patch(`/api/v1/creations/${id}`, { data: { ...next.draft, title: '新版标题', ...condition(next) } });
    expect(edit.ok(), await edit.text()).toBe(true);
    expect((await (await context.request.get(`/api/v1/puzzles/${id}?language=zh`)).json()).data.title).toBe(manuscript.title);
  } finally {
    try {
      if (id) {
        const cleanup = await admin.request.post(`/api/v1/admin/puzzles/${id}/takedown`, { data: { reason: '结束开发环境发布验收' } });
        expect(cleanup.ok(), await cleanup.text()).toBe(true);
      }
    } finally { await admin.close(); }
  }
});
