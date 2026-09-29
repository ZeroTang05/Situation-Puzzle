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

/** rejected 表示服务明确未接受邮件；unknown 表示可能已经接受，额度应保留。 */
export class MailDeliveryError extends Error {
  constructor(message: string, public readonly outcome: 'rejected' | 'unknown', cause?: unknown) {
    super(message, { cause });
  }
}

/** SMTP 的拒绝响应和发送前连接/认证失败可以确定未投递。 */
export function smtpDeliveryOutcome(error: unknown): 'rejected' | 'unknown' {
  const detail = error as { responseCode?: number; command?: string; code?: string } | null;
  if (detail && ((detail.responseCode !== undefined && detail.responseCode >= 400 && detail.responseCode < 600) || detail.command === 'CONN' || detail.command === 'AUTH' || detail.code === 'EAUTH')) return 'rejected';
  return 'unknown';
}

/** 品牌名：邮件里的发件方称呼（AI 主持人角色仍叫 Jev） */
const BRAND_ZH = 'AI海龟汤';
const BRAND_EN = 'AI Situation Puzzles';

export interface Mailer {
  sendVerificationCode(to: string, code: string, language: 'zh' | 'en'): Promise<void>;
  /** 忘记密码：发送一次性重置链接（url 已含 token，1 小时有效） */
  sendPasswordReset(to: string, url: string, language: 'zh' | 'en'): Promise<void>;
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
      subject: `${BRAND_EN} sign-in code`,
      text: `Your ${BRAND_EN} sign-in code is ${code}. It expires in 5 minutes.`,
      html: `<div style="font-family:-apple-system,'Segoe UI',sans-serif;color:#0a1522;line-height:1.6"><p style="margin:0 0 12px">Your ${BRAND_EN} sign-in code is:</p><p style="font-size:28px;font-weight:700;letter-spacing:6px;margin:0 0 12px">${code}</p><p style="margin:0;color:#5b6b7a">It expires in 5 minutes. If you did not request this, ignore this email.</p></div>`,
    };
  }
  return {
    subject: `${BRAND_ZH} 登录验证码`,
    text: `你的 ${BRAND_ZH} 登录验证码是 ${code}，5 分钟内有效。若不是你本人操作，请忽略这封邮件。`,
    html: `<div style="font-family:-apple-system,'Segoe UI',sans-serif;color:#0a1522;line-height:1.6"><p style="margin:0 0 12px">你的 ${BRAND_ZH} 登录验证码是：</p><p style="font-size:28px;font-weight:700;letter-spacing:6px;margin:0 0 12px">${code}</p><p style="margin:0;color:#5b6b7a">5 分钟内有效。若不是你本人操作，请忽略这封邮件。</p></div>`,
  };
}

/** 中英双语重置密码邮件内容；链接由 Better Auth 签发的一次性 token 构成 */
function resetMailContent(url: string, language: 'zh' | 'en'): CodeMailContent {
  if (language === 'en') {
    return {
      subject: `${BRAND_EN} password reset`,
      text: `Reset your ${BRAND_EN} password with this link (valid for 1 hour): ${url}\nIf you did not request this, ignore this email.`,
      html: `<div style="font-family:-apple-system,'Segoe UI',sans-serif;color:#0a1522;line-height:1.6"><p style="margin:0 0 12px">Click the link below to set a new ${BRAND_EN} password (valid for 1 hour):</p><p style="margin:0 0 12px"><a href="${url}">${url}</a></p><p style="margin:0;color:#5b6b7a">If you did not request this, ignore this email.</p></div>`,
    };
  }
  return {
    subject: `${BRAND_ZH} 重置密码`,
    text: `点击链接设置你的 ${BRAND_ZH} 新密码（1 小时内有效）：${url}\n若不是你本人操作，请忽略这封邮件。`,
    html: `<div style="font-family:-apple-system,'Segoe UI',sans-serif;color:#0a1522;line-height:1.6"><p style="margin:0 0 12px">点击下面的链接设置你的 ${BRAND_ZH} 新密码（1 小时内有效）：</p><p style="margin:0 0 12px"><a href="${url}">${url}</a></p><p style="margin:0;color:#5b6b7a">若不是你本人操作，请忽略这封邮件。</p></div>`,
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
        const status = response.error.statusCode;
        const rejected = status !== null && status >= 400 && status < 500 && status !== 408 && status !== 409;
        throw new MailDeliveryError(`Resend 发信失败（${response.error.name}）：${response.error.message}`, rejected ? 'rejected' : 'unknown');
      }
    },

    async sendPasswordReset(to, url, language) {
      const content = resetMailContent(url, language);
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
      try {
        await transport.sendMail({ from: options.from, to, subject: content.subject, text: content.text, html: content.html });
      } catch (error) {
        throw new MailDeliveryError('SMTP 验证码邮件发送失败', smtpDeliveryOutcome(error), error);
      }
    },

    async sendPasswordReset(to, url, language) {
      const content = resetMailContent(url, language);
      await transport.sendMail({ from: options.from, to, subject: content.subject, text: content.text, html: content.html });
    },
  };
}
