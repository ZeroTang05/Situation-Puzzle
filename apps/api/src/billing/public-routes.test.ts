/**
 * 公开路由清单回归测试。
 *
 * SessionGuard 是全局 APP_GUARD（app.module.ts:46），所以每个接口要么有会话、
 * 要么标了 @Public() / @Anonymous()。这份清单把「哪些接口允许无会话访问」钉死：
 *
 *  - 支付异步通知曾因漏标 @Public() 被守卫 401 掉——两个通道的钱都收了，权益却发不出去；
 *  - 集成测试直接调 service，绕过了守卫层，查不出这类问题，所以要在元数据层断言。
 *
 * 新增或移除公开接口时，必须同步改这里的清单。
 */
import { describe, expect, it } from 'vitest';
import { IS_ANONYMOUS_KEY, IS_PUBLIC_KEY } from '../common/public.js';
import { BillingController } from './billing.controller.js';
import { HealthController } from '../health/health.controller.js';
import { CatalogController } from '../catalog/catalog.controller.js';
import { AppSessionController } from '../auth/app-session.controller.js';
import { SoloController } from './../solo/solo.controller.js';
import { RoomsController } from '../rooms/rooms.controller.js';
import { LobbyController } from '../rooms/lobby.controller.js';

type Access = 'public' | 'anonymous' | 'session';

function accessOf(handler: (...args: never[]) => unknown): Access {
  if (Reflect.getMetadata(IS_ANONYMOUS_KEY, handler)) return 'anonymous';
  if (Reflect.getMetadata(IS_PUBLIC_KEY, handler)) return 'public';
  return 'session';
}

describe('公开路由清单', () => {
  it('支付异步通知允许无会话访问（两个通道都靠它发权益）', () => {
    // 这是最关键的一条：少了 @Public()，微信/支付宝回调会被守卫 401
    expect(accessOf(BillingController.prototype.notify)).toBe('public');
  });

  it('微信激励视频奖励回调允许无会话访问（发奖只靠验签 + 意图令牌）', () => {
    // 微信服务器 GET 不会带我们的会话 Cookie；漏标 @Public() 会被守卫 401，
    // 与支付回调同一种事故形态
    expect(accessOf(BillingController.prototype.wechatAdNotify)).toBe('public');
  });

  it('奖励入口默认需要登录会话', () => {
    expect(accessOf(BillingController.prototype.adIntent)).toBe('session');
    expect(accessOf(BillingController.prototype.inviteClaim)).toBe('session');
  });

  it('健康检查与公开题库允许匿名访问', () => {
    expect(accessOf(HealthController.prototype.live)).toBe('public');
    expect(accessOf(HealthController.prototype.ready)).toBe('public');
    expect(accessOf(CatalogController.prototype.list)).toBe('public');
    expect(accessOf(CatalogController.prototype.random)).toBe('public');
    expect(accessOf(CatalogController.prototype.detail)).toBe('public');
  });

  it('App 会话交接允许匿名访问', () => {
    expect(accessOf(AppSessionController.prototype.handoff)).toBe('public');
    expect(accessOf(AppSessionController.prototype.exchange)).toBe('anonymous');
  });

  it('单人接口全部匿名', () => {
    expect(accessOf(SoloController.prototype.createSession)).toBe('anonymous');
    expect(accessOf(SoloController.prototype.judge)).toBe('anonymous');
    expect(accessOf(SoloController.prototype.solve)).toBe('anonymous');
    expect(accessOf(SoloController.prototype.hint)).toBe('anonymous');
    expect(accessOf(SoloController.prototype.reveal)).toBe('anonymous');
  });

  it('其余业务接口默认需要登录会话', () => {
    // 抽样几个敏感接口，确认没有被误标成公开
    expect(accessOf(BillingController.prototype.createOrder)).toBe('session');
    expect(accessOf(BillingController.prototype.redeem)).toBe('session');
    expect(accessOf(BillingController.prototype.channels)).toBe('session');
  });

  it('用户主持人相关接口全部需要会话', () => {
    // 主持人汤底与主持权操作都涉及私有数据：一旦被误标成公开/匿名，
    // 任何人都能读到汤底或改写本房主持状态（17-USER-HOST-MODE §4.3）。
    expect(accessOf(RoomsController.prototype.hostView)).toBe('session');
    expect(accessOf(LobbyController.prototype.hostRequest)).toBe('session');
    expect(accessOf(LobbyController.prototype.hostApprove)).toBe('session');
    expect(accessOf(LobbyController.prototype.hostReject)).toBe('session');
    expect(accessOf(LobbyController.prototype.hostResign)).toBe('session');
  });
});
