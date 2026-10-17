import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Android 壳配置（docs/rebuild/13-APP-VERSION.md）
 * - appId：Google Play 包名，上架后不可改（2026-10-17 拍板 cn.xiaobaozi.sp）
 * - appName：桌面图标下显示的名字
 * - webDir：玩家端构建产物目录；`cap sync` 时整包拷进安卓工程
 */
const config: CapacitorConfig = {
  appId: 'cn.xiaobaozi.sp',
  appName: 'Jev 海龟汤',
  webDir: '../web/dist',
};

export default config;
