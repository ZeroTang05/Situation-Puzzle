/** css-layout 的纯 JavaScript Flexbox 接口，无 DOM 依赖。 */
declare module 'css-layout' {
  export interface LayoutNode {
    style: Record<string, unknown>;
    children: LayoutNode[];
    layout?: { left: number; top: number; width: number; height: number };
  }
  export default function computeLayout(node: LayoutNode): void;
}
