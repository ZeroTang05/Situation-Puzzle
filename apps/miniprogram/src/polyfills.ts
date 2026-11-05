/**
 * 小程序环境 polyfill（垫片）：微信小程序运行时没有浏览器的 Fetch API 与部分
 * Web 全局，而 better-auth / better-fetch / react-query 的初始化和请求链路
 * 会裸引用它们（对象字面量求值 / instanceof / new），缺一个就在运行时抛
 * ReferenceError 或 TypeError。本文件在应用入口最先 import，统一补齐：
 *
 * - fetch：补真实现（taroFetch 本来就是 fetch 形状，走 Taro.request）；
 * - Request / Headers / Response：补空壳类。它们只出现在能力检测与
 *   instanceof 分支里，空壳让 instanceof 安全地走「鸭子类型」分支
 *   （判断对象长得像不像，而不是查它的类），实际行为由 taroFetch 保证；
 * - AbortController：react-query 观察器构造时 new 它做查询取消，补一个
 *   最小实现（signal 状态 + abort 监听）。
 *
 * 已有原生实现的环境（如开发者工具的 Chromium 内核）不覆盖。
 */
import { taroFetch } from './api/fetch-adapter'

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
if (!g.Headers) {
  g.Headers = class HeadersStub {
    constructor(_init?: unknown) {}
  }
}
if (!g.Response) {
  g.Response = class ResponseStub {
    constructor(_body?: unknown, _init?: unknown) {}
  }
}
if (!g.AbortController) g.AbortController = AbortControllerStub
