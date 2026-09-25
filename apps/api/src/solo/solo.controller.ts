/**
 * 单人判题：匿名、无服务端对话存储（docs/rebuild/08-SOLO.md）。
 *
 * - 凭证是无状态签名令牌（jose HS256）：只含用途、题目版本、语言、判题配置版本
 * - 请求不加载会话、不写任何业务表；问题只在处理所需的内存中存在
 * - 并发限制：每进程 2 个 Jev 请求（首轮预算），超出返回 JEV_BUSY
 * - 限速只在内存里，IP 最长保留 60 秒，不写磁盘、不进日志
 */
import { Controller, Post, Body, HttpCode } from '@nestjs/common';
import { SignJWT, jwtVerify } from 'jose';
import { and, eq } from 'drizzle-orm';
import { puzzles, puzzleVersions } from '@jev/database';
import { DomainError } from '@jev/domain';
import { JevClient } from '@jev/jev';
import { app } from '../context.js';
import { Anonymous } from '../common/public.js';
import { ZodValidationPipe } from '../common/http.js';
import {
  soloJudgeRequestSchema,
  soloHintRequestSchema,
  soloRevealRequestSchema,
  soloSessionRequestSchema,
  soloSessionResponseSchema,
  soloSolveRequestSchema,
} from '@jev/contracts';
import { z } from 'zod';

interface SoloTokenPayload {
  purpose: 'solo' | 'solo_preview';
  pv: string; // puzzle version id
  lang: 'zh' | 'en';
  cfg: string; // 判题配置版本
}

const ISSUER = 'jev-solo';

/** 每进程单人 Jev 并发闸门：超出即返回繁忙，浏览器保留输入稍后重试。 */
class ConcurrencyGate {
  private active = 0;
  private waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    throw new DomainError('JEV_BUSY', 'Jev 正忙，请稍后再试');
  }

  release(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }
}

/** 内存限速：键 → 时间窗计数；60 秒无写入即被清理。 */
class MemoryRateLimiter {
  private buckets = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  check(key: string): void {
    this.cleanup();
    const now = Date.now();
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return;
    }
    bucket.count += 1;
    if (bucket.count > this.max) {
      throw new DomainError('RATE_LIMITED', '操作太频繁了，稍等片刻再试。');
    }
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}

@Controller('solo')
export class SoloController {
  private gate = new ConcurrencyGate(app().env.SOLO_JEV_CONCURRENCY);
  private limiter = new MemoryRateLimiter(30, 60_000);

  private secret(): Uint8Array {
    return new TextEncoder().encode(app().env.SOLO_TOKEN_SECRET);
  }

  private jev(): JevClient {
    const context = app();
    return new JevClient(context.jev);
  }

  /** 换取无状态凭证：读固定发布版本，签发 24 小时令牌，不落任何表。 */
  @Anonymous()
  @HttpCode(200)
  @Post('sessions')
  async createSession(
    @Body(new ZodValidationPipe(soloSessionRequestSchema)) body: z.infer<typeof soloSessionRequestSchema>,
  ): Promise<z.infer<typeof soloSessionResponseSchema>> {
    const context = app();
    const conditions = [
      eq(puzzles.id, body.puzzleId),
      eq(puzzles.unavailable, false),
      eq(puzzleVersions.moderationStatus, 'published'),
      eq(puzzleVersions.language, body.language),
    ];
    if (body.versionId) conditions.push(eq(puzzleVersions.id, body.versionId));

    const rows = await context.db.db
      .select({
        versionId: puzzleVersions.id,
        title: puzzleVersions.title,
        surface: puzzleVersions.surface,
        hints: puzzleVersions.hints,
        puzzleId: puzzles.id,
      })
      .from(puzzleVersions)
      .innerJoin(puzzles, eq(puzzles.id, puzzleVersions.puzzleId))
      .where(and(...conditions))
      .limit(1);
    const version = rows[0];
    if (!version) throw new DomainError('CONTENT_UNAVAILABLE', '题目不可用或未发布');

    const configVersion = `${context.jev.model}@${context.jev.promptVersion}@t${context.jev.threshold}`;
    const token = await new SignJWT({
      purpose: 'solo',
      pv: version.versionId,
      lang: body.language,
      cfg: configVersion,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(ISSUER)
      .setIssuedAt()
      .setExpirationTime('24h')
      .sign(this.secret());

    return {
      token,
      puzzleId: version.puzzleId,
      versionId: version.versionId,
      language: body.language,
      title: version.title,
      surface: version.surface,
      hintsTotal: version.hints.length,
      configVersion,
    };
  }

  private async verifyToken(token: string): Promise<SoloTokenPayload> {
    try {
      const result = await jwtVerify(token, this.secret(), { issuer: ISSUER });
      const payload = result.payload as unknown as SoloTokenPayload;
      if (payload.purpose !== 'solo' && payload.purpose !== 'solo_preview') {
        throw new Error('用途不符');
      }
      return payload;
    } catch {
      throw new DomainError('VALIDATION_FAILED', '单人凭证无效或已过期，请重新开局');
    }
  }

  private async loadVersion(payload: SoloTokenPayload) {
    const rows = await app().db.db
      .select({
        versionId: puzzleVersions.id,
        title: puzzleVersions.title,
        surface: puzzleVersions.surface,
        answer: puzzleVersions.answer,
        coreFacts: puzzleVersions.coreFacts,
        hints: puzzleVersions.hints,
      })
      .from(puzzleVersions)
      .innerJoin(puzzles, eq(puzzles.id, puzzleVersions.puzzleId))
      .where(and(eq(puzzleVersions.id, payload.pv), eq(puzzles.unavailable, false)))
      .limit(1);
    const version = rows[0];
    if (!version) throw new DomainError('CONTENT_UNAVAILABLE', '题目已被停用');
    return version;
  }

  @Anonymous()
  @HttpCode(200)
  @Post('judge')
  async judge(@Body(new ZodValidationPipe(soloJudgeRequestSchema)) body: z.infer<typeof soloJudgeRequestSchema>) {
    return this.runJudge(body.token, body.question);
  }

  @Anonymous()
  @HttpCode(200)
  @Post('solve')
  async solve(@Body(new ZodValidationPipe(soloSolveRequestSchema)) body: z.infer<typeof soloSolveRequestSchema>) {
    const payload = await this.verifyToken(body.token);
    const version = await this.loadVersion(payload);
    this.limiter.check(payload.pv);

    await this.gate.acquire();
    let verdict;
    try {
      verdict = await this.jev().solve({
        title: version.title,
        surface: version.surface,
        answer: version.answer,
        coreFacts: version.coreFacts,
        solution: body.solution,
      });
    } finally {
      this.gate.release();
    }

    const solved = verdict.result === 'solved';
    return {
      result: verdict.result,
      ...(solved ? { answer: version.answer } : {}),
    };
  }

  private async runJudge(token: string, question: string) {
    const payload = await this.verifyToken(token);
    const version = await this.loadVersion(payload);
    this.limiter.check(payload.pv);

    await this.gate.acquire();
    let verdict;
    try {
      verdict = await this.jev().ask({
        title: version.title,
        surface: version.surface,
        answer: version.answer,
        coreFacts: version.coreFacts,
        question,
      });
    } finally {
      this.gate.release();
    }
    return { result: verdict.result };
  }

  /** 提示按序号取得：单人由浏览器掌握解锁进度，服务端只提供内容。 */
  @Anonymous()
  @HttpCode(200)
  @Post('hints')
  async hint(@Body(new ZodValidationPipe(soloHintRequestSchema)) body: z.infer<typeof soloHintRequestSchema>) {
    const payload = await this.verifyToken(body.token);
    const version = await this.loadVersion(payload);
    const hints = version.hints;
    if (body.index < 0 || body.index >= hints.length) {
      throw new DomainError('NOT_FOUND', '提示不存在');
    }
    return { text: hints[body.index]! };
  }

  @Anonymous()
  @HttpCode(200)
  @Post('reveal')
  async reveal(@Body(new ZodValidationPipe(soloRevealRequestSchema)) body: z.infer<typeof soloRevealRequestSchema>) {
    const payload = await this.verifyToken(body.token);
    const version = await this.loadVersion(payload);
    return { answer: version.answer };
  }
}
