/**
 * 邮件服务：真实 SMTP 投递验证码（docs/rebuild/05-OPERATIONS.md §2）。
 * 连接与认证失败就地抛错——禁止用控制台打印验证码冒充已接入邮箱。
 */
import nodemailer, { type Transporter } from 'nodemailer';

export interface Mailer {
  sendVerificationCode(to: string, code: string, language: 'zh' | 'en'): Promise<void>;
}

export function createSmtpMailer(options: {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
}): Mailer {
  const transport: Transporter = nodemailer.createTransport({
    host: options.host,
    port: options.port,
    secure: options.port === 465,
    auth: { user: options.user, pass: options.pass },
  });

  return {
    async sendVerificationCode(to, code, language) {
      const subject = language === 'en' ? 'Jev sign-in code' : 'Jev 登录验证码';
      const text =
        language === 'en'
          ? `Your Jev sign-in code is ${code}. It expires in 5 minutes.`
          : `你的 Jev 登录验证码是 ${code}，5 分钟内有效。`;
      await transport.sendMail({ from: options.from, to, subject, text });
    },
  };
}
