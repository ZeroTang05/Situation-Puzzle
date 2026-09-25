/** Better Auth 实例类型：从包的推导类型中提取，避免依赖内部导出路径。 */
import type { createAuth } from './auth.instance.js';

export type BetterAuthInstance = ReturnType<typeof createAuth>;
export { createAuth } from './auth.instance.js';
