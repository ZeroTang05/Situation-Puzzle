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
export function Button({ children, onPress, disabled = false, primary = false, danger = false, style }: { children: ReactNode; onPress(): void; disabled?: boolean; primary?: boolean; danger?: boolean; style?: Style }) {
  return createElement('button', { text: plainText(children), onPress, disabled,
    style: { padding: 11, minHeight: 46, marginBottom: 8, borderRadius: 10, borderWidth: 1,
      borderColor: primary ? palette.accent : danger ? '#6b3948' : palette.line,
      backgroundColor: primary ? palette.accent : danger ? '#2b1c2b' : palette.button,
      color: primary ? palette.bg : danger ? palette.danger : palette.text, textAlign: 'center', ...style } });
}
export function Input({ label, ...props }: Props & { label: string }) {
  return <View><Text muted size={14}>{label}</Text>{createElement('input', { ...props,
    style: { padding: 12, minHeight: props.multiline ? 82 : 48, marginBottom: 14, borderRadius: 10, backgroundColor: palette.panel, borderColor: palette.line, ...props.style } })}</View>;
}
export function Card({ children, style }: { children: ReactNode; style?: Style }) { return <View style={{ padding: 16, marginBottom: 12, borderRadius: 12, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.panel, ...style }}>{children}</View>; }
export function Row({ children, style }: { children: ReactNode; style?: Style }) { return <View style={{ flexDirection: 'row', flexWrap: 'wrap', ...style }}>{children}</View>; }
export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return <Row style={{ alignItems: 'center', justifyContent: 'space-between', marginTop: 18, marginBottom: 10 }}><Text muted size={13} style={{ fontWeight: 'bold' }}>{children}</Text>{action}</Row>;
}
export function Badge({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'accent' | 'danger' }) {
  const color = tone === 'accent' ? palette.accent : tone === 'danger' ? palette.danger : palette.muted;
  return <Text size={12} style={{ color, padding: 4, paddingLeft: 8, paddingRight: 8, borderRadius: 5, borderWidth: 1, borderColor: tone === 'accent' ? '#3f776e' : tone === 'danger' ? '#6b3948' : palette.line, backgroundColor: tone === 'accent' ? '#163c3a' : tone === 'danger' ? '#2b1c2b' : '#172c3b' }}>{children}</Text>;
}
export function Choice<T extends string>({ value, options, onChange, disabled = false }: { value: T; options: readonly (readonly [NoInfer<T>, string])[]; onChange(value: T): void; disabled?: boolean }) {
  return <View style={{ padding: 4, marginBottom: 10, borderRadius: 9, borderWidth: 1, borderColor: palette.line, backgroundColor: '#0e1e2d' }}><Row>{options.map(([key, label]) => <View key={key} style={{ flex: 1, minWidth: 74, marginRight: 4 }}><Button disabled={disabled} onPress={() => onChange(key)} primary={key === value} style={{ minHeight: 38, marginBottom: 0, padding: 8, borderRadius: 7 }}>{label}</Button></View>)}</Row></View>;
}
export function Scroll(props: Props) { return createElement('scroll', { ...props, style: { flex: 1, ...props.style } }); }
