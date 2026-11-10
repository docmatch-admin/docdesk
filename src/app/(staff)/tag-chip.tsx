import { tagLabel } from "@/lib/sensitive-rules";
import { DEFAULT_TAG_COLOR } from "@/lib/tags";
import { tagChipStyle } from "@/lib/tag-colors";

/** โหมดสว่าง: สีอยู่ที่จุดและขอบ ตัวอักษรสีปกติ · โหมดมืด: พื้นเข้ม/ตัวอักษรสว่างคำนวณจากสีแท็ก (อ่านได้ทุกสี) · ai = AI ติดให้ */
export function TagChip({ name, color, onRemove, ai }: { name: string; color?: string; onRemove?: () => void; ai?: boolean }) {
  const c = color ?? DEFAULT_TAG_COLOR;
  return (
    <span className="tag-chip" style={tagChipStyle(c) as React.CSSProperties}>
      <i />
      {tagLabel(name)}
      {ai && <span className="tag-ai" title="AI ติดแท็กนี้ให้">· AI</span>}
      {onRemove && (
        <button type="button" className="tag-x" aria-label={`เอาแท็ก ${name} ออก`} title={`เอาแท็ก ${name} ออก`} onClick={onRemove}>×</button>
      )}
    </span>
  );
}
