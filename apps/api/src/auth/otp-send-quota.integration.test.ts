/** 使用真实 PostgreSQL 验证并发预占、退回和跨连接持久计数；需 OTP_TEST_DATABASE_URL。 */
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { OtpSendQuota } from './otp-send-quota.js';

const databaseUrl = process.env.OTP_TEST_DATABASE_URL;
describe.runIf(!!databaseUrl)('真实数据库验证码预占', () => {
  const schema = `otp_test_${randomUUID().replaceAll('-', '')}`;
  let control: Pool; let pool: Pool; let quota: OtpSendQuota;
  beforeAll(async () => {
    control = new Pool({ connectionString: databaseUrl });
    await control.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await pool.query(await readFile(new URL('../../../../packages/database/drizzle/0003_otp_send_quota.sql', import.meta.url), 'utf8'));
    quota = new OtpSendQuota(pool);
  });
  afterAll(async () => {
    try { await pool?.end(); }
    finally {
      if (control) { try { await control.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await control.end(); } }
    }
  });
  it('同一 IP 的 20 个并发请求只放行 3 个', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) => quota.reserve(`parallel${index}@example.com`, '198.51.100.1')));
    expect(results.filter((result) => 'id' in result)).toHaveLength(3);
    expect(results.filter((result) => 'retryAfterSeconds' in result)).toHaveLength(17);
  });
  it('同一邮箱换 IP，10 个并发请求仍只放行一个', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, (_, index) => quota.reserve('shared@example.com', `203.0.113.${index + 1}`)));
    expect(results.filter((result) => 'id' in result)).toHaveLength(1);
  });
  it('明确发送失败退回额度，未知结果继续占用', async () => {
    const first = await quota.reserve('release@example.com', '198.51.100.20');
    if (!('id' in first)) throw new Error('首次请求未放行');
    await quota.release(first.id);
    expect(await quota.reserve('release@example.com', '198.51.100.20')).toHaveProperty('id');
    expect(await quota.reserve('release@example.com', '198.51.100.21')).toHaveProperty('scope', 'email');
  });
  it('更换额度实例和数据库连接后，计数仍然有效', async () => {
    await quota.reserve('persistent0@example.com', '198.51.100.30');
    await quota.reserve('persistent1@example.com', '198.51.100.30');
    await quota.reserve('persistent2@example.com', '198.51.100.30');
    const replacement = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    try { expect(await new OtpSendQuota(replacement).reserve('persistent3@example.com', '198.51.100.30')).toHaveProperty('scope', 'ip'); }
    finally { await replacement.end(); }
  });
});
