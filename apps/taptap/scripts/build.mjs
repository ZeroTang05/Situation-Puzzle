/** 构建 TapTap 原生小游戏入口；产物交给官方打包/调试工具使用。 */
import { build } from 'esbuild';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = JSON.parse(await readFile(path.join(root, 'config.json'), 'utf8'));
for (const field of ['interstitialAdUnitId', 'rewardedAdUnitId', 'shareTemplateId']) {
  if (config[field] !== undefined && typeof config[field] !== 'string') throw new Error(`config.json 的 ${field} 必须为字符串`);
}
const apiOrigin = new URL(process.env.TAPTAP_API_BASE_URL ?? config.apiBaseUrl);
if (apiOrigin.protocol !== 'https:' || apiOrigin.pathname !== '/' || apiOrigin.username || apiOrigin.password || apiOrigin.search || apiOrigin.hash) {
  throw new Error('TAPTAP_API_BASE_URL 必须是 HTTPS 来源地址，不能包含路径、账号或查询参数');
}

await mkdir(path.join(root, 'dist/assets'), { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ['src/main.tsx'],
  outfile: 'dist/game.js',
  bundle: true,
  format: 'iife',
  platform: 'neutral',
  mainFields: ['module', 'main'],
  target: 'es2018',
  sourcemap: false,
  minify: true,
  define: {
    __API_BASE__: JSON.stringify(apiOrigin.origin), 'process.env.NODE_ENV': '"production"',
    __MINI_APP_ID__: JSON.stringify(config.miniAppId),
    __INTERSTITIAL_AD_UNIT_ID__: JSON.stringify(config.interstitialAdUnitId ?? ''),
    __REWARDED_AD_UNIT_ID__: JSON.stringify(config.rewardedAdUnitId ?? ''),
    __SHARE_TEMPLATE_ID__: JSON.stringify(config.shareTemplateId ?? ''),
  },
  logLevel: 'info',
});
await Promise.all([
  ...['game.json', 'project.config.json'].map((name) => copyFile(path.join(root, name), path.join(root, 'dist', name))),
  copyFile(path.join(root, '../miniprogram/src/assets/icon.png'), path.join(root, 'dist/assets/icon.png')),
]);
console.log('小游戏构建完成：apps/taptap/dist（需使用 TapTap 官方工具打包与真机调试）');
