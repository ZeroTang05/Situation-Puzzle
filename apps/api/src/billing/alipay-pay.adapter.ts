/**
 * 支付通道适配器：支付宝开放平台。
 *
 * 按官方「当面付（alipay.trade.precreate）」与「电脑网站支付（alipay.trade.page.pay）」
 * 实现：RSA2 签名（SHA256withRSA）、同步应答验签、异步通知验签、查单、关单、退款。
 *
 * 两种产品共用同一套商户凭据与同一套异步通知验签逻辑，靠 ALIPAY_PRODUCT 选择：
 *  - precreate：返回 qr.alipay.com 链接，前端渲染成二维码（与微信 Native 同构）；
 *  - page：返回已签名的网关跳转 URL，浏览器直接跳转过去付款。
 *
 * 凭据未配置时 createAlipayAdapter 返回 null——收费入口保持关闭。
 * 上线前必须用真实商户号完成全链路联调（小额真实支付 + 真实通知 + 退款）。
 */
import { createSign, createPrivateKey, createPublicKey, randomUUID, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse as parseForm } from 'node:querystring';
import type { CreatedPayment, NotifyAck, PayAdapter, VerifiedNotification } from './pay-adapter.js';

const SIGN_TYPE = 'RSA2';
const DEFAULT_GATEWAY = 'https://openapi.alipay.com/gateway.do';

/** 支付宝产品：扫码（当面付）或跳转（电脑网站支付）。 */
export type AlipayProduct = 'precreate' | 'page';

export interface AlipayEnv {
  ALIPAY_APP_ID?: string;
  /** 应用私钥 PEM（RSA2，2048/4096 位）。 */
  ALIPAY_PRIVATE_KEY_PATH?: string;
  /** 支付宝公钥 PEM；证书模式下填「支付宝公钥证书」PEM 也行（会自动取其中公钥）。 */
  ALIPAY_PUBLIC_KEY_PATH?: string;
  ALIPAY_NOTIFY_URL?: string;
  /** 网关地址：默认生产；沙箱用 https://openapi.alipaydev.com/gateway.do */
  ALIPAY_GATEWAY?: string;
  /** 产品：precreate（默认，扫码）或 page（跳转）。 */
  ALIPAY_PRODUCT?: string;
  /** 业务产品码；缺省按产品自动取（当面付 FACE_TO_FACE_PAYMENT / 电脑网站 FAST_INSTANT_TRADE_PAY）。 */
  ALIPAY_PRODUCT_CODE?: string;
  /** 商户 PID（seller_id）：通知里校验收款方是不是自己。 */
  ALIPAY_SELLER_ID?: string;
  /** 证书模式：三个证书序列号（支付宝公钥证书 / 应用公钥证书 / 根证书）。 */
  ALIPAY_CERT_SN?: string;
  ALIPAY_APP_CERT_SN?: string;
  ALIPAY_ROOT_CERT_SN?: string;
}

/* ------------------------------------------------------------------ 基础工具 */

/** 分 → 元（支付宝接口金额单位是元，保留两位小数）。 */
export function minorToYuan(amountMinor: number): string {
  return (amountMinor / 100).toFixed(2);
}

/** 元 → 分（解析通知里的 total_amount）。 */
export function yuanToMinor(yuan: string | undefined): number | null {
  if (!yuan) return null;
  const n = Number(yuan);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/** 支付宝要求时间戳为北京时间 yyyy-MM-dd HH:mm:ss（网关不做时区换算，必须自己给 +8）。 */
export function beijingTimestamp(date: Date = new Date()): string {
  const t = new Date(date.getTime() + 8 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}`;
}

/**
 * 生成待签名字符串：排除空值，按参数名 ASCII 升序，拼成 key=value&key=value。
 * 值用**原始值**（不 URL 编码）——支付宝 SDK 也是这么签的。
 *
 * 两种场景规则不对称（官方 SDK 同此处理）：
 *  - 请求签名：只排除 sign，sign_type 参与签名；
 *  - 异步通知验签：必须连 sign_type 一起排除，否则永远验不过。
 */
export function buildSignContent(
  params: Record<string, string | undefined>,
  options: { excludeSignType?: boolean } = {},
): string {
  return Object.keys(params)
    .filter(
      (key) =>
        key !== 'sign' &&
        (!options.excludeSignType || key !== 'sign_type') &&
        params[key] !== undefined &&
        params[key] !== '',
    )
    .sort()
    .map((key) => `${key}=${(params[key] as string).trim()}`)
    .join('&');
}

/** RSA2 签名（SHA256withRSA，base64）。 */
export function signParams(params: Record<string, string | undefined>, privateKeyPem: string): string {
  const content = buildSignContent(params);
  return createSign('RSA-SHA256').update(content, 'utf8').sign(createPrivateKey(privateKeyPem), 'base64');
}

/** RSA2 验签。 */
export function verifySign(content: string, sign: string, publicKeyPem: string): boolean {
  try {
    // 公钥 PEM 或公钥证书 PEM 都能交给 createPublicKey，证书会自动取出其中公钥
    const key = createPublicKey(publicKeyPem);
    return verify('sha256', Buffer.from(content, 'utf8'), key, Buffer.from(sign, 'base64'));
  } catch {
    return false;
  }
}

/**
 * 从原始应答报文中截取某个节点的**原始 JSON 文本**。
 *
 * 支付宝的同步应答签名是对「xxx_response 节点的紧凑 JSON」算的，
 * 必须用原始报文切片（不能 JSON.parse 后重新序列化——转义与空白可能不一致）。
 */
export function extractRawNode(raw: string, node: string): string | null {
  const key = `"${node}"`;
  const keyIdx = raw.indexOf(key);
  if (keyIdx < 0) return null;
  const colonIdx = raw.indexOf(':', keyIdx + key.length);
  if (colonIdx < 0) return null;
  const start = raw.indexOf('{', colonIdx);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

/** 支付宝错误码：10000 = 成功。 */
const ALIPAY_OK = '10000';

export function createAlipayAdapter(env: AlipayEnv): PayAdapter | null {
  const {
    ALIPAY_APP_ID,
    ALIPAY_PRIVATE_KEY_PATH,
    ALIPAY_PUBLIC_KEY_PATH,
    ALIPAY_NOTIFY_URL,
    ALIPAY_GATEWAY,
    ALIPAY_PRODUCT,
    ALIPAY_PRODUCT_CODE,
    ALIPAY_SELLER_ID,
    ALIPAY_CERT_SN,
    ALIPAY_APP_CERT_SN,
    ALIPAY_ROOT_CERT_SN,
  } = env;
  if (!ALIPAY_APP_ID || !ALIPAY_PRIVATE_KEY_PATH || !ALIPAY_PUBLIC_KEY_PATH || !ALIPAY_NOTIFY_URL) {
    return null;
  }

  const privateKeyPem = readFileSync(ALIPAY_PRIVATE_KEY_PATH, 'utf8');
  const publicKeyPem = readFileSync(ALIPAY_PUBLIC_KEY_PATH, 'utf8');
  const gateway = ALIPAY_GATEWAY || DEFAULT_GATEWAY;
  const product: AlipayProduct = ALIPAY_PRODUCT === 'page' ? 'page' : 'precreate';
  const productCode =
    ALIPAY_PRODUCT_CODE || (product === 'page' ? 'FAST_INSTANT_TRADE_PAY' : 'FACE_TO_FACE_PAYMENT');

  /** 公共请求参数 + 业务参数 + 签名。 */
  function buildParams(method: string, bizContent: Record<string, unknown>, notifyUrl?: string): Record<string, string> {
    const params: Record<string, string> = {
      app_id: ALIPAY_APP_ID!,
      method,
      format: 'JSON',
      charset: 'utf-8',
      sign_type: SIGN_TYPE,
      timestamp: beijingTimestamp(),
      version: '1.0',
    };
    if (notifyUrl) params.notify_url = notifyUrl;
    if (ALIPAY_CERT_SN) params.alipay_cert_sn = ALIPAY_CERT_SN;
    if (ALIPAY_APP_CERT_SN) params.app_cert_sn = ALIPAY_APP_CERT_SN;
    if (ALIPAY_ROOT_CERT_SN) params.alipay_root_cert_sn = ALIPAY_ROOT_CERT_SN;
    params.biz_content = JSON.stringify(bizContent);
    return params;
  }

  /** 调网关并验签：返回业务节点。 */
  async function call<T>(
    method: string,
    bizContent: Record<string, unknown>,
    options: { notifyUrl?: string; allowFailure?: boolean } = {},
  ): Promise<T> {
    const params = buildParams(method, bizContent, options.notifyUrl);
    const sign = signParams(params, privateKeyPem);
    const body = new URLSearchParams({ ...params, sign }).toString();

    const response = await fetch(gateway, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`支付宝请求失败：HTTP ${response.status} ${text.slice(0, 200)}`);

    const node = method.replace(/\./g, '_') + '_response';
    const rawNode = extractRawNode(text, node);
    if (!rawNode) throw new Error(`支付宝应答里找不到 ${node}：${text.slice(0, 200)}`);

    // 同步应答必须验签：否则拿到的付款信息可能是被篡改的
    let signValue = '';
    try {
      signValue = (JSON.parse(text) as Record<string, unknown>).sign as string;
    } catch {
      signValue = '';
    }
    if (!signValue) throw new Error('支付宝应答缺少 sign');
    if (!verifySign(rawNode, signValue, publicKeyPem)) throw new Error('支付宝应答验签失败');

    const parsed = JSON.parse(rawNode) as Record<string, unknown>;
    const code = String(parsed.code ?? '');
    if (code !== ALIPAY_OK && !options.allowFailure) {
      const sub = parsed.sub_code ? ` ${String(parsed.sub_code)}` : '';
      const subMsg = parsed.sub_msg ? ` ${String(parsed.sub_msg)}` : '';
      throw new Error(`支付宝接口失败：${code}${sub} ${String(parsed.msg ?? '')}${subMsg}`.trim());
    }
    return parsed as T;
  }

  /** 页面支付：把已签名参数拼成跳转 URL（支付宝支持 GET 跳转）。 */
  function buildPagePayUrl(
    bizContent: Record<string, unknown>,
    options: { notifyUrl?: string; returnUrl?: string } = {},
  ): string {
    // notify_url 必须随请求带上：不带的话支付宝不会发异步通知，权益永远发不出去
    const params = buildParams('alipay.trade.page.pay', bizContent, options.notifyUrl);
    if (options.returnUrl) params.return_url = options.returnUrl;
    const sign = signParams(params, privateKeyPem);
    const query = new URLSearchParams({ ...params, sign }).toString();
    return `${gateway}?${query}`;
  }

  return {
    channel: 'alipay',

    async createOrder(input): Promise<CreatedPayment> {
      const bizContent: Record<string, unknown> = {
        out_trade_no: input.merchantOrderNo,
        total_amount: minorToYuan(input.amountMinor),
        subject: input.description,
        timeout_express: '15m',
        product_code: productCode,
      };
      if (product === 'page') {
        // exactOptionalPropertyTypes：可选属性不能显式传 undefined，用条件展开
        return {
          payUrl: buildPagePayUrl(bizContent, {
            notifyUrl: input.notifyUrl,
            ...(input.returnUrl ? { returnUrl: input.returnUrl } : {}),
          }),
          qrContent: null,
        };
      }
      const result = await call<{ qr_code?: string; code: string; msg: string; sub_code?: string; sub_msg?: string }>(
        'alipay.trade.precreate',
        bizContent,
        { notifyUrl: input.notifyUrl },
      );
      const qrCode = result.qr_code;
      if (!qrCode) throw new Error(`支付宝预下单未返回二维码：${result.sub_code ?? ''} ${result.sub_msg ?? ''}`.trim());
      // qr.alipay.com 链接在浏览器里可直接打开唤起支付宝收银台，所以 payUrl 也给一份
      return { payUrl: qrCode, qrContent: qrCode };
    },

    async queryOrder(merchantOrderNo) {
      try {
        const result = await call<{ trade_status?: string; trade_no?: string; total_amount?: string }>(
          'alipay.trade.query',
          { out_trade_no: merchantOrderNo },
        );
        const status = result.trade_status ?? '';
        if (status === 'TRADE_SUCCESS' || status === 'TRADE_FINISHED') {
          return { status: 'success' as const, ...(result.trade_no ? { transactionId: result.trade_no } : {}) };
        }
        if (status === 'TRADE_CLOSED') return { status: 'failed' as const };
        return { status: 'pending' as const };
      } catch (error) {
        // 订单在支付宝侧不存在 = 我们从没真正下成单（关单会失败），按已失败处理
        if (isTradeNotExist(error)) return { status: 'failed' as const };
        throw error;
      }
    },

    async closeOrder(merchantOrderNo) {
      try {
        await call('alipay.trade.close', { out_trade_no: merchantOrderNo }, { allowFailure: true });
      } catch (error) {
        if (isTradeNotExist(error) || isTradeClosed(error)) return;
        throw error;
      }
    },

    async refund(input) {
      await call('alipay.trade.refund', {
        out_trade_no: input.merchantOrderNo,
        refund_amount: minorToYuan(input.amountMinor),
        out_request_no: input.refundNo,
        refund_reason: input.reason,
      });
    },

    verifyNotification(input): VerifiedNotification {
      const params = parseForm(input.rawBody.toString('utf8')) as Record<string, string | string[]>;
      const flat: Record<string, string> = {};
      for (const [key, value] of Object.entries(params)) {
        flat[key] = Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
      }
      const sign = flat.sign;
      if (!sign) throw new Error('支付宝通知缺少 sign');
      if (flat.sign_type && flat.sign_type !== SIGN_TYPE) {
        throw new Error(`支付宝通知 sign_type 不支持：${flat.sign_type}`);
      }
      if (!verifySign(buildSignContent(flat, { excludeSignType: true }), sign, publicKeyPem)) {
        throw new Error('支付宝通知验签失败');
      }
      // 收款方与金额必须对得上，否则拒绝入账
      if (flat.app_id && flat.app_id !== ALIPAY_APP_ID) {
        throw new Error(`支付宝通知 app_id 不匹配：${flat.app_id}`);
      }
      if (ALIPAY_SELLER_ID && flat.seller_id && flat.seller_id !== ALIPAY_SELLER_ID) {
        throw new Error(`支付宝通知 seller_id 不匹配：${flat.seller_id}`);
      }
      const merchantOrderNo = flat.out_trade_no;
      const transactionId = flat.trade_no;
      if (!merchantOrderNo || !transactionId) throw new Error('支付宝通知缺少 out_trade_no / trade_no');
      const success = flat.trade_status === 'TRADE_SUCCESS' || flat.trade_status === 'TRADE_FINISHED';
      return {
        merchantOrderNo,
        transactionId,
        success,
        notificationId: flat.notify_id || flat.trade_no || randomUUID(),
        amountMinor: yuanToMinor(flat.total_amount),
      };
    },

    notifyAck(): NotifyAck {
      // 支付宝要求应答纯文本 success，其它内容视为失败并会重试通知
      return { contentType: 'text/plain', body: 'success' };
    },
  };
}

/** 支付宝错误文案里是否表示「订单不存在」。 */
function isTradeNotExist(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return text.includes('ACQ.TRADE_NOT_EXIST');
}

/** 支付宝错误文案里是否表示「订单已关闭」。 */
function isTradeClosed(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return text.includes('ACQ.TRADE_STATUS_ERROR') || text.includes('ACQ.TRADE_NOT_EXIST');
}
