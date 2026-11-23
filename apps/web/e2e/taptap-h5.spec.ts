/** H5 首轮验收使用实际网页、实际题库和 AI；断网检查直接切断浏览器网络。 */
import { test, expect, type Page } from '@playwright/test';

const h5Entry = process.env.TAPTAP_H5_URL;
const referenceEntry = process.env.TAPTAP_WEB_URL ?? 'https://sp.xiaobaozi.cn/';
test.use({ channel: 'chrome', viewport: { width: 390, height: 844 } });

/** 保留平台实际入口，只替换 HashRouter 中的站内路径。 */
function h5Url(route = '/') {
  const url = new URL(h5Entry!);
  url.hash = route;
  return url.href;
}

function debugRecords(page: Page) {
  return page.evaluate(() => (window as unknown as { __JEV_DEBUG__: { records(): unknown[] } }).__JEV_DEBUG__.records());
}

/** 核对顶栏只有一行，左侧操作和 TapTap 控件都与标题留有距离。 */
async function expectSingleRowTopbar(page: Page, width: number) {
  const topbar = page.locator('.topbar');
  await expect(topbar).toBeVisible();
  const header = (await topbar.boundingBox())!;
  const title = (await topbar.getByRole('heading').boundingBox())!;
  expect(header.height).toBeGreaterThanOrEqual(52);
  expect(header.height).toBeLessThanOrEqual(56);
  expect(title.width).toBeGreaterThan(0);
  expect(title.x + title.width).toBeLessThanOrEqual(width - 118);
  for (const control of await topbar.getByRole('button').or(topbar.getByRole('link')).all()) {
    const button = (await control.boundingBox())!;
    expect(title.x - (button.x + button.width)).toBeGreaterThanOrEqual(6);
    expect(Math.abs(button.y + button.height / 2 - (header.y + header.height / 2))).toBeLessThanOrEqual(1);
  }
}

/** 等待实际 IndexedDB 事务完成，再刷新页面检查草稿恢复。 */
async function savedDraft(page: Page, text: string) {
  await expect.poll(() => page.evaluate(async (expected) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('jev-solo');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<boolean>((resolve, reject) => {
        const request = db.transaction('solo_drafts').objectStore('solo_drafts').getAll();
        request.onsuccess = () => resolve(request.result.some((draft: { text: string }) => draft.text === expected));
        request.onerror = () => reject(request.error);
      });
    } finally { db.close(); }
  }, text)).toBe(true);
}

/** 用本地过期场景触发真实服务端拒绝，校验同一局可接着玩。 */
async function invalidateSavedSoloToken(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('jev-solo');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<string>((resolve, reject) => {
        const transaction = db.transaction('solo_sessions', 'readwrite');
        const cursor = transaction.objectStore('solo_sessions').openCursor();
        let localSessionId: string;
        cursor.onsuccess = () => {
          if (!cursor.result) {
            transaction.abort();
            return;
          }
          const row = cursor.result.value;
          localSessionId = row.localSessionId;
          cursor.result.update({ ...row, token: 'invalid-test-token' });
        };
        transaction.oncomplete = () => resolve(localSessionId);
        transaction.onabort = () => reject(transaction.error ?? new Error('找不到本地单人记录'));
      });
    } finally { db.close(); }
  });
}

test.describe('TapTap H5 共享网页', () => {
  test.skip(!h5Entry, '需要 TAPTAP_H5_URL 指向实际 H5 构建入口');

  test('首页入口、移动布局与网页一致，子目录刷新和登录链接正确', async ({ page, context }, info) => {
    const reference = await context.newPage();
    const failures: string[] = [];
    page.on('pageerror', (error) => failures.push(error.message));
    for (const width of [320, 375, 390, 430, 1024]) {
      await page.setViewportSize({ width, height: 844 });
      await reference.setViewportSize({ width, height: 844 });
      await Promise.all([page.goto(h5Url()), reference.goto(referenceEntry)]);
      await expect(page.getByRole('button', { name: '单人推理', exact: true })).toBeVisible();
      await expect(reference.getByRole('button', { name: '单人推理', exact: true })).toBeVisible();
      expect(await page.getByRole('button').allTextContents()).toEqual((await reference.getByRole('button').allTextContents()).filter((text) => text !== 'App 下载' && text !== 'Get the App'));
      await expect(page.locator('.site-footer')).toHaveCount(0);
      await expectSingleRowTopbar(page, width);
      if (width >= 375) {
        const title = (await page.locator('.topbar').getByRole('heading').boundingBox())!;
        expect(Math.abs(title.x + title.width / 2 - width / 2)).toBeLessThan(1);
      }
      await expect(page.getByRole('button', { name: '登录', exact: true })).toHaveCount(0);
      const guideButton = page.getByRole('button', { name: '互动指南' });
      await expect(page.locator('.hero-card').getByRole('button', { name: '互动指南' })).toBeVisible();
      const guide = (await guideButton.boundingBox())!;
      const tagline = (await page.locator('.tagline').boundingBox())!;
      expect(guide.x).toBeGreaterThanOrEqual(tagline.x + tagline.width);
      if (width === 320) {
        const icon = (await guideButton.locator('.help-icon').boundingBox())!;
        expect(guide.width).toBeGreaterThanOrEqual(44);
        expect(guide.height).toBeGreaterThanOrEqual(44);
        expect(icon.width).toBeLessThan(guide.width);
        expect(icon.height).toBeLessThan(guide.height);
        // 点在可见圆圈外面，确认透明区域仍能打开指南。
        await guideButton.click({ position: { x: 4, y: 4 } });
        await expect(page.getByRole('dialog', { name: '互动指南' })).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog')).toHaveCount(0);
      }
      // H5 调整页头操作位置，正文继续核对与网页一致的布局。
      const layout = (target: Page) => target.locator('.hero-card, .hero-actions, .hero-secondary').evaluateAll((nodes) => nodes.map((node) => {
        const rect = node.getBoundingClientRect();
        const contentTop = nodes[0]!.getBoundingClientRect().top;
        const style = getComputedStyle(node);
        return { x: rect.x, y: rect.y - contentTop, width: rect.width, height: rect.height, font: style.font, color: style.color };
      }));
      expect(await layout(page)).toEqual(await layout(reference));
      await page.screenshot({ path: info.outputPath(`h5-home-${width}.png`) });
      await reference.screenshot({ path: info.outputPath(`web-home-${width}.png`) });
    }
    await page.goto(h5Url('/app'));
    await expect.poll(() => new URL(page.url()).hash).toBe('#/');
    await expect(page.getByRole('button', { name: '单人推理', exact: true })).toBeVisible();
    await Promise.all([page.setViewportSize({ width: 390, height: 844 }), reference.setViewportSize({ width: 390, height: 844 })]);
    await Promise.all([page.goto(h5Url('/library?mode=solo')), reference.goto(new URL('/library?mode=solo', referenceEntry).href)]);
    await expect(page.getByRole('button', { name: '单人推理', exact: true }).first()).toBeVisible();
    await expect(reference.getByRole('button', { name: '单人推理', exact: true }).first()).toBeVisible();
    expect(await page.locator('main').innerText()).toEqual(await reference.locator('main').innerText());
    await page.screenshot({ path: info.outputPath('h5-library.png') });
    await reference.screenshot({ path: info.outputPath('web-library.png') });
    await reference.getByRole('button', { name: '单人推理', exact: true }).first().click();
    await expect(reference.getByRole('textbox').first()).toBeVisible();
    const solo = new URL(reference.url());
    await page.goto(h5Url(solo.pathname + solo.search));
    await expect(page.getByRole('textbox').first()).toBeVisible();
    await expectSingleRowTopbar(page, 390);
    expect(await page.locator('main').innerText()).toEqual(await reference.locator('main').innerText());
    const composer = (target: Page) => target.locator('.solo-bottom').boundingBox();
    expect(await composer(page)).toEqual(await composer(reference));
    await page.screenshot({ path: info.outputPath('h5-solo.png') });
    await reference.screenshot({ path: info.outputPath('web-solo.png') });
    // 实际缩放浏览器可见高度，验证聊天页页头固定、消息区收缩及输入草稿保留。
    const headerBeforeResize = (await page.locator('.topbar').boundingBox())!;
    const messagesBeforeResize = (await page.locator('.solo-chat').boundingBox())!;
    const draft = page.getByRole('textbox').first();
    await draft.fill('视口变化时保留草稿');
    for (const height of [480, 360, 844]) {
      await page.setViewportSize({ width: 390, height });
      await expect.poll(() => page.evaluate(() => parseFloat(document.documentElement.style.getPropertyValue('--taptap-viewport-height')))).toBe(height);
      const header = (await page.locator('.topbar').boundingBox())!;
      const input = (await draft.boundingBox())!;
      expect(header.y).toBe(headerBeforeResize.y);
      expect(header.height).toBe(headerBeforeResize.height);
      expect(input.y + input.height).toBeLessThanOrEqual(height);
      await expect(draft).toHaveValue('视口变化时保留草稿');
      if (height < 844) expect((await page.locator('.solo-chat').boundingBox())!.height).toBeLessThan(messagesBeforeResize.height);
      await page.screenshot({ path: info.outputPath(`h5-solo-height-${height}.png`) });
    }
    for (const [name, next] of [
      ['开房间（登录）', '/library?mode=select'],
      ['大厅', '/hall'],
      ['我的作品', '/creations'],
      ['好友', '/friends'],
      ['通知', '/notifications'],
    ]) {
      await page.goto(h5Url());
      await page.getByRole('button', { name, exact: true }).click();
      await expect.poll(() => {
        const [route, search] = new URL(page.url()).hash.slice(1).split('?');
        return { route, next: new URLSearchParams(search).get('next') };
      }).toEqual({ route: '/login', next });
    }
    // H5 登录页只有 TapTap 一键登录：邮箱表单与找回密码入口均不存在
    await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'TapTap 一键登录', exact: true })).toBeVisible();
    await expect(page.getByRole('textbox')).toHaveCount(0);
    await page.setViewportSize({ width: 320, height: 844 });
    await expectSingleRowTopbar(page, 320);
    await page.locator('.lang-switch').click();
    await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
    await expectSingleRowTopbar(page, 320);
    expect(failures).toEqual([]);
    await reference.close();
  });

  test('真实单人完整流程、断网恢复、草稿和诊断脱敏', async ({ page, context }, info) => {
    const failures: string[] = [];
    const responses: Array<{ path: string; status: number }> = [];
    page.on('pageerror', (error) => failures.push(error.message));
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/v1/solo/')) expect(request.headers().authorization).toBeUndefined();
    });
    page.on('response', (response) => {
      const path = new URL(response.url()).pathname;
      if (path.startsWith('/api/v1/solo/')) responses.push({ path, status: response.status() });
    });
    await page.goto(h5Url('/library?mode=solo'));
    await page.getByRole('button', { name: '简单', exact: true }).click();
    await expect(page.getByRole('button', { name: '单人推理', exact: true }).first()).toBeEnabled();
    await page.getByRole('button', { name: '单人推理', exact: true }).first().click();
    const input = page.getByRole('textbox').first();
    await expect(input).toBeVisible();
    const initialUrl = page.url();

    const ask = async (text: string) => {
      await input.fill(text);
      const response = page.waitForResponse((value) => new URL(value.url()).pathname === '/api/v1/solo/judge');
      await page.getByRole('button', { name: '发送', exact: true }).click();
      expect((await response).status()).toBe(200);
      await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
    };
    await ask('故事里有人死吗');
    await page.screenshot({ path: info.outputPath('h5-solo-answer.png') });

    await input.fill('这条草稿需要保留');
    await savedDraft(page, '这条草稿需要保留');
    await page.reload();
    await expect(input).toHaveValue('这条草稿需要保留');
    await context.setOffline(true);
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(input).toHaveValue('这条草稿需要保留');
    await expect.poll(async () => JSON.stringify(await debugRecords(page))).toContain('network-error');
    const offlineRecords = await debugRecords(page);
    await context.setOffline(false);
    const sessionId = await invalidateSavedSoloToken(page);
    await page.reload();
    await expect(input).toHaveValue('这条草稿需要保留');
    const renewalStart = responses.length;
    const renewed = page.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/v1/solo/judge' && response.status() === 200);
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await renewed;
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
    expect(responses.slice(renewalStart)).toEqual([
      { path: '/api/v1/solo/judge', status: 400 },
      { path: '/api/v1/solo/sessions', status: 200 },
      { path: '/api/v1/solo/judge', status: 200 },
    ]);
    expect(await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('jev-solo');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        return await new Promise<string[]>((resolve, reject) => {
          const request = db.transaction('solo_sessions').objectStore('solo_sessions').getAllKeys();
          request.onsuccess = () => resolve(request.result as string[]);
          request.onerror = () => reject(request.error);
        });
      } finally { db.close(); }
    })).toEqual([sessionId]);

    await page.getByRole('button', { name: '还原真相', exact: true }).click();
    await input.fill('主人公发现了隐藏的真相');
    const solve = page.waitForResponse((value) => new URL(value.url()).pathname === '/api/v1/solo/solve');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    expect((await solve).status()).toBe(200);
    await expect(page.getByRole('button', { name: '提示 0/3', exact: true })).toBeEnabled();
    const hint = page.waitForResponse((value) => new URL(value.url()).pathname === '/api/v1/solo/hints');
    await page.getByRole('button', { name: '提示 0/3', exact: true }).click();
    expect((await hint).status()).toBe(200);
    await page.getByRole('button', { name: '看汤底', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '确定', exact: true }).click();
    await expect(page.locator('.answer-panel')).toBeVisible();
    await page.screenshot({ path: info.outputPath('h5-solo-revealed.png') });
    await page.getByRole('button', { name: '换一题', exact: true }).click();
    await expect.poll(() => page.url()).not.toBe(initialUrl);
    await expect(input).toBeVisible();

    const records = [...offlineRecords, ...await debugRecords(page)];
    const diagnosticText = JSON.stringify(records);
    expect(diagnosticText).toContain('network-error');
    expect(diagnosticText).toContain('requestId');
    for (const secret of ['故事里有人死吗', '这条草稿需要保留', '主人公发现了隐藏的真相', 'Authorization', 'Bearer ']) expect(diagnosticText).not.toContain(secret);
    expect(failures).toEqual([]);
    await info.attach('http-results', { body: JSON.stringify(responses, null, 2), contentType: 'application/json' });
    await info.attach('diagnostics', { body: JSON.stringify(records, null, 2), contentType: 'application/json' });
  });
});
