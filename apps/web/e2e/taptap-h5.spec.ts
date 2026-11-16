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

test.describe('TapTap H5 共享网页', () => {
  test.skip(!h5Entry, '需要 TAPTAP_H5_URL 指向实际 H5 构建入口');

  test('首页入口、移动布局与网页一致，子目录刷新和登录链接正确', async ({ page, context }, info) => {
    const reference = await context.newPage();
    for (const width of [375, 390, 430]) {
      await page.setViewportSize({ width, height: 844 });
      await reference.setViewportSize({ width, height: 844 });
      await Promise.all([page.goto(h5Url()), reference.goto(referenceEntry)]);
      await expect(page.getByRole('button', { name: '单人推理', exact: true })).toBeVisible();
      await expect(reference.getByRole('button', { name: '单人推理', exact: true })).toBeVisible();
      expect(await page.getByRole('button').allTextContents()).toEqual((await reference.getByRole('button').allTextContents()).filter((text) => text !== 'App 下载' && text !== 'Get the App'));
      await expect(page.locator('.site-footer')).toHaveCount(0);
      const header = (await page.locator('.topbar').boundingBox())!;
      const title = (await page.locator('.topbar > .brand').boundingBox())!;
      const actions = (await page.locator('.topbar-actions').boundingBox())!;
      expect(title.x + title.width).toBeLessThanOrEqual(width - 118);
      expect(actions.y).toBeGreaterThanOrEqual(header.y + 44);
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
    await page.goto(h5Url());
    await page.getByRole('button', { name: '登录', exact: true }).click();
    // H5 登录页只有 TapTap 一键登录：邮箱表单与找回密码入口均不存在
    await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'TapTap 一键登录', exact: true })).toBeVisible();
    await expect(page.getByRole('textbox')).toHaveCount(0);
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
    await context.setOffline(false);
    await ask('故事里都是人吗');

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

    const records = await page.evaluate(() => (window as unknown as { __JEV_DEBUG__: { records(): unknown[] } }).__JEV_DEBUG__.records());
    const diagnosticText = JSON.stringify(records);
    expect(diagnosticText).toContain('network-error');
    expect(diagnosticText).toContain('requestId');
    for (const secret of ['故事里有人死吗', '这条草稿需要保留', '主人公发现了隐藏的真相', 'Authorization', 'Bearer ']) expect(diagnosticText).not.toContain(secret);
    expect(failures).toEqual([]);
    await info.attach('http-results', { body: JSON.stringify(responses, null, 2), contentType: 'application/json' });
    await info.attach('diagnostics', { body: JSON.stringify(records, null, 2), contentType: 'application/json' });
  });
});
