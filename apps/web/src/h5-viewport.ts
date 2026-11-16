/** TapTap H5 按可见视口布局；输入法缩小屏幕时，聊天页只压缩内部弹性区域。 */
export function initializeH5Viewport(): void {
  const viewport = window.visualViewport;
  if (!viewport) throw new Error('TapTap H5 需要浏览器支持 VisualViewport');

  const update = () => {
    const style = document.documentElement.style;
    style.setProperty('--taptap-viewport-height', `${viewport.height}px`);
    // 浏览器为输入框平移可见区域时，固定页面跟随可见区域顶部。
    style.setProperty('--taptap-viewport-top', `${viewport.offsetTop}px`);
  };

  update();
  viewport.addEventListener('resize', update);
  viewport.addEventListener('scroll', update);
}
