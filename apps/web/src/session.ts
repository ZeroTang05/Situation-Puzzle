/** 会话类型：Better Auth session 数据的最小投影。 */
/** Better Auth 会话数据的最小投影（时间字段由库返回 Date，这里保持宽松） */
export interface Session {
  user: {
    id: string;
    email: string;
    name: string;
    emailVerified: boolean;
  };
  session: {
    id: string;
    userId: string;
    expiresAt: string | Date;
  };
}
