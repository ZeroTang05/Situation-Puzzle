/** 单元测试与真实浏览器端到端测试分别运行。 */
import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { include: ['test/**/*.test.{ts,tsx}'] } });
