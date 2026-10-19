package cn.xiaobaozi.sp;

import android.os.Bundle;
import androidx.activity.EdgeToEdge;
import com.getcapacitor.BridgeActivity;

/**
 * 壳入口。边到边（Android 15+ 强制）：配合 capacitor.config 的
 * SystemBars.insetsHandling=css 给 WebView 注入安全区变量，
 * 由 web 端 CSS 自己留出状态栏/手势条空间。
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        EdgeToEdge.enable(this);
        super.onCreate(savedInstanceState);
    }
}
