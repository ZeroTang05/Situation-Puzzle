/**
 * WS 探针：验证 Caddy edge 能正确转发 WebSocket 升级请求。
 * 连上 /ws 后服务器应等待 auth 帧，5 秒超时关闭——收到关闭即证明链路通。
 */
import { createRequire } from 'node:module';
const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const WebSocket = require('ws');

const url = process.argv[2] ?? 'wss://localhost/ws';
const ws = new WebSocket(url, { rejectUnauthorized: false });
const start = Date.now();

ws.on('open', () => console.log(`open: 升级成功 (${Date.now() - start}ms)`));
ws.on('message', (data) => console.log('message:', data.toString().slice(0, 120)));
ws.on('close', (code, reason) => {
  console.log(`close: code=${code} reason=${reason.toString()} after ${Date.now() - start}ms`);
  process.exit(0);
});
ws.on('error', (err) => {
  console.error('error:', err.message);
  process.exit(1);
});

setTimeout(() => {
  console.error('timeout: 12 秒内未按预期关闭');
  process.exit(1);
}, 12000);
