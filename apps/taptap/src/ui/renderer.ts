/**
 * React → 原生 Canvas 的宿主适配。React 管组件与更新，css-layout 管排版，
 * 本文件只负责绘制、点击命中、滚动及系统键盘，不包含业务规则。
 */
import Reconciler from 'react-reconciler';
import { ConcurrentRoot, DefaultEventPriority, NoEventPriority } from 'react-reconciler/constants';
import { createContext, type ReactNode } from 'react';
import computeLayout, { type LayoutNode } from 'css-layout';
import { keyboardViewportHeight, revealScrollOffset } from './viewport.js';

export interface Style {
  width?: number; height?: number; minHeight?: number; maxHeight?: number; flex?: number;
  flexDirection?: 'row' | 'column'; flexWrap?: 'wrap' | 'nowrap';
  alignItems?: 'stretch' | 'flex-start' | 'center' | 'flex-end';
  justifyContent?: 'flex-start' | 'center' | 'space-between' | 'space-around' | 'flex-end';
  padding?: number; paddingTop?: number; paddingBottom?: number; paddingLeft?: number; paddingRight?: number;
  margin?: number; marginTop?: number; marginBottom?: number; marginLeft?: number; marginRight?: number;
  backgroundColor?: string; color?: string; fontSize?: number; fontWeight?: 'bold' | 'normal';
  lineHeight?: number; borderRadius?: number; borderWidth?: number; borderColor?: string; textAlign?: 'left' | 'center';
}
export interface Props {
  children?: ReactNode; style?: Style; text?: string; value?: string; placeholder?: string;
  maxLength?: number; multiline?: boolean; password?: boolean; disabled?: boolean;
  onPress?: () => void; onChange?: (value: string) => void; onSubmit?: (value: string) => void;
  autoBottom?: boolean; scrollKey?: string;
}
type Kind = 'view' | 'text' | 'button' | 'input' | 'scroll';
interface SceneNode {
  kind: Kind; props: Props; children: SceneNode[]; parent: SceneNode | null;
  hidden: boolean; scroll: number; scrollHeight: number; previousHeight: number; layout: LayoutNode | null;
}
interface Hit { node: SceneNode; x: number; y: number; w: number; h: number; scrolls: SceneNode[]; }
const root: SceneNode = makeNode('view', {});
const canvas = tap.createCanvas();
const context = canvas.getContext('2d');
if (!context) throw new Error('TapTap Canvas 2D 初始化失败');
const ctx = context;
let width = 0; let height = 0; let hits: Hit[] = []; let queued = false;
let focus: SceneNode | null = null;
let keyboardHeight = 0; let revealFocus = false;
let touch: { x: number; y: number; scroll: number; target: Hit | undefined; scrolling: SceneNode | undefined; moved: boolean } | null = null;
let updatePriority: number = NoEventPriority;
export const palette = { bg: '#0a1522', panel: '#122638', line: '#294254', text: '#e5edf4', muted: '#a1b4c4', accent: '#7dd8c6', danger: '#ffabb3' };

function makeNode(kind: Kind, props: Props): SceneNode { return { kind, props, children: [], parent: null, hidden: false, scroll: 0, scrollHeight: 0, previousHeight: 0, layout: null }; }
function remove(parent: SceneNode, child: SceneNode): void {
  // 移除整个表单或页面时，焦点可能位于其后代输入框，须先结束原键盘输入。
  for (let node = focus; node; node = node.parent) {
    if (node === child) { focus = null; tap.hideKeyboard(); break; }
  }
  const i = parent.children.indexOf(child); if (i >= 0) parent.children.splice(i, 1); child.parent = null;
}
function insert(parent: SceneNode, child: SceneNode, before?: SceneNode): void {
  if (child.parent) remove(child.parent, child);
  const index = before ? parent.children.indexOf(before) : parent.children.length;
  parent.children.splice(index, 0, child); child.parent = parent;
}

/** 一次提交只安排一次重绘，静止页面不运行动画循环。 */
function invalidate(): void {
  if (queued) return; queued = true;
  setTimeout(() => { queued = false; draw(); }, 0);
}
function content(node: SceneNode): string {
  if (node.kind === 'input') return node.props.password && node.props.value ? '●'.repeat(node.props.value.length) : node.props.value || node.props.placeholder || '';
  return node.props.text ?? '';
}
function font(style: Style): void { ctx.font = `${style.fontWeight === 'bold' ? 'bold ' : ''}${style.fontSize ?? 16}px sans-serif`; }

/** 按宿主实际字宽折行，汤面、问答和输入框使用同一套测量。 */
function lines(value: string, maxWidth: number, style: Style): string[] {
  font(style); const result: string[] = []; let line = '';
  for (const char of value) {
    if (char === '\n' || (line.length > 0 && ctx.measureText(line + char).width > maxWidth)) {
      result.push(line); line = char === '\n' ? '' : char;
    } else line += char;
  }
  result.push(line); return result;
}

/** 每次生成排版树，避免布局库的缓存持有过期文字尺寸。滚动正文单独计算自然高度。 */
function layout(node: SceneNode, bound: number): LayoutNode {
  const style = node.props.style ?? {};
  const measure = (available: number) => {
    const w = Number.isFinite(available) ? Math.max(1, available) : bound;
    const textLines = lines(content(node), w, style);
    return { width: Math.min(w, Math.max(0, ...textLines.map((line) => ctx.measureText(line).width))), height: textLines.length * (style.lineHeight ?? Math.round((style.fontSize ?? 16) * 1.6)) };
  };
  const tree: LayoutNode = { style: { ...style, ...(node.kind === 'text' || node.kind === 'button' || node.kind === 'input' ? { measure } : {}) }, children: [] };
  if (node.hidden) tree.style = { width: 0, height: 0 };
  else if (node.kind !== 'scroll') tree.children = node.children.map((child) => layout(child, bound));
  node.layout = tree; return tree;
}

function rounded(x: number, y: number, w: number, h: number, r: number): void {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
}

/** 裁剪绘制区域与点击区域，屏幕外的按钮不会响应触摸。 */
function paint(node: SceneNode, left: number, top: number, clip: { x: number; y: number; w: number; h: number }, scrolls: SceneNode[]): void {
  if (node.hidden || !node.layout?.layout) return;
  const box = node.layout.layout; const x = left + box.left; const y = top + box.top;
  const w = box.width; const h = box.height; const style = node.props.style ?? {};
  const x1 = Math.max(x, clip.x); const y1 = Math.max(y, clip.y); const x2 = Math.min(x + w, clip.x + clip.w); const y2 = Math.min(y + h, clip.y + clip.h);
  if (x2 <= x1 || y2 <= y1) return;
  ctx.save(); ctx.beginPath(); ctx.rect(x1, y1, x2 - x1, y2 - y1); ctx.clip();
  ctx.globalAlpha = node.props.disabled ? 0.45 : 1;
  if (style.backgroundColor || style.borderColor) {
    rounded(x, y, w, h, style.borderRadius ?? 0);
    if (style.backgroundColor) { ctx.fillStyle = style.backgroundColor; ctx.fill(); }
    if (style.borderColor) { ctx.strokeStyle = style.borderColor; ctx.lineWidth = style.borderWidth ?? 1; ctx.stroke(); }
  }
  if (node.kind === 'text' || node.kind === 'button' || node.kind === 'input') {
    const px = style.paddingLeft ?? style.padding ?? 0; const py = style.paddingTop ?? style.padding ?? 0;
    const value = content(node); const textLines = lines(value, Math.max(1, w - px - (style.paddingRight ?? style.padding ?? 0)), style);
    const lh = style.lineHeight ?? Math.round((style.fontSize ?? 16) * 1.6);
    ctx.fillStyle = node.kind === 'input' && !node.props.value ? palette.muted : style.color ?? palette.text;
    ctx.textBaseline = 'top'; font(style);
    textLines.forEach((line, i) => ctx.fillText(line, style.textAlign === 'center' ? x + (w - ctx.measureText(line).width) / 2 : x + px, y + py + i * lh));
  }
  if ((node.props.onPress || node.kind === 'input' || node.kind === 'scroll') && !node.props.disabled) hits.push({ node, x: x1, y: y1, w: x2 - x1, h: y2 - y1, scrolls });
  if (node.kind === 'scroll') {
    const body: LayoutNode = { style: { width: w }, children: node.children.map((child) => layout(child, w)) };
    computeLayout(body); node.scrollHeight = body.layout!.height;
    const limit = Math.max(0, node.scrollHeight - h);
    const wasBottom = node.scroll >= Math.max(0, node.previousHeight - h) - 24;
    if (node.props.autoBottom && wasBottom && node.scrollHeight !== node.previousHeight) node.scroll = limit;
    node.previousHeight = node.scrollHeight; node.scroll = Math.max(0, Math.min(node.scroll, limit));
    for (const child of node.children) paint(child, x, y - node.scroll, { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }, [...scrolls, node]);
  } else for (const child of node.children) paint(child, x, y, clip, scrolls);
  ctx.restore();
}

/** 从布局树换算当前屏幕位置，逐层扣除滚动容器的位移。 */
function verticalBounds(node: SceneNode): { top: number; height: number } {
  const box = node.layout?.layout;
  if (!box) throw new Error('读取焦点位置前必须完成画布布局');
  let top = 0;
  for (let current: SceneNode | null = node; current; current = current.parent) {
    if (!current.layout?.layout) throw new Error('焦点所在页面缺少布局信息');
    top += current.layout.layout.top;
    if (current.parent?.kind === 'scroll') top -= current.parent.scroll;
  }
  return { top, height: box.height };
}

/** 键盘、窗口或输入内容变化后展示焦点；普通手指滚动时保留用户选择的位置。 */
function revealFocusedInput(visibleHeight: number): boolean {
  if (!focus || focus.props.disabled) return false;
  let changed = false;
  for (let parent = focus.parent; parent; parent = parent.parent) {
    if (parent.kind !== 'scroll') continue;
    const viewport = verticalBounds(parent); const field = verticalBounds(focus);
    const viewportTop = Math.max(0, viewport.top); const viewportBottom = Math.min(visibleHeight, viewport.top + viewport.height);
    if (viewportBottom <= viewportTop) continue;
    const next = revealScrollOffset({ offset: parent.scroll, maxOffset: Math.max(0, parent.scrollHeight - viewport.height),
      viewportTop, viewportBottom, targetTop: field.top, targetBottom: field.top + field.height,
    });
    if (next !== parent.scroll) { parent.scroll = next; changed = true; }
  }
  return changed;
}

function draw(): void {
  if (!width || !height) return;
  ctx.fillStyle = palette.bg; ctx.fillRect(0, 0, width, height); hits = [];
  const info = tap.getWindowInfo();
  const visibleHeight = keyboardViewportHeight(info, keyboardHeight);
  root.props = { style: { width, height: visibleHeight, paddingTop: Math.max(info.safeArea?.top ?? 0, tap.getMenuButtonBoundingClientRect().bottom) + 8, paddingBottom: Math.max(0, visibleHeight - (info.safeArea?.bottom ?? visibleHeight)) } };
  const tree = layout(root, width); computeLayout(tree);
  paint(root, 0, 0, { x: 0, y: 0, w: width, h: visibleHeight }, []);
  if (revealFocus) {
    revealFocus = false;
    if (revealFocusedInput(visibleHeight)) {
      ctx.fillStyle = palette.bg; ctx.fillRect(0, 0, width, height); hits = [];
      paint(root, 0, 0, { x: 0, y: 0, w: width, h: visibleHeight }, []);
    }
  }
}
function resize(): void {
  const info = tap.getWindowInfo(); width = info.windowWidth; height = info.windowHeight;
  canvas.width = Math.round(width * info.pixelRatio); canvas.height = Math.round(height * info.pixelRatio);
  ctx.setTransform(info.pixelRatio, 0, 0, info.pixelRatio, 0, 0); revealFocus = Boolean(focus); invalidate();
}

/** 事件只命中最上层可点击节点；垂直滑动交给该节点最近的滚动容器。 */
tap.onTouchStart(({ touches }) => {
  const point = touches[0]; if (!point) return;
  const target = [...hits].reverse().find((hit) => point.clientX >= hit.x && point.clientX <= hit.x + hit.w && point.clientY >= hit.y && point.clientY <= hit.y + hit.h);
  const scrolling = target?.node.kind === 'scroll' ? target.node : target?.scrolls[target.scrolls.length - 1];
  touch = { x: point.clientX, y: point.clientY, target, scrolling, scroll: scrolling?.scroll ?? 0, moved: false };
});
tap.onTouchMove(({ touches }) => {
  const point = touches[0]; if (!point || !touch) return;
  if (Math.hypot(point.clientX - touch.x, point.clientY - touch.y) > 7) touch.moved = true;
  if (touch.moved && touch.scrolling) { touch.scrolling.scroll = touch.scroll + touch.y - point.clientY; invalidate(); }
});
tap.onTouchEnd(({ changedTouches }) => {
  const point = changedTouches[0]; const began = touch; touch = null;
  if (!point || !began || began.moved || !began.target) return;
  const hit = began.target; if (point.clientX < hit.x || point.clientX > hit.x + hit.w || point.clientY < hit.y || point.clientY > hit.y + hit.h) return;
  const node = hit.node;
  if (node.kind === 'input') {
    focus = node; revealFocus = true; invalidate();
    tap.showKeyboard({ defaultValue: node.props.value ?? '', maxLength: node.props.maxLength ?? 1000, multiple: node.props.multiline ?? false,
      confirmHold: false, confirmType: 'send', fail(error) { console.error('[taptap:keyboard]', error.errMsg); throw new Error('无法打开输入键盘'); } });
  } else node.props.onPress?.();
});
tap.onTouchCancel(() => { touch = null; });
tap.onKeyboardInput(({ value }) => { if (focus && !focus.props.disabled) focus.props.onChange?.(value); });
tap.onKeyboardHeightChange(({ height: next }) => { keyboardHeight = next; revealFocus = Boolean(focus); invalidate(); });
tap.onKeyboardComplete(({ value }) => { focus?.props.onChange?.(value); focus = null; });
tap.onKeyboardConfirm(({ value }) => {
  const target = focus; focus = null; tap.hideKeyboard();
  target?.props.onChange?.(value); target?.props.onSubmit?.(value);
});
tap.onWindowResize(resize); resize();

/** HostConfig（宿主配置）仅实现可变画布树；表单、服务端水合和资源挂载均不启用。 */
const reconciler = Reconciler<Kind, Props, SceneNode, SceneNode, SceneNode, never, never, never, never, SceneNode, object, never, ReturnType<typeof setTimeout>, -1, null, null, null, never, never, never>({
  rendererVersion: '0.1.0', rendererPackageName: '@jev/taptap', extraDevToolsConfig: null,
  bindToConsole: (_method, args) => () => console.log(...args),
  supportsMutation: true, supportsPersistence: false, supportsHydration: false, isPrimaryRenderer: true,
  getRootHostContext: () => ({}), getChildHostContext: (context) => context, getPublicInstance: (node) => node,
  createInstance: (kind, props) => makeNode(kind, props), createTextInstance: (text) => makeNode('text', { text }),
  appendInitialChild: insert, appendChild: insert, appendChildToContainer: insert,
  insertBefore: insert, insertInContainerBefore: insert, removeChild: remove, removeChildFromContainer: remove,
  shouldSetTextContent: () => false, finalizeInitialChildren: () => false,
  prepareForCommit: () => null, resetAfterCommit: invalidate, preparePortalMount: () => {},
  commitUpdate: (node, _kind, oldProps, props) => {
    node.props = props;
    if (focus === node && oldProps.value !== props.value) revealFocus = true;
    if (focus === node && props.disabled) { focus = null; tap.hideKeyboard(); }
    if (oldProps.scrollKey !== props.scrollKey) node.scroll = 0;
  },
  commitTextUpdate: (node, _old, text) => { node.props = { text }; },
  resetTextContent: (node) => { node.children = []; }, clearContainer: (node) => { node.children = []; },
  hideInstance: (node) => { node.hidden = true; }, hideTextInstance: (node) => { node.hidden = true; },
  unhideInstance: (node) => { node.hidden = false; }, unhideTextInstance: (node) => { node.hidden = false; },
  scheduleTimeout: setTimeout, cancelTimeout: clearTimeout, noTimeout: -1,
  supportsMicrotasks: true, scheduleMicrotask: (fn) => { void Promise.resolve().then(fn); },
  getInstanceFromNode: () => null, beforeActiveInstanceBlur: () => {}, afterActiveInstanceBlur: () => {},
  prepareScopeUpdate: () => {}, getInstanceFromScope: () => null, detachDeletedInstance: () => {},
  NotPendingTransition: null, HostTransitionContext: createContext(null) as unknown as Reconciler.ReactContext<null>,
  setCurrentUpdatePriority: (priority) => { updatePriority = priority; },
  getCurrentUpdatePriority: () => updatePriority, resolveUpdatePriority: () => updatePriority || DefaultEventPriority,
  resetFormInstance: () => {}, requestPostPaintCallback: (callback) => { setTimeout(() => callback(Date.now()), 0); },
  shouldAttemptEagerTransition: () => false, trackSchedulerEvent: () => {}, resolveEventType: () => null, resolveEventTimeStamp: Date.now,
  maySuspendCommit: () => false, maySuspendCommitOnUpdate: () => false, maySuspendCommitInSyncRender: () => false,
  preloadInstance: () => true, startSuspendingCommit: () => null, suspendInstance: () => {},
  suspendOnActiveViewTransition: () => {}, waitForCommitToBeReady: () => null, getSuspendedCommitReason: () => null,
});
const report = (error: Error) => { console.error('[taptap:react]', error); throw error; };
const container = reconciler.createContainer(root, ConcurrentRoot, null, false, null, '', report, report, report, () => {}, null);
export function render(element: ReactNode): void { reconciler.updateContainer(element, container, null, () => {}); }
