/** 按 TapTap H5 结构归档共享网页产物，ZIP 根目录仅包含 game/。 */
import archiver from 'archiver';
import { createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const debug = process.argv.includes('--debug');
const source = fileURLToPath(new URL(debug ? '../dist-taptap-debug/' : '../dist-taptap/', import.meta.url));
await stat(`${source}/index.html`);
const artifacts = fileURLToPath(new URL('../../taptap/artifacts/', import.meta.url));
await mkdir(artifacts, { recursive: true });
const target = `${artifacts}/${debug ? 'h5-debug' : 'h5'}.zip`;
await new Promise((resolve, reject) => {
  const stream = createWriteStream(target);
  const archive = archiver('zip', { zlib: { level: 9 } });
  stream.on('close', resolve);
  stream.on('error', reject);
  archive.on('error', reject);
  archive.pipe(stream);
  archive.glob('**/*', { cwd: source, dot: false }, { prefix: 'game' });
  void archive.finalize();
});
console.log(`H5 归档已生成：${target}`);
