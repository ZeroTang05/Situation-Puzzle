/**
 * 邮件服务：Email OTP 验证码投递（docs/rebuild/05-OPERATIONS.md §2）。
 *
 * 两个通道，按 MAIL_TRANSPORT 显式选择：
 * - resend：生产通道，官方 SDK（与内部其他项目同一 Resend 账号）
 * - smtp：本地联调通道，投递给 scripts/dev-mailsink.mjs 收信台，供 E2E 读码
 * 发送失败就地抛错——禁止用控制台打印验证码冒充已接入邮箱。
 */
import { Resend } from 'resend';
import nodemailer, { type Transporter } from 'nodemailer';

export interface Mailer {
  sendVerificationCode(to: string, code: string, language: 'zh' | 'en'): Promise<void>;
}

interface CodeMailContent {
  subject: string;
  text: string;
  html: string;
}

/** 中英双语验证码邮件内容；HTML 与纯文本同义，按客户端能力降级 */
function codeMailContent(code: string, language: 'zh' | 'en'): CodeMailContent {
  if (language === 'en') {
    return {
      subject: 'Jev sign-in code',
      text: `Your Jev sign-in code is ${code}. It expires in 5 minutes.`,
      html: `<div style="font-family:-apple-system,'Segoe UI',sans-serif;color:#0a1522;line-height:1.6"><p style="margin:0 0 12px">Your Jev sign-in code is:</p><p style="font-size:28px;font-weight:700;letter-spacing:6px;margin:0 0 12px">${code}</p><p style="margin:0;color:#5b6b7a">It expires in 5 minutes. If you did not request this, ignore this email.</p></div>`,
    };
  }
  return {
    subject: 'Jev 登录验证码',
    text: `你的 Jev 登录验证码是 ${code}，5 分钟内有效。若不是你本人操作，请忽略这封邮件。`,
    html: `<div style="font-family:-apple-system,'Segoe UI',sans-serif;color:#0a1522;line-height:1.6"><p style="margin:0 0 12px">你的 Jev 登录验证码是：</p><p style="font-size:28px;font-weight:700;letter-spacing:6px;margin:0 0 12px">${code}</p><p style="margin:0;color:#5b6b7a">5 分钟内有效。若不是你本人操作，请忽略这封邮件。</p></div>`,
  };
}

/** 生产通道：Resend HTTP API（无需 SMTP 端口连通性） */
export function createResendMailer(options: { apiKey: string; from: string }): Mailer {
  const resend = new Resend(options.apiKey);
  return {
    async sendVerificationCode(to, code, language) {
      const content = codeMailContent(code, language);
      const response = await resend.emails.send({
        from: options.from,
        to,
        subject: content.subject,
        text: content.text,
        html: content.html,
      });
      if (response.error) {
        throw new Error(`Resend 发信失败（${response.error.name}）：${response.error.message}`);
      }
    },
  };
}

/** 本地联调通道：真实 SMTP 协议投递给收信台 */
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
      const content = codeMailContent(code, language);
      await transport.sendMail({ from: options.from, to, subject: content.subject, text: content.text, html: content.html });
    },
  };
}
