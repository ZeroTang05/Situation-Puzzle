/**
 * 端到端编排器（跨平台，Windows/macOS/Linux 通用）：
 *   临时库 → 迁移 → 造题 → 起收信台/API/jobs/前端 → 跑剧本 → 清理。
 *
 * 不依赖 bash 与 docker：只要有一个可连的 PostgreSQL 即可（默认本机 54329，
 * 可用 E2E_BASE_DATABASE_URL 覆盖）。
 *
 * 用法：node scripts/e2e-node-run.mjs [multiplayer|host|votes]
 *   multiplayer  双用户多人房间全流程（真实 Jev）
 *   host        用户主持人模式（真实 Jev）
 *   votes       题目投票与署名（不调用 Jev）
 */
import { spawn } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const requireFromApi = createRequire(new URL('../apps/api/package.json', import.meta.url));
const pg = requireFromApi('pg');
const { drizzle } = requireFromApi('drizzle-orm/node-postgres');
const { migrate } = requireFromApi('drizzle-orm/node-postgres/migrator');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scenario = process.argv[2] ?? 'multiplayer';
const scripts = { multiplayer: 'e2e-multiplayer.mjs', host: 'e2e-host-mode.mjs', votes: 'e2e-votes.mjs' };
const isBrowserSuite = scenario === 'playwright';
if (!isBrowserSuite && !scripts[scenario]) {
  console.error(`未知剧本：${scenario}（可选 ${Object.keys(scripts).join(' / ')} / playwright）`);
  process.exit(2);
}

const BASE_DATABASE_URL = process.env.E2E_BASE_DATABASE_URL ?? 'postgresql://jev:jev@localhost:54339/jev';
const dbName = `jev_e2e_${scenario}_${Date.now().toString(36)}`;
const apiUrl = new URL(BASE_DATABASE_URL);
apiUrl.pathname = `/${dbName}`;
const DATABASE_URL = apiUrl.toString();

/** 从 .env.local 读取密钥（不回显）。 */
function localEnv(key) {
  try {
    const text = readFileSync(path.join(root, '.env.local'), 'utf8');
    const line = text.split(/\r?\n/).find((l) => l.startsWith(`${key}=`));
    if (!line) return '';
    return line.slice(key.length + 1).trim().replace(/^["']|["']$/g, '');
  } catch {
    return '';
  }
}

const children = [];
function start(name, command, args, env) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  child.stdout.on('data', (buf) => process.stdout.write(`[${name}] ${buf}`));
  child.stderr.on('data', (buf) => process.stderr.write(`[${name}] ${buf}`));
  children.push(child);
  return child;
}

function cleanup() {
  for (const child of children) {
    try {
      // Windows：pnpm/tsx 外面还包了一层 shell，kill 只杀外壳；用 taskkill /T 连树收
      if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
      else child.kill();
    } catch {}
  }
  try { rmSync(path.join(root, 'mailsink.json'), { force: true }); } catch {}
}

async function main() {
  const admin = new URL(BASE_DATABASE_URL);
  admin.pathname = '/postgres';
  const control = new pg.Pool({ connectionString: admin.toString() });
  await control.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  await control.query(`CREATE DATABASE "${dbName}"`);

  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  await migrate(drizzle(pool), { migrationsFolder: path.join(root, 'packages/database/drizzle') });
  // 造三道已发布题目：每道都有中英两版（题库按语言成对，浏览器套件依赖英文对照）
  for (let index = 1; index <= 3; index += 1) {
    const inserted = await pool.query(`insert into puzzles (source) values ('official') returning id`);
    for (const [language, title, surface] of [
      ['zh', `端到端测试题 ${index}`, `第 ${index} 道：一个人走进房间，灯灭了。`],
      ['en', `E2E puzzle ${index}`, `Puzzle ${index}: a man walked into a room and the light went out.`],
    ]) {
      const version = await pool.query(
        `insert into puzzle_versions (puzzle_id, version_no, language, title, surface, answer, hints, moderation_status)
         values ($1, 1, $2, $3, $4, $5, $6::jsonb, 'published') returning id`,
        [inserted.rows[0].id, language, title, surface, `答案：${title}`, JSON.stringify(['提示一'])],
      );
      if (language === 'zh') {
        await pool.query(`update puzzles set current_published_version_id = $1 where id = $2`, [version.rows[0].id, inserted.rows[0].id]);
      }
    }
  }
  await pool.end();

  const env = {
    DATABASE_URL,
    PORT: '8080',
    PUBLIC_BASE_URL: isBrowserSuite ? 'http://localhost:5173' : 'http://localhost:8080',
    APP_EXTRA_ORIGINS: 'http://localhost:8080,http://localhost:5173',
    AUTH_SECRET: 'e2e-dev-secret-0123456789abcdef',
    SOLO_TOKEN_SECRET: 'e2e-dev-secret-fedcba9876543210',
    MAIL_TRANSPORT: 'smtp',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: '2526',
    SMTP_USER: 'dev',
    SMTP_PASS: 'dev',
    MAIL_FROM: '超好玩海龟汤 <dev@localhost>',
    SINK_OUT: path.join(root, 'mailsink.json'),
    OPENCODE_API_KEY: localEnv('OPENCODE_API_KEY'),
    MINIMAX_API_KEY: localEnv('MINIMAX_API_KEY'),
    MINIMAX_BASE_URL: localEnv('MINIMAX_BASE_URL') || 'https://api.minimax.cn/anthropic',
    MINIMAX_MODEL: localEnv('MINIMAX_MODEL') || 'MiniMax-M2.7',
    E2E_DATABASE_URL: DATABASE_URL,
  };
  if (!env.OPENCODE_API_KEY) throw new Error('缺少 OPENCODE_API_KEY（.env.local）');

  start('sink', process.execPath, ['scripts/dev-mailsink.mjs'], env);
  await new Promise((r) => setTimeout(r, 800));
  start('api', process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['--dir', 'apps/api', 'exec', 'tsx', 'src/main.ts'], env);
  start('jobs', process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['--dir', 'apps/jobs', 'exec', 'tsx', 'src/main.ts'], env);
  if (isBrowserSuite) start('web', process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['--dir', 'apps/web', 'dev'], env);

  let ready = false;
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const response = await fetch('http://localhost:8080/api/v1/health/live');
      if (!response.ok) continue;
      if (isBrowserSuite) {
        const web = await fetch('http://localhost:5173/');
        if (!web.ok) continue;
      }
      ready = true;
      break;
    } catch {}
  }
  if (!ready) throw new Error(isBrowserSuite ? 'API/前端未就绪' : 'API 未就绪');

  const code = await new Promise((resolve) => {
    const child = isBrowserSuite
      ? spawn(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['--dir', 'apps/web', 'exec', 'playwright', 'test'], {
          cwd: root,
          env: { ...process.env, ...env, E2E_WEB_URL: 'http://localhost:5173', E2E_MAILSINK_PATH: path.join(root, 'mailsink.json') },
          stdio: 'inherit',
          shell: process.platform === 'win32',
        })
      : spawn(process.execPath, [`scripts/${scripts[scenario]}`], { cwd: root, env: { ...process.env, ...env }, stdio: 'inherit' });
    child.on('exit', (exitCode) => resolve(exitCode ?? 1));
  });

  await control.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await control.end();
  cleanup();
  process.exit(code);
}

main().catch((error) => {
  console.error(error);
  cleanup();
  process.exit(1);
});
