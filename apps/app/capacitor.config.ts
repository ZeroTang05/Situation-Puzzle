import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Android 壳配置（docs/rebuild/13-APP-VERSION.md）
 * - appId：Google Play 包名，上架后不可改（2026-10-17 拍板 cn.xiaobaozi.sp）
 * - appName：桌面图标下显示的名字
 * - webDir：玩家端构建产物目录；`cap sync` 时整包拷进安卓工程
 * - SystemBars：边到边模式下给 WebView 注入 --safe-area-inset-* 变量
 *   （旧版 WebView 的 env() 取值不可靠，css 模式两代都能用）；深海配色用浅色图标
 * - Keyboard：原生整体缩放（Android 15 边到边下由插件按 IME insets 调整 WebView）
 */
const config: CapacitorConfig = {
  appId: 'cn.xiaobaozi.sp',
  appName: 'Jev 海龟汤',
  webDir: '../web/dist',
  plugins: {
    SystemBars: {
      insetsHandling: 'css',
      style: 'DARK',
    },
    Keyboard: {
      resize: 'native',
    },
  },
};

export default config;
