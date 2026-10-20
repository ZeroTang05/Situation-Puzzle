/**
 * 限流策略清单回归测试（元数据层）。
 *
 * 这份清单把「哪些接口限流、各自多少」钉死：
 *  - 创作投稿是唯一直接烧 Jev 钱的口子，日额度不能被悄悄改掉或漏掉；
 *  - 支付通知按 IP 限流（平台不带会话），规则不能被改成按用户；
 *  - 单人模式是产品明确的「永久免费、不做业务限流」，任何人都别给它加规则。
 *
 * 集成测试直调 service，绕过了拦截器层，查不出「规则没挂上」这类问题，
 * 所以要在元数据层断言。
 */
import { describe, expect, it } from 'vitest';
import { rateLimitRuleOf, type RateLimitRule } from './rate-limit.js';
import { CreationsController } from '../creations/creations.controller.js';
import { GovernanceController } from '../governance/governance.controller.js';
import { AdminController } from '../admin/admin.controller.js';
import { BillingController } from '../billing/billing.controller.js';
import { SoloController } from '../solo/solo.controller.js';
import { RoomsController } from '../rooms/rooms.controller.js';

function ruleOf(handler: unknown, klass: unknown): RateLimitRule | undefined {
  return rateLimitRuleOf(handler, klass);
}

describe('限流策略清单', () => {
  it('投稿提交：每人每天 5 篇（东八区自然日）', () => {
    const rule = ruleOf(CreationsController.prototype.submit, CreationsController);
    expect(rule).toEqual({ scope: 'creations.submit', limit: 5, windowSeconds: 86_400, keyBy: 'user' });
  });

  it('创作中心整体：每人每分钟 20 次', () => {
    const rule = ruleOf(CreationsController.prototype.create, CreationsController);
    expect(rule).toEqual({ scope: 'creations', limit: 20, windowSeconds: 60, keyBy: 'user' });
  });

  it('举报：每人每小时 5 条', () => {
    const rule = ruleOf(GovernanceController.prototype.report, GovernanceController);
    expect(rule).toEqual({ scope: 'reports', limit: 5, windowSeconds: 3_600, keyBy: 'user' });
  });

  it('后台：每个管理员每分钟 120 次', () => {
    const rule = ruleOf(AdminController.prototype.listUsers, AdminController);
    expect(rule).toEqual({ scope: 'admin', limit: 120, windowSeconds: 60, keyBy: 'user' });
  });

  it('支付通知：按客户端 IP 每分钟 120 次（平台不带会话，不能按用户）', () => {
    const rule = ruleOf(BillingController.prototype.notify, BillingController);
    expect(rule).toEqual({ scope: 'payments.notify', limit: 120, windowSeconds: 60, keyBy: 'ip' });
  });

  it('单人模式不加业务限流（产品既定：永久免费）', () => {
    expect(ruleOf(SoloController.prototype.judge, SoloController)).toBeUndefined();
    expect(ruleOf(SoloController.prototype.createSession, SoloController)).toBeUndefined();
  });

  it('房间命令不加 HTTP 限流（排队与讨论限速已在 domain 层管）', () => {
    expect(ruleOf(RoomsController.prototype.command, RoomsController)).toBeUndefined();
  });
});
