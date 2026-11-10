/** Query Core 的查询取消依赖 AbortController，原生小游戏使用成熟的标准接口补齐包。 */
import AbortController from 'abort-controller';
import 'core-js/actual/url/index.js';
if (typeof globalThis.AbortController === 'undefined') {
  Object.defineProperty(globalThis, 'AbortController', { value: AbortController, writable: true, configurable: true });
}
