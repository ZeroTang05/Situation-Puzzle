/** 复用官方调试扩展的包下载协议，为真实 TapTap 客户端生成局域网调试二维码。 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import QRCode from 'qrcode';
const { values } = parseArgs({ options: { host: { type: 'string' }, port: { type: 'string', default: '18960' } } });
if (!values.host) throw new Error('请用 --host 指定手机可访问的电脑局域网 IPv4 地址');
const port = Number(values.port); if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('调试端口须为 1024–65535');
const root = fileURLToPath(new URL('../', import.meta.url));
const config = JSON.parse(await readFile(path.join(root, 'config.json'), 'utf8'));
const source = path.join(root, 'artifacts/game.zip'); await stat(source);
const server = createServer((request, response) => {
  if (request.url !== '/download') { response.writeHead(404).end(); return; }
  response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="game.zip"', 'Cache-Control': 'no-store' });
  const stream = createReadStream(source);
  stream.on('error', (error) => { console.error('[taptap:debug] 包下载失败', error); response.destroy(error); });
  stream.pipe(response); console.log('TapTap 客户端已请求调试包');
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '0.0.0.0', resolve); });
const download = `http://${values.host}:${port}/download`;
const debugUrl = `taptap://taptap.com/miniapp?id=${config.miniAppId}&type=debug&clean_profile=true&name=${encodeURIComponent('超好玩海龟汤')}&package=${download}`;
const qr = path.join(root, 'artifacts/debug-qr.png'); await QRCode.toFile(qr, debugUrl, { width: 600, margin: 3 });
await writeFile(path.join(root, 'artifacts/debug-session.json'), JSON.stringify({ pid: process.pid, port, download, debugUrl }, null, 2));
console.log(`请用同一局域网内的 TapTap App 扫码：${qr}`);
console.log('按 Ctrl+C 关闭调试下载服务。');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
