/**
 * Playwright 运行时定位（仓库内共享）。
 *
 * 背景：仓库根工作区没有直接装 playwright（装在 apps/web 里），且 pnpm 的
 * 虚拟目录布局下 `require('playwright')` 解析不到；已下载的 Chromium build 号
 * 也可能与 playwright 自带版本不一致。两件事都在这里兜住：
 *  - playwright：优先根依赖，其次从 apps/web 的 @playwright/test 真实路径反查；
 *  - 浏览器：探测 %LOCALAPPDATA%\ms-playwright 下已装的最高版本，显式指定 exe。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 定位 playwright 包 */
export function resolvePlaywright() {
  const candidates = [];
  const push = (p) => {
    if (p && !candidates.includes(p)) candidates.push(p);
  };
  try {
    push(require.resolve('playwright'));
  } catch {
    /* 根工作区没装，走反查 */
  }
  for (const base of [path.join(ROOT, 'apps/web/package.json'), path.join(ROOT, 'package.json')]) {
    try {
      const r = createRequire(base);
      const resolved = fs.realpathSync(r.resolve('@playwright/test'));
      const r2 = createRequire(resolved);
      push(r2.resolve('playwright'));
      push(path.join(resolved, '..', '..', '..', 'playwright', 'index.js'));
    } catch {
      /* 该工作区没有 @playwright/test */
    }
  }
  for (const c of candidates) {
    try {
      return require(c);
    } catch {
      /* 试下一个 */
    }
  }
  throw new Error(
    '找不到 playwright。请在根工作区执行 `pnpm add -Dw playwright` 后重试（脚本只用于本地渲染与自动化）。',
  );
}

/** 探测本机已安装的 Chromium 可执行文件 */
export function resolveChromiumExecutable() {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright'),
    path.join(os.homedir(), '.cache', 'ms-playwright'),
    path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'),
  ].filter(Boolean);
  const candidates = [];
  for (const root of roots) {
    let dirs = [];
    try {
      dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      continue;
    }
    for (const d of dirs) {
      const m = /^(chromium|chromium_headless_shell)-(\d+)$/.exec(d.name);
      if (!m) continue;
      const ver = Number(m[2]);
      const base = path.join(root, d.name);
      const exes = [
        path.join(base, 'chrome-win64', 'chrome.exe'),
        path.join(base, 'chrome-win', 'chrome.exe'),
        path.join(base, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'),
        path.join(base, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
        path.join(base, 'chrome-linux', 'chrome'),
      ];
      for (const e of exes) {
        if (fs.existsSync(e)) {
          candidates.push({ ver, kind: m[1], exe: e });
          break;
        }
      }
    }
  }
  if (!candidates.length) return undefined;
  candidates.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'chromium' ? -1 : 1;
    return b.ver - a.ver;
  });
  return candidates[0].exe;
}

/** 启动 Chromium：优先用本机已装版本，缺省无头 */
export async function launchBrowser({ headless = true, args = [] } = {}) {
  const pw = resolvePlaywright();
  const executablePath = resolveChromiumExecutable();
  return pw.chromium.launch({
    headless,
    ...(executablePath ? { executablePath } : {}),
    args: ['--font-render-hinting=none', ...args],
  });
}
