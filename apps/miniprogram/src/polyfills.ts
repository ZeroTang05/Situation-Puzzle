/**
 * 小程序环境 polyfill（垫片）：微信小程序运行时没有浏览器的部分 Web 全局，
 * 而依赖库的初始化 / 请求链路会裸引用它们，缺了就抛 ReferenceError 或 TypeError。
 * 本文件在应用入口最先 import，统一补齐：
 *
 * - AbortController：react-query 观察器构造时 new 它做查询取消，补一个最小实现
 *   （signal 状态 + abort 监听）。
 *
 * 会话请求本身不走这里——小程序端自写请求（api/auth-client.ts），不依赖会话客户端库，
 * 因此不再需要 fetch / Headers / Request / Response 这些 Fetch API 全局。
 *
 * 已有原生实现的环境（如开发者工具的 Chromium 内核）不覆盖。
 */

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

if (!g.AbortController) g.AbortController = AbortControllerStub
