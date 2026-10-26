/**
 * fetch 适配器：把 better-auth 客户端要的 fetch 接口桥接到 Taro.request。
 * 小程序环境没有 fetch/Headers/Response 运行时，better-auth 的 vanilla 客户端
 * （better-auth/client，已验证不依赖 DOM）只要给它一个「形状像 fetch」的函数就能跑。
 * 类型签名直接用 @types/node 声明的全局 fetch（undici 同形）：better-auth 的
 * FetchEsque 检查要求参数能接受 Request/RequestInit，签名放宽后插件泛型推断才能通过。
 */
import Taro from '@tarojs/taro'
import { API_BASE, authorizationHeader, captureBearerToken, languageHeader } from './client'

/** 把 fetch 可能出现的 headers 形态统一摊平成普通对象（小程序里实际只会收到普通对象） */
function flattenHeaders(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object') return {}
  const bag = input as Record<string, unknown>
  // Headers 实例：走 entries 迭代器（运行时不会出现，纯类型兜底）
  if (typeof bag.entries === 'function') {
    return Object.fromEntries(bag.entries() as Iterable<[string, string]>)
  }
  if (Array.isArray(input)) return Object.fromEntries(input as Array<[string, string]>)
  return Object.fromEntries(Object.entries(bag).map(([key, value]) => [key, String(value)]))
}

/**
 * 桥接实现：统一附加 Bearer 令牌头与语言头，并在响应里捕获新令牌
 * （登录/刷新接口经 set-auth-token 头下发，见 client.ts 头注释）。
 * better-auth vanilla 客户端只会传字符串 URL 与字符串 body，
 * String(input) 对其余形态是防御收口。
 */
export const taroFetch: typeof fetch = async (input, init) => {
  const header: Record<string, string> = {
    ...flattenHeaders(init?.headers),
    ...authorizationHeader(),
    ...languageHeader(),
  }
  // 网络层失败（断网/域名未配）Taro 会 reject，与 fetch 抛异常的行为一致
  const res = await Taro.request({
    url: String(input),
    method: (init?.method ?? 'GET') as 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    // body 已是 JSON 字符串：原样发送，避免 Taro 再做对象序列化
    data: init?.body as string | undefined,
    header,
    // 关掉 Taro 的自动 JSON 解析，让 json()/text() 语义与 fetch 完全一致
    dataType: 'text',
    timeout: 30_000,
  })

  captureBearerToken(res.header)

  const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? '')
  const responseHeader: Record<string, string> = res.header ?? {}
  // 只实现 better-auth 客户端用到的成员（ok/status/headers.get/json/text），结构断言到 Response
  const wrapped = {
    ok: res.statusCode >= 200 && res.statusCode < 300,
    status: res.statusCode,
    headers: {
      get(name: string): string | null {
        return responseHeader[name] ?? responseHeader[name.toLowerCase()] ?? null
      },
    },
    json: async () => JSON.parse(text),
    text: async () => text,
  }
  return wrapped as unknown as Response
}

/** 供 auth-client 使用的基址常量再导出，页面（忘记密码的回跳链接等）直接引用 */
export { API_BASE }
