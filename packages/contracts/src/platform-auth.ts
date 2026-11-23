/** 小游戏登录契约：临时 code 只交给服务器，客户端只持有本站会话令牌。 */
import { z } from 'zod';

export const miniLoginRequestSchema = z.object({ code: z.string().min(1).max(2048) });
export const miniLoginResponseSchema = z.object({ token: z.string().min(1) });

export const bindEmailRequestSchema = z.object({ email: z.string().trim().toLowerCase().max(254).pipe(z.email()) });
export const verifyBoundEmailRequestSchema = bindEmailRequestSchema.extend({ code: z.string().regex(/^\d{6}$/) });
