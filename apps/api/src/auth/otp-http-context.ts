/** Express 按可信代理链取 IP，再建立不可由客户端伪造的请求上下文。 */
import type { RequestHandler } from 'express';
import ipaddr from 'ipaddr.js';
import { otpRequestContext } from './otp-request-context.js';

export function otpHttpContext(trustProxy: (ip: string, index: number) => boolean): RequestHandler {
  return (request, response, next) => {
    const peer = request.socket.remoteAddress;
    if (!peer || !request.ip || (trustProxy(peer, 0) && (!request.headers['x-forwarded-for'] || trustProxy(request.ip, 1)))) {
      response.status(503).json({ code: 'CLIENT_IP_UNAVAILABLE', message: '无法取得客户端地址，请联系管理员检查代理配置。' });
      return;
    }
    let ip: string;
    try { ip = ipaddr.process(request.ip).toString(); }
    catch { response.status(400).json({ code: 'INVALID_CLIENT_IP', message: '客户端地址格式无效。' }); return; }
    // 覆盖同名请求头，认证库的其它限流也使用这份已验证的 IP。
    request.headers['x-jev-client-ip'] = ip;
    otpRequestContext.run({ ip, delivery: 'not_started' }, next);
  };
}
