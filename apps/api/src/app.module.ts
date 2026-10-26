/** API 根模块：全部控制器在此注册；服务通过 app() 上下文单例读取共享依赖。 */
import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { EnvelopeInterceptor, RequestIdMiddleware, RolesGuard } from './common/http.js';
import { RateLimitInterceptor } from './common/rate-limit.interceptor.js';
import { SessionGuard } from './auth/session.guard.js';
import { AppSessionController } from './auth/app-session.controller.js';
import { HealthController } from './health/health.controller.js';
import { CatalogController } from './catalog/catalog.controller.js';
import { SoloController } from './solo/solo.controller.js';
import { MeController } from './me/me.controller.js';
import { RoomsController } from './rooms/rooms.controller.js';
import { RoomsService } from './rooms/rooms.service.js';
import { CommandsService } from './rooms/commands.service.js';
import { LobbyController } from './rooms/lobby.controller.js';
import { LobbyService } from './rooms/lobby.service.js';
import { HallService } from './rooms/hall.service.js';
import { RealtimeController } from './realtime/realtime.controller.js';
import { BillingController } from './billing/billing.controller.js';
import { OrdersService } from './billing/orders.service.js';
import { RedeemCodesService } from './billing/redeem-codes.service.js';
import { RoomBonusService } from './billing/room-bonus.service.js';
import { CreationsController } from './creations/creations.controller.js';
import { GovernanceController } from './governance/governance.controller.js';
import { AdminController } from './admin/admin.controller.js';
import { BackupController } from './backup/backup.controller.js';
import { BackupService } from './backup/backup.service.js';
import { FriendsController } from './social/friends.controller.js';
import { FriendsService } from './social/friends.service.js';
import { ChatController } from './social/chat.controller.js';
import { ChatService } from './social/chat.service.js';
import { NotificationsController } from './social/notifications.controller.js';
import { NotificationsService } from './social/notifications.service.js';
import { AnnouncementsController } from './social/announcements.controller.js';

@Module({
  controllers: [
    HealthController,
    AppSessionController,
    CatalogController,
    SoloController,
    MeController,
    RoomsController,
    LobbyController,
    RealtimeController,
    BillingController,
    CreationsController,
    GovernanceController,
    AdminController,
    BackupController,
    FriendsController,
    ChatController,
    NotificationsController,
    AnnouncementsController,
  ],
  providers: [
    RoomsService,
    CommandsService,
    LobbyService,
    HallService,
    OrdersService,
    RedeemCodesService,
    RoomBonusService,
    BackupService,
    FriendsService,
    ChatService,
    NotificationsService,
    { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
    // 限流在守卫之后执行：按用户的规则要拿到 SessionGuard 写入的 sessionUser
    { provide: APP_INTERCEPTOR, useClass: RateLimitInterceptor },
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
