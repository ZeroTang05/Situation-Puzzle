/** 按官方调试扩展的归档结构打包：game.js/game.json 位于 ZIP 根目录。 */
import archiver from 'archiver';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const config = JSON.parse(await readFile(path.join(root, 'config.json'), 'utf8'));
const game = JSON.parse(await readFile(path.join(root, 'dist/game.json'), 'utf8'));
if (game.appId !== config.miniAppId || !game.productName) throw new Error('game.json 的小游戏身份与 config.json 不一致');
await mkdir(path.join(root, 'artifacts'), { recursive: true });
const target = path.join(root, 'artifacts/game.zip');
await new Promise((resolve, reject) => {
  const stream = createWriteStream(target); const archive = archiver('zip', { zlib: { level: 9 } });
  stream.on('close', resolve); stream.on('error', reject); archive.on('error', reject);
  archive.pipe(stream); archive.directory(path.join(root, 'dist'), false); void archive.finalize();
});
console.log(`调试归档已生成：${target}`);
