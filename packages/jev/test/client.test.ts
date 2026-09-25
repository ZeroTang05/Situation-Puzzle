/** Jev 客户端协议校验测试：真实 HTTP 语义通过本地 http 服务器模拟上游。 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { JevClient } from '../src/client.js';
import type { JevConfig, Language } from '../src/types.js';

function config(baseUrl: string): JevConfig {
  return {
    apiKey: 'test-key',
    baseUrl,
    model: 'jev-test',
    threshold: 0.5,
    promptVersion: 'test',
    attemptTimeoutMs: 2000,
    totalDeadlineMs: 5000,
    language: 'zh' as Language,
  };
}

/** SystemOne 响应形状 */
function answer(choice: string, probabilities: Record<string, number>) {
  return { answers: { verdict: { choice, probabilities } } };
}

let server: Server;
let baseUrl = '';
let mode: 'ok' | 'missing-probability' | 'bad-choice' | 'auth' | 'rate-limit' | 'upstream' | 'network' | 'low-confidence';

beforeAll(async () => {
  server = createServer((req, res) => {
    if (mode === 'ok') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(answer('是', { 是: 0.9, 否: 0.05, 无关: 0.05 })));
      return;
    }
    if (mode === 'low-confidence') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(answer('是', { 是: 0.3, 否: 0.4, 无关: 0.3 })));
      return;
    }
    if (mode === 'missing-probability') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ answers: { verdict: { choice: '是' } } }));
      return;
    }
    if (mode === 'bad-choice') {
      res.end(JSON.stringify({ answers: { verdict: { choice: '也许', probabilities: { 也许: 0.9 } } } }));
      return;
    }
    if (mode === 'auth') {
      res.statusCode = 401;
      res.end('unauthorized');
      return;
    }
    if (mode === 'rate-limit') {
      res.statusCode = 429;
      res.setHeader('retry-after', '1');
      res.end();
      return;
    }
    if (mode === 'upstream') {
      res.statusCode = 500;
      res.end();
      return;
    }
    // network：直接断开
    res.destroy();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/zen`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function client(): JevClient {
  return new JevClient(config(baseUrl));
}

describe('Jev SystemOne 客户端', () => {
  it('正常响应映射为稳定枚举', async () => {
    mode = 'ok';
    const result = await client().ask({ title: 't', surface: 's', answer: 'a', question: 'q' });
    expect(result.result).toBe('yes');
    expect(result.confidence).toBe(0.9);
  });

  it('低置信度返回 uncertain（有效判定，不是错误）', async () => {
    mode = 'low-confidence';
    const result = await client().ask({ title: 't', surface: 's', answer: 'a', question: 'q' });
    expect(result.result).toBe('uncertain');
    expect(result.confidence).toBe(0.3);
  });

  it('缺概率是协议错误，不默认为 0', async () => {
    mode = 'missing-probability';
    await expect(client().ask({ title: 't', surface: 's', answer: 'a', question: 'q' })).rejects.toMatchObject({ errorClass: 'protocol' });
  });

  it('非法选项是协议错误', async () => {
    mode = 'bad-choice';
    await expect(client().ask({ title: 't', surface: 's', answer: 'a', question: 'q' })).rejects.toMatchObject({ errorClass: 'protocol' });
  });

  it('鉴权失败立即终止，不重试', async () => {
    mode = 'auth';
    await expect(client().ask({ title: 't', surface: 's', answer: 'a', question: 'q' })).rejects.toMatchObject({ errorClass: 'auth' });
  });

  it('网络错误按分类抛出', async () => {
    mode = 'network';
    await expect(client().ask({ title: 't', surface: 's', answer: 'a', question: 'q' })).rejects.toMatchObject({ errorClass: 'network' });
  });
});
