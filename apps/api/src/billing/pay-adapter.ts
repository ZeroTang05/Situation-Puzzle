/**
 * 在线收款通道的共享契约。
 *
 * 两个通道（微信支付 v3 Native、支付宝开放平台）形态不同但语义一致：
 *  - 下单拿「用户侧付款信息」：微信给 weixin:// 二维码内容，支付宝给 qr.alipay.com 链接
 *    或页面支付跳转 URL；
 *  - 支付结果一律以**服务端异步通知**为准，浏览器回跳不发放权益；
 *  - 通知都带通道自己的签名，验签通过才可信。
 *
 * 这里只放类型与通道枚举，具体协议实现在各自的适配器里。
 */

/** 在线收款通道。 */
export type PayChannel = 'wechat_native' | 'alipay';

/** 通道在订单/流水表里的取值（与数据库 order_channel 枚举一致）。 */
export const PAY_CHANNELS = ['wechat_native', 'alipay'] as const;

/**
 * 需要**线上退款接口**的通道。
 *
 * 区别于「有没有适配器」：赞助码等线下收款通道本来就没有线上退款接口，
 * 但在线通道如果因为凭据被移除而拿不到适配器，钱是**还没退**的——
 * 两者不能混为一谈，否则会出现「用户付了钱、权益被撤销、通道那边一分没退」。
 */
export const ONLINE_REFUND_CHANNELS = new Set<string>(PAY_CHANNELS);

/** 验签通过后的通知内容（两通道统一形状）。 */
export interface VerifiedNotification {
  /** 商户单号（out_trade_no），用于定位站内订单。 */
  merchantOrderNo: string;
  /** 通道交易号（微信 transaction_id / 支付宝 trade_no）。 */
  transactionId: string;
  /** 是否为支付成功（微信 trade_state=SUCCESS；支付宝 trade_status=TRADE_SUCCESS|TRADE_FINISHED）。 */
  success: boolean;
  /** 通知唯一标识，用于回调幂等。 */
  notificationId: string;
  /** 通知里的订单金额（分）。通道没带金额时为 null，服务端会跳过金额校验。 */
  amountMinor: number | null;
}

/** 通道要求的成功应答体：微信要 JSON，支付宝要纯文本 success。 */
export interface NotifyAck {
  contentType: 'application/json' | 'text/plain';
  body: string;
}

/** 下单结果：payUrl 是能直接跳转的链接，qrContent 是需要渲染成二维码的内容。 */
export interface CreatedPayment {
  payUrl: string | null;
  qrContent: string | null;
}

export interface PayAdapter {
  readonly channel: PayChannel;
  /**
   * 下单。失败要抛错——上层会保留 pending 订单由关单任务兜底。
   * @param amountMinor 金额（分）。支付宝接口用「元」，适配器内部换算。
   */
  createOrder(input: {
    merchantOrderNo: string;
    amountMinor: number;
    description: string;
    notifyUrl: string;
  }): Promise<CreatedPayment>;
  /** 查单：关单前先查，避免「先支付后超时」的竞争。 */
  queryOrder(merchantOrderNo: string): Promise<{ status: 'success' | 'failed' | 'pending'; transactionId?: string }>;
  /** 关单：关闭未支付的订单。 */
  closeOrder(merchantOrderNo: string): Promise<void>;
  /** 退款。 */
  refund(input: { refundNo: string; merchantOrderNo: string; amountMinor: number; reason: string }): Promise<void>;
  /**
   * 回调验签。验签失败必须抛错（绝不处理伪造回调）。
   * @param rawBody 原始请求体字节（bootstrap 以 express.raw 挂载，未被 JSON/urlencoded 解析）
   */
  verifyNotification(input: {
    headers: Record<string, string | string[] | undefined>;
    rawBody: Buffer;
  }): VerifiedNotification;
  /** 成功应答体。 */
  notifyAck(): NotifyAck;
}
