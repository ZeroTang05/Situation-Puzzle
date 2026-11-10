/** 可复用画布控件：触控目标至少 44px，文字与间距沿用网页的深海色系。 */
import { Children, createElement, type ReactNode } from 'react';
import { palette, type Props, type Style } from './renderer.js';

export function View(props: Props) { return createElement('view', props); }
/** JSX 的相邻文字会形成数组；按顺序拼接，避免 String(array) 插入逗号。 */
function plainText(children: ReactNode): string {
  return Children.toArray(children).map((child) => {
    if (typeof child !== 'string' && typeof child !== 'number' && typeof child !== 'bigint') throw new Error('画布文字控件只能包含文字或数字');
    return String(child);
  }).join('');
}
export function Text({ children, muted = false, size = 16, style }: { children: ReactNode; muted?: boolean; size?: number; style?: Style }) {
  return createElement('text', { text: plainText(children), style: { color: muted ? palette.muted : palette.text, fontSize: size, marginBottom: 8, ...style } });
}
export function Button({ children, onPress, disabled = false, primary = false, danger = false }: { children: ReactNode; onPress(): void; disabled?: boolean; primary?: boolean; danger?: boolean }) {
  return createElement('button', { text: plainText(children), onPress, disabled,
    style: { padding: 11, minHeight: 46, marginBottom: 8, borderRadius: 10, backgroundColor: primary ? palette.accent : palette.line,
      color: primary ? palette.bg : danger ? palette.danger : palette.text, textAlign: 'center' } });
}
export function Input({ label, ...props }: Props & { label: string }) {
  return <View><Text muted size={14}>{label}</Text>{createElement('input', { ...props,
    style: { padding: 12, minHeight: props.multiline ? 82 : 48, marginBottom: 14, borderRadius: 10, backgroundColor: palette.panel, borderColor: palette.line, ...props.style } })}</View>;
}
export function Card({ children }: { children: ReactNode }) { return <View style={{ padding: 16, marginBottom: 12, borderRadius: 12, backgroundColor: palette.panel }}>{children}</View>; }
export function Row({ children }: { children: ReactNode }) { return <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>{children}</View>; }
export function Choice<T extends string>({ value, options, onChange, disabled = false }: { value: T; options: readonly (readonly [NoInfer<T>, string])[]; onChange(value: T): void; disabled?: boolean }) {
  return <Row>{options.map(([key, label]) => <View key={key} style={{ marginRight: 8 }}><Button disabled={disabled} onPress={() => onChange(key)} primary={key === value}>{label}</Button></View>)}</Row>;
}
export function Scroll(props: Props) { return createElement('scroll', { ...props, style: { flex: 1, ...props.style } }); }
