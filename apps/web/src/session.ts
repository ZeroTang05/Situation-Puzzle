/** Better Auth 会话数据的最小投影（时间字段由库返回 Date，这里保持宽松） */
export interface Session {
  user: {
    id: string;
    email: string;
    name: string;
    /** 权威昵称：由 API 自定义 get-session 从 profiles 注入（auth.instance.ts） */
    nickname: string | null;
    emailVerified: boolean;
  };
  session: {
    id: string;
    userId: string;
    expiresAt: string | Date;
  };
}
