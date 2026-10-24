package cn.xiaobaozi.sp;

import android.os.Bundle;
import androidx.activity.EdgeToEdge;
import androidx.core.splashscreen.SplashScreen;
import com.getcapacitor.BridgeActivity;

/**
 * 壳入口。启动屏 + 边到边两件事在这里接线：
 * - core-splashscreen 契约要求 installSplashScreen 在 super.onCreate 前调用，
 *   主题 Theme.SplashScreen 显示品牌底色 + 居中图标，结束后切回 AppTheme.NoActionBar
 * - 边到边（Android 15+ 强制）：配合 capacitor.config 的
 *   SystemBars.insetsHandling=css 给 WebView 注入安全区变量，
 *   由 web 端 CSS 自己留出状态栏/手势条空间
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        SplashScreen.Companion.installSplashScreen(this);
        EdgeToEdge.enable(this);
        super.onCreate(savedInstanceState);
    }
}
