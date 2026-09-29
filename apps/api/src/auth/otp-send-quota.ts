/** PostgreSQL 滚动发送额度；事务锁让多个 API 进程也共享同一份预占结果。 */
import type { Pool } from 'pg';
import ipaddr from 'ipaddr.js';

export interface OtpSendLimit {
  retryAfterSeconds: number;
  scope: 'email' | 'ip';
}

/** 邮箱等待 60 秒，IP 的第四次请求等待最早一次发送满 60 分钟。 */
export function otpSendLimit(now: number, emailTime: number | null, ipTimes: number[]): OtpSendLimit | null {
  const emailWait = emailTime === null ? 0 : Math.max(0, Math.ceil((emailTime + 60_000 - now) / 1000));
  const activeIpTimes = ipTimes.filter((time) => time > now - 3_600_000).sort((a, b) => a - b);
  const ipWait = activeIpTimes.length < 3 ? 0 : Math.max(0, Math.ceil((activeIpTimes[activeIpTimes.length - 3]! + 3_600_000 - now) / 1000));
  if (!emailWait && !ipWait) return null;
  return ipWait >= emailWait ? { retryAfterSeconds: ipWait, scope: 'ip' } : { retryAfterSeconds: emailWait, scope: 'email' };
}

/** 明确返回等多久；被拒绝的请求不写计数、不改变已有记录。 */
export function otpLimitMessage(seconds: number): string {
  return seconds < 60 ? `发送过于频繁，请在 ${seconds} 秒后重试。` : `发送过于频繁，请在 ${Math.ceil(seconds / 60)} 分钟后重试。`;
}

export class OtpSendQuota {
  constructor(private readonly pool: Pool) {}

  /** 锁顺序固定为邮箱→IP，按数据库时间检查并原子插入一次预占。 */
  async reserve(email: string, ip: string): Promise<{ id: string } | OtpSendLimit> {
    email = email.toLowerCase();
    ip = ipaddr.process(ip).toString();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`otp:email:${email}`]);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`otp:ip:${ip}`]);
      const result = await client.query<{ now: Date; email_time: Date | null; ip_times: Date[] }>(`
        WITH instant AS (SELECT clock_timestamp() AS at)
        SELECT instant.at AS now,
          (SELECT max(reserved_at) FROM otp_send_reservations
           WHERE email = $1 AND reserved_at > instant.at - interval '60 seconds') AS email_time,
          ARRAY(SELECT reserved_at FROM otp_send_reservations
                WHERE ip = $2::inet AND reserved_at > instant.at - interval '60 minutes'
                ORDER BY reserved_at) AS ip_times
        FROM instant`, [email, ip]);
      const row = result.rows[0];
      if (!row) throw new Error('验证码额度查询缺少结果');
      const limit = otpSendLimit(row.now.getTime(), row.email_time?.getTime() ?? null, row.ip_times.map((time) => time.getTime()));
      if (limit) { await client.query('COMMIT'); return limit; }
      const inserted = await client.query<{ id: string }>('INSERT INTO otp_send_reservations (email, ip, reserved_at) VALUES ($1, $2::inet, clock_timestamp()) RETURNING id', [email, ip]);
      if (!inserted.rows[0]) throw new Error('验证码发送预占失败');
      await client.query('COMMIT');
      return inserted.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('[otp-quota] 发送预占失败', error);
      throw error;
    } finally { client.release(); }
  }

  /** 仅在确定未投递时退回；接受和未知结果保持原始预占时间。 */
  async release(id: string): Promise<void> {
    await this.pool.query('DELETE FROM otp_send_reservations WHERE id = $1', [id]);
  }
}
