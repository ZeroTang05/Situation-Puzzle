/** API 根模块：全部控制器在此注册；服务通过 app() 上下文单例读取共享依赖。 */
import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { EnvelopeInterceptor, RequestIdMiddleware, RolesGuard } from './common/http.js';
import { SessionGuard } from './auth/session.guard.js';
import { HealthController } from './health/health.controller.js';
import { CatalogController } from './catalog/catalog.controller.js';
import { SoloController } from './solo/solo.controller.js';
import { MeController } from './me/me.controller.js';
import { RoomsController } from './rooms/rooms.controller.js';
import { RoomsService } from './rooms/rooms.service.js';
import { CommandsService } from './rooms/commands.service.js';
import { RealtimeController } from './realtime/realtime.controller.js';
import { BillingController } from './billing/billing.controller.js';
import { OrdersService } from './billing/orders.service.js';
import { CreationsController } from './creations/creations.controller.js';
import { GovernanceController } from './governance/governance.controller.js';
import { AdminController } from './admin/admin.controller.js';

@Module({
  controllers: [
    HealthController,
    CatalogController,
    SoloController,
    MeController,
    RoomsController,
    RealtimeController,
    BillingController,
    CreationsController,
    GovernanceController,
    AdminController,
  ],
  providers: [
    RoomsService,
    CommandsService,
    OrdersService,
    { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
