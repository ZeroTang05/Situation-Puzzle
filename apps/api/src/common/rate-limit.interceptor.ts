/**
 * 全局限流拦截器：按控制器/方法上的 @RateLimit 元数据执行准入控制。
 *
 * 为什么用拦截器而不是中间件：
 *  - 拦截器在守卫之后执行，能拿到 SessionGuard 写入的 request.sessionUser，
 *    于是「按用户」的限额才是真的按用户（中间件阶段还没有会话）。
 *  - 只有带元数据的接口才会查库；没标注的接口零开销。
 *
 * 注意：@Public() / @Anonymous() 只跳过会话读取，**不做频控**——
 * 频控完全由这里的 @RateLimit 元数据决定，两者是独立机制。
 */
import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import ipaddr from 'ipaddr.js';
import { DomainError } from '@jev/domain';
import {
  rateLimitBucketKey,
  rateLimitMessage,
  rateLimitRuleOf,
  retryAfterSeconds,
  windowStartOf,
  type RateLimitDimension,
} from './rate-limit.js';
import { consumeRateLimit } from './rate-limit.store.js';

/** 客户端 IP：express 的 request.ip 已按 TRUSTED_PROXY_CIDRS 处理转发头。 */
function clientIpOf(request: Request): string | undefined {
  const raw = request.ip ?? request.socket.remoteAddress;
  if (!raw) return undefined;
  try {
    // 归一化：IPv4-mapped IPv6（::ffff:1.2.3.4）与纯 IPv4 归到同一个桶
    return ipaddr.process(raw).toString();
  } catch {
    return raw.trim();
  }
}

@Injectable()
export class RateLimitInterceptor implements NestInterceptor {
  async intercept(context: ExecutionContext, next: CallHandler) {
    const rule = rateLimitRuleOf(context.getHandler(), context.getClass());
    if (!rule) return next.handle();

    const request = context.switchToHttp().getRequest<Request & { sessionUser?: { userId: string } }>();
    const ip = clientIpOf(request);
    const userId = request.sessionUser?.userId;

    // 按用户的规则遇到匿名请求时退回按 IP，避免公开接口漏限流
    let dimension: RateLimitDimension = rule.keyBy;
    let subject: string | undefined;
    if (rule.keyBy === 'user') {
      if (userId) subject = userId;
      else if (ip) {
        dimension = 'ip';
        subject = ip;
      }
    } else if (ip) {
      subject = ip;
    }
    // 既没有会话也没有 IP（例如内网直连）时无法归属主体，放行
    if (!subject) return next.handle();

    const now = Date.now();
    const windowStartMs = windowStartOf(now, rule.windowSeconds);
    const bucketKey = rateLimitBucketKey(rule.scope, dimension, subject);
    const verdict = await consumeRateLimit(bucketKey, new Date(windowStartMs), rule.limit);
    if (verdict.allowed) return next.handle();

    const retryAfter = retryAfterSeconds(windowStartMs, rule.windowSeconds, now);
    const response = context.switchToHttp().getResponse<Response>();
    response.setHeader('Retry-After', String(retryAfter));
    throw new DomainError('RATE_LIMITED', rateLimitMessage(retryAfter), {
      scope: rule.scope,
      limit: rule.limit,
      windowSeconds: rule.windowSeconds,
      retryAfterSeconds: retryAfter,
    });
  }
}
