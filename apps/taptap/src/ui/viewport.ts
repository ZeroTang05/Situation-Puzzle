/** 画布可见区域与焦点滚动的纯几何计算；宿主事件和实际绘制留在 renderer。 */

/** 键盘顶部使用屏幕坐标换算，窗口已被宿主缩小时不会再次减去整段键盘高度。 */
export function keyboardViewportHeight(info: { windowHeight: number; screenHeight: number; screenTop: number }, keyboardHeight: number): number {
  if (![info.windowHeight, info.screenHeight, info.screenTop, keyboardHeight].every(Number.isFinite) || keyboardHeight < 0) {
    throw new Error('TapTap 窗口尺寸与键盘高度必须是有效数值');
  }
  return Math.max(0, Math.min(info.windowHeight, info.screenHeight - info.screenTop - keyboardHeight));
}

/** 输入内容超高时露出末尾；下方保留一个常用操作按钮的位置，滚动不越过实际边界。 */
export function revealScrollOffset(input: {
  offset: number; maxOffset: number; viewportTop: number; viewportBottom: number; targetTop: number; targetBottom: number;
}): number {
  const top = input.viewportTop + 12;
  const bottom = Math.max(top, input.viewportBottom - 64);
  const delta = input.targetBottom > bottom || input.targetBottom - input.targetTop > bottom - top
    ? input.targetBottom - bottom : input.targetTop < top ? input.targetTop - top : 0;
  return Math.max(0, Math.min(input.maxOffset, input.offset + delta));
}
