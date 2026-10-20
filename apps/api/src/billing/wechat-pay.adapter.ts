/**
 * 支付通道适配器：微信支付 v3（Native 扫码）。
 *
 * 按官方协议实现：请求签名（RSA-SHA256）、回调验签（平台公钥）与解密（AES-256-GCM，
 * 密钥即 APIv3 密钥本身）、查单、关单、退款。
 *
 * 商户凭据未配置时 createWechatAdapter 返回 null——收费入口保持关闭。
 * 真实收款上线前必须完成商户开通与全链路真实联调。
 */
import { createSign, createDecipheriv, createPublicKey, randomUUID, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { CreatedPayment, NotifyAck, PayAdapter, VerifiedNotification } from './pay-adapter.js';

export interface WechatEnv {
  WECHAT_PAY_MCHID?: string;
  WECHAT_PAY_APPID?: string;
  WECHAT_PAY_SERIAL?: string;
  WECHAT_PAY_PRIVATE_KEY_PATH?: string;
  WECHAT_PAY_API_V3_KEY?: string;
  WECHAT_PAY_NOTIFY_URL?: string;
  /** 微信支付平台公钥 PEM（商户平台下载）；用于回调验签。 */
  WECHAT_PAY_PLATFORM_PUBLIC_KEY_PATH?: string;
}

export function createWechatAdapter(env: WechatEnv): PayAdapter | null {
  const {
    WECHAT_PAY_MCHID,
    WECHAT_PAY_APPID,
    WECHAT_PAY_SERIAL,
    WECHAT_PAY_PRIVATE_KEY_PATH,
    WECHAT_PAY_API_V3_KEY,
    WECHAT_PAY_NOTIFY_URL,
    WECHAT_PAY_PLATFORM_PUBLIC_KEY_PATH,
  } = env;
  if (
    !WECHAT_PAY_MCHID ||
    !WECHAT_PAY_APPID ||
    !WECHAT_PAY_SERIAL ||
    !WECHAT_PAY_PRIVATE_KEY_PATH ||
    !WECHAT_PAY_API_V3_KEY ||
    !WECHAT_PAY_NOTIFY_URL ||
    !WECHAT_PAY_PLATFORM_PUBLIC_KEY_PATH
  ) {
    return null;
  }
  const privateKey = readFileSync(WECHAT_PAY_PRIVATE_KEY_PATH, 'utf8');
  const apiv3Key = Buffer.from(WECHAT_PAY_API_V3_KEY, 'utf8');
  if (apiv3Key.length !== 32) throw new Error('WECHAT_PAY_API_V3_KEY 必须为 32 字节');
  const platformPublicKey = createPublicKey(readFileSync(WECHAT_PAY_PLATFORM_PUBLIC_KEY_PATH, 'utf8'));
  const base = 'https://api.mch.weixin.qq.com';

  /** 官方 v3 请求签名：Authorization 头按规范拼接。 */
  function authorizationHeader(method: string, path: string, body: string): string {
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = randomUUID().replace(/-/g, '');
    const message = `${method}\n${path}\n${timestamp}\n${nonce}\n${body}\n`;
    const signature = createSign('RSA-SHA256').update(message).sign(privateKey, 'base64');
    return `WECHATPAY2-SHA256-RSA2048 mchid="${WECHAT_PAY_MCHID}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${WECHAT_PAY_SERIAL}"`;
  }

  async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const bodyText = body === undefined ? '' : JSON.stringify(body);
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: authorizationHeader(method, path, bodyText),
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'jev-puzzle/1.0',
      },
      ...(method === 'POST' ? { body: bodyText } : {}),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`微信支付请求失败：${response.status} ${text.slice(0, 200)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  return {
    channel: 'wechat_native',

    async createOrder(input): Promise<CreatedPayment> {
      const result = await request<{ code_url: string }>('POST', '/v3/pay/transactions/native', {
        mchid: WECHAT_PAY_MCHID,
        appid: WECHAT_PAY_APPID,
        description: input.description,
        out_trade_no: input.merchantOrderNo,
        notify_url: input.notifyUrl,
        amount: { total: input.amountMinor, currency: 'CNY' },
      });
      // code_url 是 weixin:// 链接：只能渲染成二维码，浏览器里直接打开无效
      return { payUrl: null, qrContent: result.code_url };
    },

    async queryOrder(merchantOrderNo) {
      const result = await request<{ trade_state: string; transaction_id?: string }>(
        'GET',
        `/v3/pay/transactions/out-trade-no/${encodeURIComponent(merchantOrderNo)}?mchid=${WECHAT_PAY_MCHID}`,
      );
      const failedStates = new Set(['CLOSED', 'REVOKED', 'PAYERROR']);
      const status = result.trade_state === 'SUCCESS' ? 'success' : failedStates.has(result.trade_state) ? 'failed' : 'pending';
      return { status, ...(result.transaction_id !== undefined ? { transactionId: result.transaction_id } : {}) };
    },

    async closeOrder(merchantOrderNo) {
      await request('POST', `/v3/pay/transactions/out-trade-no/${encodeURIComponent(merchantOrderNo)}/close`, {
        mchid: WECHAT_PAY_MCHID,
      });
    },

    async refund(input) {
      await request('POST', '/v3/refund/domestic/refunds', {
        out_trade_no: input.merchantOrderNo,
        out_refund_no: input.refundNo,
        reason: input.reason,
        amount: { refund: input.amountMinor, total: input.amountMinor, currency: 'CNY' },
      });
    },

    verifyNotification(input): VerifiedNotification {
      const timestamp = String(input.headers['wechatpay-timestamp'] ?? '');
      const nonce = String(input.headers['wechatpay-nonce'] ?? '');
      const signature = String(input.headers['wechatpay-signature'] ?? '');
      const serial = String(input.headers['wechatpay-serial'] ?? '');
      if (!timestamp || !nonce || !signature || !serial) throw new Error('微信回调缺少签名头');

      const message = `${timestamp}\n${nonce}\n${input.rawBody.toString('utf8')}\n`;
      const ok = verify('sha256', Buffer.from(message), platformPublicKey, Buffer.from(signature, 'base64'));
      if (!ok) throw new Error('回调验签失败');

      const body = JSON.parse(input.rawBody.toString('utf8')) as {
        id: string;
        resource: { ciphertext: string; nonce: string; associated_data?: string };
      };
      const resource = body.resource;
      const ciphertext = Buffer.from(resource.ciphertext, 'base64');
      const authTag = ciphertext.subarray(ciphertext.length - 16);
      const data = ciphertext.subarray(0, ciphertext.length - 16);
      const decipher = createDecipheriv('aes-256-gcm', apiv3Key, Buffer.from(resource.nonce));
      decipher.setAAD(Buffer.from(resource.associated_data ?? ''));
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
      const payload = JSON.parse(decrypted) as {
        out_trade_no: string;
        transaction_id: string;
        trade_state: string;
        amount?: { total?: number };
      };
      return {
        merchantOrderNo: payload.out_trade_no,
        transactionId: payload.transaction_id,
        success: payload.trade_state === 'SUCCESS',
        notificationId: body.id,
        amountMinor: typeof payload.amount?.total === 'number' ? payload.amount.total : null,
      };
    },

    notifyAck(): NotifyAck {
      // 微信 v3 要求应答 JSON 体
      return { contentType: 'application/json', body: JSON.stringify({ code: 'SUCCESS' }) };
    },
  };
}
