#!/usr/bin/env node
// B站 Toy 静态包构建：产出 toy-dist/toy-<slug>.zip（入口 index.html 在压缩包根部）。
// 用法：pnpm build:toy <slug> [--api https://…] [--preview]
//   slug 必须与 B站 Toy 上传页填写的自定义路径一致（发布后不可改）；
//   --api 覆盖后端地址（默认正式 worker）；
//   --preview 构建完成后在 http://localhost:4173/toy/<slug>/ 起本地静态服务器，供上传前检查。
//
// 不改动源码树：在 .toy-workspace/ 里组装一份裁剪副本再构建——
//   1) 剔除静态导出不支持、也不该进公开包的部分：app/api、app/admin、proxy.ts 不复制；
//   2) data/library*.json 复制时剥掉 answer 字段，保证汤底不进 JS 包（Toy 审核红线）；
//   3) node_modules 用 Windows junction / 符号链接指回主目录，副本不占空间；
//   4) 在副本里带 TOY_BUILD=1 / TOY_SLUG / NEXT_PUBLIC_API_URL 跑 next build（独立 .next，可与 pnpm dev 并行）。

import { spawnSync } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, statSync, symlinkSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZipArchive } from 'archiver';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK = path.join(ROOT, '.toy-workspace');
const OUT = path.join(ROOT, 'out'); // 构建产物挪到这里保留，供预览和二次检查
const DIST = path.join(ROOT, 'toy-dist');
const DEFAULT_API = 'https://situation-puzzle-api.xiaobaozi.cn';
const SIZE_LIMIT = 50 * 1024 * 1024; // B站 Toy 的单包上限

/** 脚本内的可控失败：统一在最外层打印并置非零退出码。 */
class BuildError extends Error {}
function fail(message) {
  throw new BuildError(message);
}

/** 递归列出目录下全部文件。 */
async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else files.push(full);
  }
  return files;
}

function formatSize(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)}MB` : `${(bytes / 1024).toFixed(1)}KB`;
}

/** 删除上一次运行残留的工作目录：先摘掉 node_modules 链接再递归删，避免链接被当普通目录穿透。 */
async function cleanWorkspace() {
  const link = path.join(WORK, 'node_modules');
  if (existsSync(link)) await rm(link, { force: true });
  await rm(WORK, { recursive: true, force: true });
}

// —— 参数解析（slug 位置参数 + 可选 flag）——
const flags = { api: DEFAULT_API, preview: false };
const slug = process.argv[2];
for (let i = 3; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === '--preview') flags.preview = true;
  else if (arg === '--api') flags.api = process.argv[(i += 1)] ?? fail('--api 需要一个完整地址参数，例如 https://example.com');
  else fail(`未知参数：${arg}`);
}

try {
  await main();
} catch (error) {
  // BuildError 是本脚本的可控失败，只打印信息；其他异常带堆栈，方便排查
  console.error(error instanceof BuildError ? `✖ ${error.message}` : error);
  process.exitCode = 1;
}

async function main() {
  if (!slug || slug.length > 64 || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(slug)) {
    fail('用法：pnpm build:toy <slug>，slug 为小写字母/数字/连字符，与 B站 Toy 上传页的自定义路径一致');
  }
  try {
    new URL(flags.api);
  } catch {
    fail(`--api 地址不合法：${flags.api}`);
  }

  await cleanWorkspace();
  let answers = [];
  try {
    // 1) 组装裁剪副本：app 去掉 api 与 admin，工具链与资源照常复制
    const excluded = [path.join(ROOT, 'app', 'api'), path.join(ROOT, 'app', 'admin')].map(path.normalize);
    await cp(path.join(ROOT, 'app'), path.join(WORK, 'app'), {
      recursive: true,
      filter: (source) => !excluded.includes(path.normalize(source)),
    });
    for (const rel of ['lib', 'public', 'next.config.ts', 'tsconfig.json', 'package.json', 'eslint.config.mjs']) {
      if (!existsSync(path.join(ROOT, rel))) continue;
      await cp(path.join(ROOT, rel), path.join(WORK, rel), { recursive: true });
    }

    // 2) 题库换成无汤底版本：记录每条 answer 原文，构建后扫描产物防泄漏
    answers = [];
    await mkdir(path.join(WORK, 'data'), { recursive: true });
    for (const rel of ['data/library.json', 'data/library.en.json']) {
      const source = path.join(ROOT, rel);
      if (!existsSync(source)) fail(`找不到 ${rel}`);
      const soups = JSON.parse(await readFile(source, 'utf8'));
      for (const soup of soups) {
        if (soup.answer) answers.push(soup.answer);
        delete soup.answer;
      }
      await writeFile(path.join(WORK, rel), `${JSON.stringify(soups, null, 2)}\n`);
    }

    // 3) node_modules 链接回主目录（junction 不需要管理员权限）
    symlinkSync(path.join(ROOT, 'node_modules'), path.join(WORK, 'node_modules'), 'junction');

    // 4) 静态构建：独立 .next 缓存，与 pnpm dev 互不干扰
    console.log(`▸ next build：slug=${slug}，后端=${flags.api}`);
    const nextBin = path.join(WORK, 'node_modules', 'next', 'dist', 'bin', 'next');
    const build = spawnSync(process.execPath, [nextBin, 'build'], {
      cwd: WORK,
      stdio: 'inherit',
      env: { ...process.env, TOY_BUILD: '1', TOY_SLUG: slug, NEXT_PUBLIC_API_URL: flags.api },
    });
    if (build.status !== 0) fail('next build 失败，看上方输出定位');

    // 5) 产物挪到根目录 out/ 保留（预览要用），再校验 + 打包
    await rm(OUT, { recursive: true, force: true });
    await rename(path.join(WORK, 'out'), OUT);
    await verifyOutput(answers);
    await mkdir(DIST, { recursive: true });
    const zipPath = path.join(DIST, `toy-${slug}.zip`);
    await makeZip(OUT, zipPath);

    const zipSize = (await stat(zipPath)).size;
    if (zipSize > SIZE_LIMIT) fail(`ZIP ${formatSize(zipSize)} 超过 B站 Toy 的 50MB 上限`);
    const files = await walk(OUT);
    const totalSize = (await Promise.all(files.map((file) => stat(file)))).reduce((sum, info) => sum + info.size, 0);
    console.log(`✔ 完成：${zipPath}`);
    console.log(`  ${files.length} 个文件，解压 ${formatSize(totalSize)}，ZIP ${formatSize(zipSize)}`);
    console.log(`  上传 B站 Toy 时自定义路径填「${slug}」；压缩包根部的 index.html 就是入口`);
  } finally {
    await cleanWorkspace();
    console.log('▸ 已清理 .toy-workspace/（源码树未被改动）');
  }

  if (flags.preview) await servePreview(slug);
}

/** 产物三重校验：入口文件、子路径前缀、汤底泄漏。任何一项不过都中止打包。 */
async function verifyOutput(answers) {
  if (!existsSync(path.join(OUT, 'index.html'))) fail('out/index.html 缺失：静态导出产物不完整');

  // Toy 页面挂在 /toy/<slug>/ 子路径下，HTML 里指向站点根的绝对引用会 404/白屏
  const prefix = `/toy/${slug}`;
  const badRefs = [];
  for (const file of (await walk(OUT)).filter((name) => name.endsWith('.html'))) {
    const html = await readFile(file, 'utf8');
    for (const match of html.matchAll(/(?:src|href)="(\/[^"]*)"/g)) {
      const ref = match[1];
      if (ref.startsWith('//')) continue; // 协议相对地址，按当前协议解析，不受子路径影响
      if (ref !== prefix && !ref.startsWith(`${prefix}/`)) badRefs.push(`${path.relative(ROOT, file)} → ${ref}`);
    }
  }
  if (badRefs.length > 0) fail(`产物里有未带 ${prefix} 前缀的绝对路径引用（B站子路径下会白屏）：\n  ${badRefs.join('\n  ')}`);

  // 原题库的每一条汤底（含 JSON 转义形态）都不允许出现在产物任何文件里
  const needles = answers.flatMap((answer) => [answer, JSON.stringify(answer).slice(1, -1)]).filter((text) => text.length > 0);
  const contents = await Promise.all((await walk(OUT)).map((file) => readFile(file, 'utf8').catch(() => '')));
  const leaked = needles.filter((needle) => contents.some((content) => content.includes(needle)));
  if (leaked.length > 0) fail(`汤底出现在构建产物里（Toy 审核红线）：\n  ${leaked.join('\n  ')}`);
}

/** 把目录内容打包为 ZIP：directory(dir, false) 表示内容放压缩包根部，index.html 直接可见。 */
function makeZip(dir, target) {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(target);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(dir, false);
    void archive.finalize();
  });
}

/** 本地预览：把 /toy/<slug>/ 映射到构建产物，模拟 B站的子路径访问。 */
async function servePreview(slug) {
  const base = `/toy/${slug}`;
  const mime = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
    '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png',
    '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
    '.woff2': 'font/woff2', '.map': 'application/json',
  };
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    if (pathname === '/') {
      res.writeHead(302, { Location: `${base}/` });
      res.end();
      return;
    }
    if (!pathname.startsWith(`${base}/`)) {
      res.writeHead(404).end(`仅在 ${base}/ 下预览`);
      return;
    }
    let rel = pathname.slice(base.length);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.normalize(path.join(OUT, rel));
    if (!file.startsWith(OUT + path.sep) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': mime[path.extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  await new Promise((resolve) => server.listen(4173, resolve));
  console.log(`▸ 预览：http://localhost:4173${base}/ （Ctrl+C 退出；判题请求会发往 ${flags.api}）`);
}
