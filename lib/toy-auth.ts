/**
 * B 站 Toy 宿主环境探测与访客资料获取。
 * 玩具页面被 www.bilibili.com/toy/<slug>/ 装载时，平台会注入 __TOY_META__ 与 toy-host.js，
 * 页面通过 window.toyHost.useNative('toy.getUserProfile') 拿到访客在本玩具下的稳定身份 toyOpenId；
 * 未登录访客在进入页面前就被平台登录门拦截，首次取资料会弹平台授权确认框。
 */

/** Toy 平台分配的访客身份；face/uname 仅用于展示，鉴权只依赖 toyOpenId。 */
export interface ToyUserProfile {
  face: string;
  uname: string;
  toyOpenId: string;
}

interface ToyHostBridge {
  useNative: (method: string, data?: Record<string, unknown>) => Promise<ToyBridgeResponse>;
}

/** 桥接层用 avatar/nickname，宿主 RPC 层用 face/uname，两套拼写指向同一批字段。 */
interface ToyBridgeResponse {
  code?: number;
  message?: string;
  data?: { avatar?: string; nickname?: string; face?: string; uname?: string; toyOpenId?: string };
}

/** 平台只在自己装载的页面注入这两个全局对象，其他部署环境（Vercel、本地开发）不存在。 */
export function toyHostBridge(): ToyHostBridge | null {
  if (typeof window === 'undefined') return null;
  const globals = window as typeof window & { __TOY_META__?: unknown; toyHost?: ToyHostBridge };
  return globals.__TOY_META__ !== undefined && typeof globals.toyHost?.useNative === 'function' ? globals.toyHost : null;
}

/** 是否运行在 Toy 宿主里；供页面决定走平台身份还是浏览器本机记录。 */
export function isInToyHost(): boolean {
  return toyHostBridge() !== null;
}

/** 取访客资料；授权被拒或桥接异常都会抛错，由调用方决定降级方式。 */
export async function fetchToyUserProfile(): Promise<ToyUserProfile> {
  const bridge = toyHostBridge();
  if (!bridge) throw new Error('不在 Toy 宿主环境');
  const response = await bridge.useNative('toy.getUserProfile', {});
  if (response.code !== 0 || !response.data?.toyOpenId) {
    throw new Error(response.message || `getUserProfile 失败：code=${response.code ?? '无'}`);
  }
  return {
    face: response.data.avatar ?? response.data.face ?? '',
    uname: response.data.nickname ?? response.data.uname ?? '',
    toyOpenId: response.data.toyOpenId,
  };
}
