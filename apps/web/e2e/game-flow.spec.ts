/** 真实浏览器 + API + 数据库 + Jev；需要真实服务与已发布的中英文题库。 */
import { test, expect, type BrowserContext, type Page, type APIRequestContext } from '@playwright/test';

const password = 'Jev-E2E-password-2026';

/** 创建本轮专用账号，通过真实密码登录，Cookie 由浏览器上下文保存。 */
async function register(context: BrowserContext, name: string) {
  const email = `game-${crypto.randomUUID()}@example.com`;
  const response = await context.request.post('/api/v1/auth/sign-up/email', { data: { email, password, name } });
  expect(response.ok(), await response.text()).toBe(true);
  return email;
}

/** 读取应用 HTTP 信封，任何接口错误直接使测试失败。 */
async function getData(request: APIRequestContext, path: string) {
  const response = await request.get(`/api/v1${path}`);
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).data;
}

/** 房间控制命令读取当前版本，遵守真实并发检查。 */
async function command(request: APIRequestContext, roomId: string, type: string, payload = {}) {
  const snapshot = await getData(request, `/rooms/${roomId}/snapshot`);
  const response = await request.post(`/api/v1/rooms/${roomId}/commands`, { data: { clientRequestId: crypto.randomUUID(), type, payload, expectedControlVersion: snapshot.controlVersion, ...(snapshot.round ? { roundId: snapshot.round.roundId } : {}) } });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).data;
}

/** 从页面发起提问，等待真实 Jev 返回置信度。 */
async function ask(page: Page) {
  await page.locator('.composer-input').fill('故事里有人死亡吗？');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.confidence').last()).toContainText(/置信度 \d+%/, { timeout: 70_000 });
}

test('游玩中邀请、登录直达、玩家管理、提示翻阅和置信度', async ({ page, context, browser }) => {
  await register(context, '房主测试');
  const catalog = await getData(context.request, '/puzzles?language=zh&limit=1');
  expect(catalog.items.length).toBe(1);
  const puzzle = catalog.items[0];
  const createdResponse = await context.request.post('/api/v1/rooms', { data: { capacity: 8 } });
  expect(createdResponse.ok()).toBe(true);
  const created = (await createdResponse.json()).data;
  const guest = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  try {
    await command(context.request, created.roomId, 'select_puzzle', { puzzleId: puzzle.id, language: 'zh' });
    await command(context.request, created.roomId, 'start_round');
    await page.goto(`/rooms/${created.roomId}?lang=zh`);
    await page.evaluate(({ roomId, token }) => localStorage.setItem(`jev.invite.${roomId}`, token), { roomId: created.roomId, token: created.inviteToken });
    await page.getByRole('button', { name: /^玩家/ }).click();
    const management = page.getByRole('region', { name: '玩家管理' });
    await expect(management).toBeVisible();
    await management.getByRole('button', { name: '邀请朋友', exact: true }).click();
    const initialLink = await page.evaluate(() => navigator.clipboard.readText());
    expect(new URL(initialLink).pathname).toBe(`/invite/${created.inviteToken}`);
    await management.getByRole('button', { name: '重置邀请链接' }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).not.toBe(initialLink);
    const link = await page.evaluate(() => navigator.clipboard.readText());
    await management.getByRole('button', { name: '邀请朋友', exact: true }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);

    const email = await register(guest, '客人测试');
    await guest.clearCookies();
    const guestPage = await guest.newPage();
    await guestPage.goto(link);
    await guestPage.getByRole('button', { name: /登录.*加入/ }).click();
    await guestPage.getByLabel('Email', { exact: true }).fill(email);
    await guestPage.getByLabel('Password', { exact: true }).fill(password);
    await guestPage.getByRole('button', { name: '登录', exact: true }).click();
    await expect(guestPage).toHaveURL(new RegExp(`/rooms/${created.roomId}$`));
    await expect(management.locator('.member-row').filter({ hasText: '客人测试' })).toBeVisible();
    await expect(page.getByRole('tab', { name: '和大家讨论', exact: true })).toHaveCount(1);
    await ask(guestPage);
    await expect(page.locator('.confidence').last()).toContainText(/置信度 \d+%/);
    const snapshot = await getData(context.request, `/rooms/${created.roomId}/snapshot`);
    expect(snapshot.turns.at(-1).confidence).toBeGreaterThanOrEqual(0);
    expect(snapshot.turns.at(-1).confidence).toBeLessThanOrEqual(1);
    await guestPage.reload();
    await expect(guestPage.locator('.confidence').last()).toContainText(/置信度 \d+%/);

    await page.getByRole('button', { name: '提示 0/3', exact: true }).click();
    await expect(page.locator('.hint-capsule')).toContainText('1/3');
    const firstHint = await page.locator('.hint-capsule p').innerText();
    await page.getByRole('button', { name: '提示 1/3', exact: true }).click();
    await expect(page.locator('.hint-capsule')).toContainText('2/3');
    await page.getByRole('button', { name: '上一条提示' }).click();
    await expect(page.locator('.hint-capsule p')).toHaveText(firstHint);
    await page.getByRole('button', { name: '下一条提示' }).click();
    await expect(page.locator('.hint-capsule')).toContainText('2/3');
    const english = await getData(context.request, `/puzzles/${puzzle.id}?language=en`);
    await page.getByRole('button', { name: 'EN', exact: true }).click();
    await expect(page.locator('.brand-sm')).toHaveText(english.title);
    await expect(page.locator('.story')).toHaveText(english.surface);
    await page.getByRole('region', { name: 'Player management' }).locator('.member-row').filter({ hasText: '客人测试' }).getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(guestPage.getByText('你已不在该房间。')).toBeVisible();
  } finally {
    await guest.close();
    await command(context.request, created.roomId, 'close_room');
  }
});

test('单人提示回看、置信度刷新恢复和中英文独立记录', async ({ page, context }) => {
  const zh = await getData(context.request, '/puzzles?language=zh&limit=1');
  const puzzle = zh.items[0];
  expect(puzzle).toBeTruthy();
  const english = await getData(context.request, `/puzzles/${puzzle.id}?language=en`);
  await page.goto(`/solo/${puzzle.id}?lang=zh`);
  await expect(page.locator('.brand-sm')).toHaveText(puzzle.title);
  await page.getByRole('button', { name: '提示 0/3', exact: true }).click();
  await expect(page.locator('.hint-capsule')).toContainText('1/3');
  const first = await page.locator('.hint-capsule p').innerText();
  await page.getByRole('button', { name: '提示 1/3', exact: true }).click();
  await expect(page.locator('.hint-capsule')).toContainText('2/3');
  await page.getByRole('button', { name: '上一条提示' }).click();
  await expect(page.locator('.hint-capsule p')).toHaveText(first);
  await ask(page);
  await page.reload();
  await expect(page.locator('.confidence').last()).toContainText(/置信度 \d+%/);
  await expect(page.locator('.hint-capsule')).toContainText('2/3');
  await page.goto(`/solo/${puzzle.id}?lang=en`);
  await expect(page.locator('.brand-sm')).toHaveText(english.title);
  await expect(page.locator('.story')).toHaveText(english.surface);
  await expect(page.locator('.chat .turn')).toHaveCount(0);
  await page.goto(`/solo/${puzzle.id}?lang=zh`);
  await expect(page.locator('.confidence').last()).toContainText(/置信度 \d+%/);
});
