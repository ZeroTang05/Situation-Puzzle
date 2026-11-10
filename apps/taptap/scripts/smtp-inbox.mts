/** 读取真实 SMTP 收信台的 JSON 文件，不打印验证码或完整邮件。 */
import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const inboxSchema = z.array(z.object({ to: z.string(), body: z.string(), at: z.number() }));

/** 按本次请求时间过滤实际投递时间，避免误读同一邮箱的旧验证码。 */
export async function latestOtp(path: string, email: string, since = 0): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const messages = inboxSchema.parse(JSON.parse(await readFile(path, 'utf8'))).filter((message) => message.at >= since);
    const otp = messages.filter((message) => message.to.includes(email)).at(-1)?.body.match(/\b\d{6}\b/)?.[0];
    if (otp) return otp;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('真实 SMTP 没有收到本次验证码');
}
