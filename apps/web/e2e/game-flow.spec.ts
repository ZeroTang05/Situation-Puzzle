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

test('题库卡片展示已玩角标、固定票数布局，并用所选题目开房', async ({ page, context }) => {
  await register(context, '题库卡片测试');
  const catalog = await getData(context.request, '/puzzles?language=zh&limit=1');
  const puzzle = catalog.items[0];
  expect(puzzle).toBeDefined();
  await page.goto(`/solo/${puzzle.id}?lang=zh`);
  await expect(page.locator('.brand-sm')).toHaveText(puzzle.title);
  await page.goto('/library?lang=zh');
  const card = page.locator('.puzzle-card').filter({ hasText: puzzle.title }).first();
  await expect(card).toBeVisible();
  await expect(page.locator('.library-intro')).toHaveCount(0);
  await expect(card.locator('.puzzle-played')).toHaveText('已玩');
  await expect(card.locator('.puzzle-card-author')).toBeVisible();
  await expect(card.locator('.puzzle-card-votes > span')).toHaveCount(2);
  await expect(card.getByRole('button', { name: '单人游玩' })).toBeVisible();
  await card.getByRole('button', { name: '一键开房间' }).click();
  await expect(page).toHaveURL(/\/rooms\/[0-9a-f-]+/);
  const roomId = new URL(page.url()).pathname.split('/').at(-1)!;
  try {
    await expect.poll(async () => (await getData(context.request, `/rooms/${roomId}/snapshot`)).controlVersion).toBeGreaterThan(0);
    await command(context.request, roomId, 'start_round');
    expect((await getData(context.request, `/rooms/${roomId}/snapshot`)).round.puzzleId).toBe(puzzle.id);
  } finally {
    await command(context.request, roomId, 'close_room');
  }
});

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

test('同一用户可同时创建和加入多个房间，退出一间不影响另一间', async ({ page, context, browser }) => {
  await register(context, '多房房主');
  const guest = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  const created: Array<{ roomId: string; inviteToken: string }> = [];
  let guestCreated: { roomId: string } | null = null;
  try {
    await register(guest, '多房成员');
    for (let index = 0; index < 2; index += 1) {
      const response = await context.request.post('/api/v1/rooms', { data: { capacity: 8 } });
      expect(response.ok(), await response.text()).toBe(true);
      created.push((await response.json()).data);
    }
    expect(created[0]!.roomId).not.toBe(created[1]!.roomId);
    expect((await getData(context.request, '/rooms/entitlement-preview')).freeRemaining).toBe(8);
    for (const room of created) {
      const response = await guest.request.post('/api/v1/rooms/join', { data: { token: room.inviteToken } });
      expect(response.ok(), await response.text()).toBe(true);
      expect((await response.json()).data.roomId).toBe(room.roomId);
      expect((await getData(guest.request, `/rooms/${room.roomId}/snapshot`)).members).toHaveLength(2);
    }
    const thirdResponse = await guest.request.post('/api/v1/rooms', { data: { capacity: 8 } });
    expect(thirdResponse.ok(), await thirdResponse.text()).toBe(true);
    guestCreated = (await thirdResponse.json()).data;
    await page.goto('/');
    await expect(page.getByRole('button', { name: '开房间', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: '进行中的房间' }).getByRole('button')).toHaveCount(2);
    expect((await getData(guest.request, '/me/active-rooms')).rooms).toHaveLength(3);
    await command(guest.request, created[0]!.roomId, 'leave');
    expect((await getData(guest.request, `/rooms/${created[1]!.roomId}/snapshot`)).members).toHaveLength(2);
    await command(guest.request, created[1]!.roomId, 'leave');
  } finally {
    if (guestCreated) await command(guest.request, guestCreated.roomId, 'close_room');
    for (const room of created) await command(context.request, room.roomId, 'close_room');
    await guest.close();
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

test('单人主界面只在揭晓后展示评价，操作区固定在屏幕内', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 740 });
  const catalog = await getData(context.request, '/puzzles?language=zh&limit=1');
  const puzzle = catalog.items[0];
  expect(puzzle).toBeDefined();
  await page.goto(`/solo/${puzzle.id}?lang=zh`);
  await expect(page.locator('.host-intro')).toBeVisible();
  await expect(page.getByRole('group', { name: '题目投票' })).toHaveCount(0);
  await expect(page.locator('.topbar').getByRole('button', { name: '汤底' })).toHaveCount(0);
  await expect(page.locator('.solo-action-row button')).toHaveCount(3);
  await expect(page.locator('.solo-action-row')).toContainText('看汤底');
  await expect(page.locator('.solo-tools')).toHaveCount(0);
  await expect(page.locator('.solo-composer textarea')).toHaveAttribute('rows', '1');
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1)).toBe(true);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '看汤底' }).click();
  await expect(page.locator('.answer-panel')).toBeVisible();
  await expect(page.getByRole('group', { name: '题目投票' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1)).toBe(true);
});
