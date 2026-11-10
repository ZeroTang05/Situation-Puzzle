/** 纯几何检查：不创建 TapTap 模拟宿主；真机键盘事件与触控仍需手机验收。 */
import assert from 'node:assert/strict';
import { keyboardViewportHeight, revealScrollOffset } from '../src/ui/viewport.js';

const geometry = { windowHeight: 800, screenHeight: 844, screenTop: 44 };
assert.equal(keyboardViewportHeight(geometry, 0), 800, '键盘关闭时保留完整窗口');
assert.equal(keyboardViewportHeight(geometry, 300), 500, '覆盖式键盘扣除屏幕中的实际占用');
assert.equal(keyboardViewportHeight({ ...geometry, windowHeight: 500 }, 300), 500, '宿主已缩小窗口时不重复扣减');
assert.equal(keyboardViewportHeight({ ...geometry, windowHeight: 400 }, 300), 400, '已有窗口边界小于键盘边界时保持较小区域');
assert.equal(keyboardViewportHeight({ windowHeight: 760, screenHeight: 900, screenTop: 100 }, 320), 480, '屏幕坐标转换扣除窗口顶部位置');
assert.equal(keyboardViewportHeight(geometry, 900), 0, '键盘占满时可见高度不为负');
assert.throws(() => keyboardViewportHeight(geometry, Number.NaN), /有效数值/, '无效宿主数据直接报错');
assert.throws(() => keyboardViewportHeight(geometry, -1), /有效数值/, '负键盘高度直接报错');

const box = { offset: 100, maxOffset: 600, viewportTop: 0, viewportBottom: 500, targetTop: 50, targetBottom: 100 };
assert.equal(revealScrollOffset(box), 100, '输入已可见时保留滚动位置');
assert.equal(revealScrollOffset({ ...box, targetTop: 470, targetBottom: 550 }), 214, '输入被下缘遮挡时露出输入并保留按钮空间');
assert.equal(revealScrollOffset({ ...box, offset: 200, viewportTop: 50, viewportBottom: 350, targetTop: -20, targetBottom: 20 }), 118, '输入超过上缘时滚回可见区域');
assert.equal(revealScrollOffset({ ...box, targetTop: -100, targetBottom: 600 }), 264, '超长输入优先展示末尾');
assert.equal(revealScrollOffset({ ...box, offset: 590, targetTop: 700, targetBottom: 750 }), 600, '滚动不超过内容末尾');
assert.equal(revealScrollOffset({ ...box, offset: 10, targetTop: -100, targetBottom: -80 }), 0, '滚动不超过内容开头');
console.log('14 项纯几何检查通过；未验证 TapTap 真机键盘行为。');
