/** 绑定邮箱只授予读取会员的资格，不更改平台号登录身份。 */
import { createHmac, randomInt } from 'node:crypto';
import { and, eq, gt, isNotNull } from 'drizzle-orm';
import { platformEmailBindings, profiles, sponsorGrants, user, verification, type Database, type Tx } from '@jev/database';
import { DomainError } from '@jev/domain';
import { app } from '../context.js';
import type { SessionUser } from '../common/http.js';
import { MailDeliveryError } from './mailer.js';
import { OtpSendQuota } from './otp-send-quota.js';
import { isDisposableEmail } from './signup-otp-gate.js';

function bindingKey(person: SessionUser, email: string): string {
  if (!person.miniPlatform) throw new DomainError('FORBIDDEN', '请在小游戏内绑定邮箱');
  if (email.endsWith('.invalid') || isDisposableEmail(email)) throw new DomainError('VALIDATION_FAILED', '请使用有效邮箱');
  return JSON.stringify(['platform-email', person.userId, person.miniPlatform, email]);
}

/** 摘要绑定账号、平台、邮箱和用途，数据库无需存验证码明文。 */
function digest(key: string, code: string): string {
  return createHmac('sha256', app().env.AUTH_SECRET).update(JSON.stringify([key, code])).digest('hex');
}

export async function sendBindingCode(person: SessionUser, email: string, ip: string, language: 'zh' | 'en') {
  const id = bindingKey(person, email);
  const context = app();
  const quota = new OtpSendQuota(context.db.pool);
  const reservation = await quota.reserve(email, ip);
  if ('retryAfterSeconds' in reservation) {
    throw new DomainError('RATE_LIMITED', '验证码发送过于频繁', { retryAfterSeconds: reservation.retryAfterSeconds });
  }
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const value = digest(id, code);
  const expiresAt = new Date(Date.now() + 300_000);
  await context.db.db.insert(verification).values({ id, identifier: id, value, expiresAt })
    .onConflictDoUpdate({ target: verification.id, set: { value, expiresAt } });
  try {
    await context.mailer.sendVerificationCode(email, code, language, 'binding');
  } catch (error) {
    console.error('[auth] 绑定邮箱验证码投递失败', error);
    if (error instanceof MailDeliveryError && error.outcome === 'rejected') {
      await context.db.db.delete(verification).where(and(eq(verification.id, id), eq(verification.value, value)));
      await quota.release(reservation.id);
    }
    throw new DomainError('EMAIL_BIND_SEND_FAILED', '验证码发送失败，请稍后重试');
  }
  return { retryAfterSeconds: 60 };
}

/** 验证码消费与绑定在同一事务内；同一邮箱在一个平台只能绑定一个账号。 */
export async function verifyBindingCode(person: SessionUser, email: string, code: string) {
  const id = bindingKey(person, email);
  const platform = person.miniPlatform!;
  return app().db.tx(async (tx) => {
    await tx.select({ userId: profiles.userId }).from(profiles).where(eq(profiles.userId, person.userId)).for('update');
    const consumed = await tx.delete(verification).where(and(
      eq(verification.id, id), eq(verification.value, digest(id, code)), gt(verification.expiresAt, new Date()),
    )).returning({ id: verification.id });
    if (!consumed.length) throw new DomainError('EMAIL_BIND_CODE_INVALID', '验证码错误或已过期');

    const [existing] = await tx.select().from(platformEmailBindings).where(eq(platformEmailBindings.userId, person.userId));
    if (existing && (existing.email !== email || existing.platform !== platform)) {
      throw new DomainError('EMAIL_BIND_CONFLICT', '该账号已绑定其他邮箱');
    }
    const [source] = await tx.select({ id: user.id }).from(user).where(and(eq(user.email, email), eq(user.emailVerified, true)));
    if (existing) {
      await tx.update(platformEmailBindings).set({ sourceUserId: source?.id ?? null, verifiedAt: new Date() })
        .where(eq(platformEmailBindings.userId, person.userId));
    } else {
      const inserted = await tx.insert(platformEmailBindings).values({
        userId: person.userId, platform, email, sourceUserId: source?.id ?? null,
      }).onConflictDoNothing().returning({ email: platformEmailBindings.email });
      if (!inserted.length) throw new DomainError('EMAIL_BIND_CONFLICT', '邮箱已绑定该平台的其他账号');
    }
    return { email };
  });
}

/** 网页与 App 保持自身资格；小游戏读取自己的正式授权与所绑定网页账号的购买记录。 */
export async function roomSponsorGrants(db: Database | Tx, person: Pick<SessionUser, 'userId' | 'miniPlatform'>) {
  const own = db.select().from(sponsorGrants).where(and(
    eq(sponsorGrants.userId, person.userId),
    ...(person.miniPlatform ? [isNotNull(sponsorGrants.orderId)] : []),
  ));
  if (!person.miniPlatform) return own;
  const [ownGrants, linked] = await Promise.all([
    own,
    db.select({ id: sponsorGrants.id, type: sponsorGrants.type, status: sponsorGrants.status, effectiveUntil: sponsorGrants.effectiveUntil, effectiveFrom: sponsorGrants.effectiveFrom })
      .from(platformEmailBindings)
      .innerJoin(user, and(eq(user.id, platformEmailBindings.sourceUserId), eq(user.email, platformEmailBindings.email), eq(user.emailVerified, true)))
      .innerJoin(profiles, and(eq(profiles.userId, user.id), eq(profiles.status, 'active')))
      .innerJoin(sponsorGrants, and(eq(sponsorGrants.userId, user.id), isNotNull(sponsorGrants.orderId)))
      .where(and(eq(platformEmailBindings.userId, person.userId), eq(platformEmailBindings.platform, person.miniPlatform))),
  ]);
  return [...ownGrants, ...linked];
}
