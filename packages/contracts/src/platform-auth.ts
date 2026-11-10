/** 小游戏登录契约：临时 code 只交给服务器，客户端只持有本站会话令牌。 */
import { z } from 'zod';

export const miniLoginRequestSchema = z.object({ code: z.string().min(1).max(2048) });
export const miniLoginResponseSchema = z.object({ token: z.string().min(1) });
export const authSessionSchema = z.object({
  session: z.object({ id: z.string(), userId: z.string(), expiresAt: z.string() }),
  user: z.object({ id: z.string(), email: z.string(), name: z.string(), emailVerified: z.boolean() }),
}).nullable();
export type AuthSession = z.infer<typeof authSessionSchema>;

/** RFC 8628 设备授权协议；device_code 是秘密，只在小游戏内存中保存。 */
export const deviceAuthorizationSchema = z.object({
  device_code: z.string().min(1), user_code: z.string().min(1),
  verification_uri: z.url(), verification_uri_complete: z.url(),
  expires_in: z.number().int().positive(), interval: z.number().int().positive(),
});
export type DeviceAuthorization = z.infer<typeof deviceAuthorizationSchema>;
export const deviceTokenSchema = z.object({ access_token: z.string().min(1), token_type: z.literal('Bearer'), expires_in: z.number().positive() });
export const deviceVerificationSchema = z.object({
  user_code: z.string(), status: z.enum(['pending', 'approved', 'denied']),
  client_id: z.string().nullable().optional(), scope: z.string().nullable().optional(),
});
