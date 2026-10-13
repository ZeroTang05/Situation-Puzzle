/** 单人、多人和创作试题共用的大模型还原开关。 */
import { useLanguage } from '../state/language.js';

export function LargeModelToggle({ checked, disabled, onChange }: { checked: boolean; disabled: boolean; onChange: (value: boolean) => void }) {
  const { copy } = useLanguage();
  return <label className="large-model-toggle"><input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />{copy.largeModel}</label>;
}
