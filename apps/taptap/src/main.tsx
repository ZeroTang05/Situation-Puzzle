/** TapTap 唯一启动入口。先初始化宿主适配，再挂载游戏组件。 */
import './polyfills.js';
import { render } from './ui/renderer.js';
import { App } from './app.js';
render(<App />);
