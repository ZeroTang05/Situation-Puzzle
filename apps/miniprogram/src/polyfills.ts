/**
 * 小程序环境 polyfill（垫片）：微信小程序运行时没有浏览器的 Fetch API 与部分
 * Web 全局，而 better-auth / better-fetch / react-query 的初始化和请求链路
 * 会裸引用它们（对象字面量求值 / instanceof / new 后调方法），缺了就抛
 * ReferenceError 或 TypeError。本文件在应用入口最先 import，统一补齐：
 *
 * - fetch：补真实现（taroFetch 本来就是 fetch 形状，走 Taro.request）；
 * - Headers：补 MiniHeaders 真实现（better-fetch 会 new Headers(...) 后调
 *   has/get 判断 content-type，空壳不够用）；
 * - Request / Response：补空壳类（目前只被 instanceof/能力检测碰到）；
 * - AbortController：react-query 观察器构造时 new 它做查询取消，补一个
 *   最小实现（signal 状态 + abort 监听）。
 *
 * 已有原生实现的环境（如开发者工具的 Chromium 内核）不覆盖。
 */
import { taroFetch, MiniHeaders } from './api/fetch-adapter'

const g = globalThis as Record<string, unknown>

/** fetch 形状的最小 AbortSignal（react-query 只读状态和挂监听） */
class AbortSignalStub {
  aborted = false
  reason: unknown = undefined
  onabort: (() => void) | null = null
  addEventListener(_type: 'abort', _listener: () => void) {}
  removeEventListener(_type: 'abort', _listener: () => void) {}
  throwIfAborted() {}
}

class AbortControllerStub {
  signal = new AbortSignalStub()
  abort(reason?: unknown) {
    this.signal.aborted = true
    this.signal.reason = reason
    this.signal.onabort?.()
  }
}

if (!g.fetch) g.fetch = taroFetch
if (!g.Request) {
  g.Request = class RequestStub {
    constructor(_input: unknown, _init?: unknown) {}
  }
}
// Headers 用真实现（better-fetch 会 new Headers(...) 后调 has/get），
// 与 taroFetch 响应头同一套行为
if (!g.Headers) g.Headers = MiniHeaders
if (!g.Response) {
  g.Response = class ResponseStub {
    constructor(_body?: unknown, _init?: unknown) {}
  }
}
if (!g.AbortController) g.AbortController = AbortControllerStub
