/**
 * 奖励额度服务（docs/rebuild/21-MONETIZATION-REVISION.md）。
 *
 * 三件事：
 *  1. 广告意图令牌：会话用户换 5 分钟 JWT（out_return_no 透传给微信），
 *     回调验签后从令牌换回服务端担保的 userId——奖励只发给我们认识的会话用户。
 *  2. 微信激励视频服务端验证（SSV）回调：验签 SHA256(secret:trans_id) →
 *     trans_id 幂等 → 免费池 total += 2 + 流水入 room_bonus_ledger，同一事务。
 *  3. 邀请奖励：被邀请人凭链接里的 code 领取（一账号终身一次），
 *     奖励 +5 发给邀请人，日上限按东八区自然日计。
 *
 * 为什么直接加 freeRoomAccounts.total：免费池的 CHECK（consumed+reserved<=total）
 * 与消费逻辑全部复用，奖励到账即开房可用，不需要第二个额度池。
 * 锁序：只触碰免费账户（业务链最后一层锁），与开房事务并发安全。
 */
import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { and, eq, gte, sql } from 'drizzle-orm';
import { freeRoomAccounts, profiles, roomBonusLedger, type Database, type Tx } from '@jev/database';
import {
  AD_REWARD_ROOMS,
  CREATION_REWARD_ROOMS,
  DAILY_AD_BONUS_LIMIT,
  DAILY_INVITE_BONUS_LIMIT,
  INVITE_REWARD_ROOMS,
  DomainError,
  generateInviteCode,
  shanghaiDayStart,
} from '@jev/domain';
import { app } from '../context.js';

const AD_INTENT_ISSUER = 'jev-ad-intent';
const AD_INTENT_TTL_SECONDS = 300;

/** 微信 SSV 回调结果：echostr 存在时透传（URL 校验），否则按 errcode 应答 */
export interface WechatAdCallbackResult {
  echostr?: string;
  errcode: number;
  errmsg?: string;
}

@Injectable()
export class RoomBonusService {
  // ---------- 广告 ----------

  /**
   * 签发广告意图令牌：客户端加载广告前调用，令牌作为 out_return_no 透传给微信，
   * 奖励回调里换回 userId。签发前检查日额度，让用户在看广告之前就知道已达上限。
   */
  async issueAdIntent(userId: string): Promise<{ token: string; expiresIn: number }> {
    const granted = await this.todayBonusCount(app().db.db, userId, 'ad_bonus');
    if (granted >= DAILY_AD_BONUS_LIMIT) {
      throw new DomainError('RATE_LIMITED', '今日看广告奖励已达上限，明天再来吧');
    }
    const token = await new SignJWT({ typ: 'ad-intent' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuer(AD_INTENT_ISSUER)
      .setIssuedAt()
      .setExpirationTime(`${AD_INTENT_TTL_SECONDS}s`)
      .sign(new TextEncoder().encode(app().env.AUTH_SECRET));
    return { token, expiresIn: AD_INTENT_TTL_SECONDS };
  }

  /** 换回意图令牌里的 userId；无效/过期抛 VALIDATION_FAILED（微信侧会按失败重试）。 */
  async verifyAdIntent(token: string): Promise<string> {
    try {
      const { payload } = await jwtVerify(token, new TextEncoder().encode(app().env.AUTH_SECRET), {
        issuer: AD_INTENT_ISSUER,
      });
      if (payload.typ !== 'ad-intent' || typeof payload.sub !== 'string') throw new Error('令牌用途不符');
      return payload.sub;
    } catch {
      throw new DomainError('VALIDATION_FAILED', '广告意图令牌无效或已过期');
    }
  }

  /**
   * 微信激励视频 SSV 回调（GET）。
   *
   * 应答约定：验签失败/缺参数/系统错误返回 errcode≠0（微信会重试，日志可追）；
   * 验签通过后的业务性拒绝（日上限、重复通知）返回 errcode=0 但不入账——
   * 重试不会有不同结果，让微信停止重试才是正确的应答。
   * echostr 透传用于流量主后台首次配置回调地址的 URL 校验。
   */
  async handleWechatAdCallback(query: Record<string, string | undefined>): Promise<WechatAdCallbackResult> {
    if (typeof query.echostr === 'string' && query.echostr.length > 0) {
      return { echostr: query.echostr, errcode: 0 };
    }

    const secret = app().env.WECHAT_AD_CALLBACK_SECRET;
    if (!secret) return { errcode: 50001, errmsg: '未配置 WECHAT_AD_CALLBACK_SECRET' };

    const { signature, trans_id: transId, out_return_no: outReturnNo } = query;
    if (!signature || !transId || !outReturnNo) {
      return { errcode: 40001, errmsg: '缺少必要参数' };
    }

    // 验签：签名 = SHA256(secret:trans_id)，密钥只在流量主后台与本服务之间共享
    const expected = createHash('sha256').update(`${secret}:${transId}`).digest('hex');
    if (signature !== expected) return { errcode: 40002, errmsg: '签名校验失败' };

    let userId: string;
    try {
      userId = await this.verifyAdIntent(outReturnNo);
    } catch {
      return { errcode: 40003, errmsg: '意图令牌无效或已过期' };
    }

    // 事务：锁免费账户 → 数日上限 → 插流水（trans_id 幂等）→ total += 2。
    // 锁行让同一用户的并发回调串行，count-then-insert 不会突破上限。
    const granted = await app().db.tx(async (tx) => {
      await this.lockFreeAccount(tx, userId);
      const todayCount = await this.todayBonusCount(tx, userId, 'ad_bonus');
      if (todayCount >= DAILY_AD_BONUS_LIMIT) return 'daily_limit';

      const inserted = await tx
        .insert(roomBonusLedger)
        .values({
          userId,
          kind: 'ad_bonus',
          amount: AD_REWARD_ROOMS,
          detail: {
            transId,
            rewardAmount: query.reward_amount ?? null,
            productId: query.product_id ?? null,
          },
          idempotencyKey: `ad:${transId}`,
        })
        .onConflictDoNothing({ target: roomBonusLedger.idempotencyKey })
        .returning({ id: roomBonusLedger.id });
      if (inserted.length === 0) return 'duplicate';

      await tx
        .update(freeRoomAccounts)
        .set({ total: sql`${freeRoomAccounts.total} + ${AD_REWARD_ROOMS}`, updatedAt: new Date() })
        .where(eq(freeRoomAccounts.userId, userId));
      return 'granted';
    });
    return { errcode: 0, errmsg: granted };
  }

  // ---------- 邀请 ----------

  /**
   * 领取邀请奖励：被邀请人（claimant）凭邀请链接里的 code 调用，奖励发给邀请人。
   *
   * 幂等键 invite-claim:<claimant>：一账号终身只能成功领取一次；
   * 邀请人的免费账户行加锁后先数日上限再插入，并发领取串行化不会突破上限，
   * 锁序仍是全链路最后一层（免费账户）。
   */
  async claimInviteBonus(
    claimantUserId: string,
    code: string,
  ): Promise<{ result: 'granted' | 'already_claimed' | 'inviter_daily_limit'; rewardRooms: number }> {
    const db = app().db;
    const [inviter] = await db.db
      .select({ userId: profiles.userId })
      .from(profiles)
      .where(eq(profiles.inviteCode, code))
      .limit(1);
    if (!inviter) throw new DomainError('NOT_FOUND', '邀请码无效');
    if (inviter.userId === claimantUserId) throw new DomainError('VALIDATION_FAILED', '不能使用自己的邀请码');

    return db.tx(async (tx) => {
      await this.lockFreeAccount(tx, inviter.userId);
      const todayCount = await this.todayBonusCount(tx, inviter.userId, 'invite_bonus');
      if (todayCount >= DAILY_INVITE_BONUS_LIMIT) return { result: 'inviter_daily_limit' as const, rewardRooms: 0 };

      const inserted = await tx
        .insert(roomBonusLedger)
        .values({
          userId: inviter.userId,
          kind: 'invite_bonus',
          amount: INVITE_REWARD_ROOMS,
          detail: { claimantUserId, code },
          idempotencyKey: `invite-claim:${claimantUserId}`,
        })
        .onConflictDoNothing({ target: roomBonusLedger.idempotencyKey })
        .returning({ id: roomBonusLedger.id });
      if (inserted.length === 0) return { result: 'already_claimed' as const, rewardRooms: 0 };

      await tx
        .update(freeRoomAccounts)
        .set({ total: sql`${freeRoomAccounts.total} + ${INVITE_REWARD_ROOMS}`, updatedAt: new Date() })
        .where(eq(freeRoomAccounts.userId, inviter.userId));
      return { result: 'granted' as const, rewardRooms: INVITE_REWARD_ROOMS };
    });
  }

  // ---------- 作品审核奖励 ----------

  /**
   * 投稿作品通过人工审核发布时的作者奖励：+10 次开房额度。
   *
   * 与广告/邀请不同，这里**没有日上限**——发放的门是管理员逐篇人工审核本身
   * （投稿侧每天最多 5 篇的限流也挡了一层），不存在无成本刷量的路径。
   *
   * 在调用方的事务里执行（与版本发布同一事务：发布成功与奖励到账要么都发生
   * 要么都不发生）；幂等键 creation-bonus:<puzzleId>，一道作品终身只发一次
   * （修订版再次发布不重发，下架再上架也不重发）。
   */
  async awardCreationBonusTx(tx: Tx, authorUserId: string, puzzleId: string): Promise<boolean> {
    const inserted = await tx
      .insert(roomBonusLedger)
      .values({
        userId: authorUserId,
        kind: 'creation_bonus',
        amount: CREATION_REWARD_ROOMS,
        detail: { puzzleId },
        idempotencyKey: `creation-bonus:${puzzleId}`,
      })
      .onConflictDoNothing({ target: roomBonusLedger.idempotencyKey })
      .returning({ id: roomBonusLedger.id });
    if (inserted.length === 0) return false;

    // 无日上限判定，不需要锁行先数：total += N 本身原子，幂等键防重复
    const updated = await tx
      .update(freeRoomAccounts)
      .set({ total: sql`${freeRoomAccounts.total} + ${CREATION_REWARD_ROOMS}`, updatedAt: new Date() })
      .where(eq(freeRoomAccounts.userId, authorUserId))
      .returning({ userId: freeRoomAccounts.userId });
    if (updated.length === 0) throw new DomainError('ACCOUNT_NOT_INITIALIZED', '作者账号未初始化免费次数账户');
    return true;
  }

  /**
   * 读取（必要时懒生成）邀请码：并发下条件更新只让一个请求落码，
   * 码值撞唯一索引时换一个重试（8 位 31 字符表，碰撞概率可忽略）。
   */
  async ensureInviteCode(userId: string): Promise<string> {
    const db = app().db;
    const [row] = await db.db
      .select({ inviteCode: profiles.inviteCode })
      .from(profiles)
      .where(eq(profiles.userId, userId))
      .limit(1);
    if (!row) throw new DomainError('ACCOUNT_NOT_INITIALIZED', '账号档案不存在');
    if (row.inviteCode) return row.inviteCode;

    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generateInviteCode();
      const updated = await db.db
        .update(profiles)
        .set({ inviteCode: code, updatedAt: new Date() })
        .where(and(eq(profiles.userId, userId), sql`${profiles.inviteCode} is null`))
        .returning({ inviteCode: profiles.inviteCode });
      // set 的是刚生成的非空码，null 只可能来自类型放宽
      if (updated[0]?.inviteCode) return updated[0].inviteCode;
      // 条件更新没落行：要么并发已被别人生成（下面 select 能拿到），要么撞了码唯一索引（换码重试）
      const [again] = await db.db
        .select({ inviteCode: profiles.inviteCode })
        .from(profiles)
        .where(eq(profiles.userId, userId))
        .limit(1);
      if (again?.inviteCode) return again.inviteCode;
    }
    throw new DomainError('INTERNAL', '邀请码生成失败，请稍后重试');
  }

  /** 已成功入账的邀请人数（= 邀请人名下 invite_bonus 流水条数）。 */
  async invitedCount(userId: string): Promise<number> {
    const rows = await app().db.db
      .select({ count: sql<number>`count(*)::int` })
      .from(roomBonusLedger)
      .where(and(eq(roomBonusLedger.userId, userId), eq(roomBonusLedger.kind, 'invite_bonus')));
    return rows[0]?.count ?? 0;
  }

  /** 事务里锁免费账户行：日上限计数与入账串行化；行缺失视为账号未初始化（回滚由调用方决定）。 */
  private async lockFreeAccount(tx: Tx, userId: string): Promise<void> {
    const locked = await tx
      .select({ userId: freeRoomAccounts.userId })
      .from(freeRoomAccounts)
      .where(eq(freeRoomAccounts.userId, userId))
      .for('update')
      .limit(1);
    if (locked.length === 0) throw new DomainError('ACCOUNT_NOT_INITIALIZED', '账号未初始化免费次数账户');
  }

  /** 今日（东八区自然日）某类奖励已入账次数。 */
  private async todayBonusCount(db: Database | Tx, userId: string, kind: 'ad_bonus' | 'invite_bonus'): Promise<number> {
    const rows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(roomBonusLedger)
      .where(
        and(
          eq(roomBonusLedger.userId, userId),
          eq(roomBonusLedger.kind, kind),
          gte(roomBonusLedger.createdAt, shanghaiDayStart()),
        ),
      );
    return rows[0]?.count ?? 0;
  }
}
