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
  await expect(page.locator('.composer-input')).toHaveAttribute('rows', '1');
  await expect(page.locator('.composer-input')).toHaveCSS('height', '44px');
  await page.locator('.composer-input').fill('故事里有人死亡吗？');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.confidence').last()).toContainText(/置信度 \d+%/, { timeout: 70_000 });
  await expect(page.locator('.turn-text').last()).toHaveCSS('border-radius', '4px');
  await expect(page.locator('.turn-text').last()).toHaveCSS('padding', '5px 8px');
  await expect(page.locator('.turn-result .verdict-badge').last()).toHaveCSS('border-radius', '4px');
  await expect(page.locator('.turn-result .verdict-badge').last()).toHaveCSS('padding', '1px 6px');
  for (const tab of await page.locator('.mode-tab').all()) {
    await expect(tab).toHaveCSS('border-radius', '3px');
    expect(await tab.evaluate((element) => element.getBoundingClientRect().height)).toBeLessThanOrEqual(32);
  }
}

/** 检查标题对齐页面中线，避免左右操作的文字宽度挤偏标题。 */
async function expectCenteredTitle(page: Page) {
  const offset = await page.locator('.game-topbar .brand').evaluate((title) => {
    const shell = title.closest('main')!.getBoundingClientRect();
    const heading = title.getBoundingClientRect();
    return Math.abs((heading.left + heading.right) / 2 - (shell.left + shell.right) / 2);
  });
  expect(offset).toBeLessThanOrEqual(1);
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
    await expectCenteredTitle(page);
    await expect(page.locator('.story-card')).toHaveCSS('background-image', /story-sea/);
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
    expect(await page.locator('.hint-capsule-head').evaluate((head) => head.getBoundingClientRect().height)).toBeLessThanOrEqual(20);
    const firstHint = await page.locator('.hint-capsule p').innerText();
    await page.getByRole('button', { name: '提示 1/3', exact: true }).click();
    await expect(page.locator('.hint-capsule')).toContainText('2/3');
    await page.getByRole('button', { name: '上一条提示' }).click();
    await expect(page.locator('.hint-capsule p')).toHaveText(firstHint);
    await page.getByRole('button', { name: '下一条提示' }).click();
    await expect(page.locator('.hint-capsule')).toContainText('2/3');
    const english = await getData(context.request, `/puzzles/${puzzle.id}?language=en`);
    await expect(page.getByRole('button', { name: 'EN', exact: true })).toHaveCount(0);
    await page.goto('/');
    await page.getByRole('button', { name: 'EN', exact: true }).click();
    await page.goto(`/rooms/${created.roomId}`);
    await expect(page.locator('.brand-sm')).toHaveText(english.title);
    await expect(page.locator('.story')).toHaveText(english.surface);
    await page.getByRole('button', { name: /^Players/ }).click();
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
  await expect(page.locator('.host-intro')).toHaveCount(0);
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

for (const viewport of [{ width: 390, height: 740 }, { width: 1440, height: 900 }]) {
  test(`单人布局 ${viewport.width}px：标题居中、紧凑提示、完整聚焦边框与随机换题`, async ({ page, context }) => {
    await page.setViewportSize(viewport);
    const catalog = await getData(context.request, '/puzzles?language=zh&limit=1');
    const puzzle = catalog.items[0];
    expect(puzzle).toBeDefined();
    await page.goto(`/solo/${puzzle.id}?lang=zh`);
    await expect(page.locator('.brand-sm')).toHaveText(puzzle.title);
    await expectCenteredTitle(page);
    await expect(page.locator('.host-intro')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'EN', exact: true })).toHaveCount(0);
    await expect(page.locator('.story-card')).toHaveCSS('background-image', /story-sea/);
    await expect(page.locator('.solo-story')).toHaveCSS('scrollbar-width', 'thin');
    await page.locator('.composer-input').focus();
    await expect(page.locator('.composer-input')).toHaveCSS('outline-offset', '-2px');
    await page.getByRole('button', { name: '提示 0/3', exact: true }).click();
    expect(await page.locator('.hint-capsule-head').evaluate((head) => head.getBoundingClientRect().height)).toBeLessThanOrEqual(20);
    for (const button of await page.locator('.hint-capsule-nav button').all()) {
      expect(await button.evaluate((element) => element.getBoundingClientRect().height)).toBeLessThanOrEqual(20);
    }
    const nextResponse = page.waitForResponse((response) => response.url().includes('/puzzles?') && response.request().method() === 'GET');
    await page.getByRole('button', { name: '换一题', exact: true }).click();
    const response = await nextResponse;
    expect(response.ok(), await response.text()).toBe(true);
    await expect(page).not.toHaveURL(new RegExp(`/solo/${puzzle.id}\\?lang=zh$`));
    const selectedId = new URL(page.url()).pathname.split('/').at(-1)!;
    const detail = await getData(context.request, `/puzzles/${selectedId}?language=zh`);
    await expect(page.locator('.brand-sm')).toHaveText(detail.title);
    await expect(page.locator('.hint-capsule')).toHaveCount(0);
    await expectCenteredTitle(page);
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1)).toBe(true);
  });
}

test('换一题排除全部已玩作品，刷新后保留排除记录，全部玩过时停留原题', async ({ page, context }) => {
  test.setTimeout(180_000);
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ language: 'zh', limit: '100', sort: 'latest' });
    if (cursor) query.set('cursor', cursor);
    const catalog = await getData(context.request, `/puzzles?${query}`);
    ids.push(...catalog.items.map((item: { id: string }) => item.id));
    cursor = catalog.nextCursor;
  } while (cursor !== null);
  expect(ids.length).toBeGreaterThan(1);
  const lastUnplayed = ids.at(-1)!;
  for (const id of ids.slice(0, -1)) {
    await page.goto(`/solo/${id}?lang=zh`);
    await expect(page.locator('.composer-input')).toBeVisible();
  }
  await page.reload();
  await expect(page.locator('.composer-input')).toBeVisible();
  await page.getByRole('button', { name: '换一题', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/solo/${lastUnplayed}\\?lang=zh$`));
  await expect(page.locator('.composer-input')).toBeVisible();
  await page.getByRole('button', { name: '换一题', exact: true }).click();
  await expect(page.locator('.error-text')).toContainText('当前语言的题目都已玩过，暂无新题。');
  await expect(page).toHaveURL(new RegExp(`/solo/${lastUnplayed}\\?lang=zh$`));
});

test('等待室确认选题后显示题名，支持重选和刷新恢复', async ({ page, context }) => {
  await register(context, '选题房主');
  const catalog = await getData(context.request, '/puzzles?language=zh&limit=2');
  expect(catalog.items).toHaveLength(2);
  const response = await context.request.post('/api/v1/rooms', { data: { capacity: 8 } });
  expect(response.ok()).toBe(true);
  const room = (await response.json()).data;
  try {
    await page.goto(`/rooms/${room.roomId}?lang=zh`);
    await expect(page.getByRole('button', { name: '开始本局', exact: true })).toBeDisabled();
    for (const puzzle of catalog.items) {
      await page.locator('.puzzle-selection').click();
      await page.locator('.puzzle-card').filter({ hasText: puzzle.title }).getByRole('button', { name: '选题', exact: true }).click();
      await expect(page.locator('.puzzle-selection strong')).toHaveText(puzzle.title);
      await expect(page.locator('.puzzle-selection')).toContainText('重新选题');
      await expect(page.getByRole('button', { name: '开始本局', exact: true })).toBeEnabled();
      await page.reload();
      await expect(page.locator('.puzzle-selection strong')).toHaveText(puzzle.title);
    }
    await expect(page.locator('.member-name-self')).toHaveText('选题房主');
    await expect(page.locator('body')).toHaveCSS('background-image', 'none');
    await expect(page.locator('main')).toHaveCSS('background-image', 'none');
  } finally {
    await command(context.request, room.roomId, 'close_room');
  }
});

test('我的房间历史每页五间，翻页不重复；语言切换仅在首页', async ({ page, context }) => {
  await register(context, '历史分页测试');
  for (let index = 0; index < 6; index += 1) {
    const response = await context.request.post('/api/v1/rooms', { data: { capacity: 8 } });
    expect(response.ok()).toBe(true);
    await command(context.request, (await response.json()).data.roomId, 'close_room');
  }
  const first = await getData(context.request, '/me/history?page=1&limit=5');
  const second = await getData(context.request, '/me/history?page=2&limit=5');
  expect(first.rooms).toHaveLength(5);
  expect(first.hasMore).toBe(true);
  expect(second.rooms).toHaveLength(1);
  expect(second.hasMore).toBe(false);
  expect(first.rooms.map((room: { roomId: string }) => room.roomId)).not.toContain(second.rooms[0].roomId);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'EN', exact: true })).toBeVisible();
  await page.goto('/me');
  await expect(page.getByRole('button', { name: 'EN', exact: true })).toHaveCount(0);
  const history = page.locator('section').filter({ has: page.getByRole('heading', { name: '多人历史' }) });
  await expect(history.locator('article')).toHaveCount(5);
  await history.getByRole('button', { name: '下一页' }).click();
  await expect(history.locator('article')).toHaveCount(1);
  await expect(history.getByRole('button', { name: '下一页' })).toBeDisabled();
  await history.getByRole('button', { name: '上一页' }).click();
  await expect(history.locator('article')).toHaveCount(5);
});
