/**
 * 公开 / 私人开关（docs/rebuild/18-HALL-PUBLIC-ROOMS.md）。
 * 等待室与房间内共用一个拨杆：外观一致，语义一致（都是「这局要不要进大厅」）。
 */
import { useLanguage } from '../state/language.js';

export function VisibilityToggle({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  const { copy } = useLanguage();
  return (
    <label className="visibility-toggle">
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="visibility-toggle-label">{copy.visibilityToggle}</span>
    </label>
  );
}
