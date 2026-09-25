/** @Public() 标记：跳过 SessionGuard（登录、邀请预览、健康检查等无需会话的接口）。 */
import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'is_public';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** 单人接口标记：守卫直接放行且不读会话（docs/rebuild/08-SOLO.md §3）。 */
export const IS_ANONYMOUS_KEY = 'is_anonymous';
export const Anonymous = () => SetMetadata(IS_ANONYMOUS_KEY, true);
